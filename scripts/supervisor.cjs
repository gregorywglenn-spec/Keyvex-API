/**
 * BACKFILL SUPERVISOR — self-healing, parallel, queue-driven.
 *
 *   node scripts/supervisor.cjs
 *
 * Reads scripts/backfill-queue.json, runs each pending job as a child process
 * (npx tsx <script>), and AUTO-RESTARTS any job that exits non-zero — but only
 * after confirming the network is actually back (so a blip can't kill a run and
 * can't burn restarts while the connection is down). Jobs in different "families"
 * (source APIs) run in PARALLEL; jobs in the same family run one at a time so we
 * never split a rate budget. Each job resumes from its own checkpoint, so a
 * restart loses no work and never duplicates (idempotent writes).
 *
 * Add a job during the day by appending to backfill-queue.json — the supervisor
 * polls the file and picks it up. Set {"stop": true} in the file to end cleanly.
 *
 * Status: this script's events → scripts/.supervisor.log
 *         each job's output    → scripts/.backfill-<name>.log
 *         live job states      → backfill-queue.json (status + restarts fields)
 */
const { spawn } = require("child_process");
const fs = require("fs");
const https = require("https");

const QUEUE_FILE = "scripts/backfill-queue.json";
const SUP_LOG = "scripts/.supervisor.log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();
function log(m) { const l = `[${ts()}] ${m}\n`; try { fs.appendFileSync(SUP_LOG, l); } catch {} process.stdout.write(l); }
function readQueue() { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")); } catch { return { jobs: [] }; } }
function writeQueue(q) { try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2)); } catch (e) { log("queue write err " + e); } }

// Is the internet actually reachable? Used before every restart.
function networkUp() {
  return new Promise((res) => {
    const req = https.get("https://www.google.com", (r) => { res(true); r.destroy(); });
    req.on("error", () => res(false));
    req.setTimeout(8000, () => { req.destroy(); res(false); });
  });
}
async function waitForNetwork() {
  let n = 0;
  while (!(await networkUp())) { n++; log(`  network DOWN (check ${n}) — waiting 30s`); await sleep(30000); }
}

const running = {}; // family -> true while a job in that family is active

function startJob(job) {
  running[job.family] = true;
  const jobLog = `scripts/.backfill-${job.name}.log`;
  const fd = fs.openSync(jobLog, "a");
  log(`START ${job.name} [${job.family}] → ${job.script} ${(job.args || []).join(" ")}`);
  const child = spawn("npx", ["tsx", job.script, ...(job.args || [])], { shell: true, cwd: process.cwd(), env: process.env });
  child.stdout.on("data", (d) => { try { fs.writeSync(fd, d); } catch {} });
  child.stderr.on("data", (d) => { try { fs.writeSync(fd, d); } catch {} });
  child.on("error", (e) => { log(`spawn error ${job.name}: ${e}`); running[job.family] = false; });
  child.on("exit", async (code) => {
    try { fs.closeSync(fd); } catch {}
    if (code === 0) {
      const q = readQueue(); const j = q.jobs.find((x) => x.name === job.name); if (j) j.status = "done"; writeQueue(q);
      log(`DONE ${job.name} ✓`);
      running[job.family] = false;
      return;
    }
    // crash: keep family marked busy through the network wait + backoff (prevents double-start),
    // then re-queue as pending and free the family.
    const q = readQueue(); const j = q.jobs.find((x) => x.name === job.name); if (j) j.restarts = (j.restarts || 0) + 1; writeQueue(q);
    const n = j ? j.restarts : 0;
    log(`CRASH ${job.name} (exit ${code}) — restart #${n}: verifying network then backing off`);
    await waitForNetwork();
    await sleep(Math.min(120000, 10000 * n));
    const q2 = readQueue(); const j2 = q2.jobs.find((x) => x.name === job.name);
    if (j2 && j2.status !== "done") j2.status = "pending"; writeQueue(q2);
    log(`network OK — ${job.name} re-queued for restart`);
    running[job.family] = false;
  });
}

(async function main() {
  log("===== SUPERVISOR START =====");
  for (;;) {
    const q = readQueue();
    if (q.stop) { log("STOP flag set — supervisor exiting"); break; }
    for (const job of q.jobs) {
      if (job.status === "done") continue;
      if (running[job.family]) continue;
      if (job.status === "pending" || job.status === undefined) startJob(job);
    }
    const pending = q.jobs.filter((j) => j.status !== "done").length;
    if (pending === 0) log("(idle — all jobs done; polling for new jobs)");
    await sleep(5000);
  }
})();
