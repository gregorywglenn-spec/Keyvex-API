/**
 * Tiny reusable Slack poster for the Mon/Wed/Fri Claude scraper review.
 *
 *   npx tsx scripts/post-slack.ts "your message here"
 *   echo "your message" | npx tsx scripts/post-slack.ts        # also works (stdin)
 *
 * Reads SLACK_HEALTHCHECK_WEBHOOK from the environment (loaded from
 * secrets/.env via ../src/load-secrets.js for local runs; Cloud Functions get
 * it from Secret Manager). POSTs the message verbatim — the caller is
 * responsible for including the LOAD-BEARING `[capitaledge-api]` project
 * prefix so the shared channel can tell our alerts from Derek's.
 *
 * ⚠ The webhook is SHARED with Derek's capital-edge-d5038 project. Anything
 * posted here also lands in Derek's view of the channel. Give him a heads-up
 * before the first message from a new automation.
 *
 * Exits 0 on a 2xx from Slack, 1 otherwise (so a scheduled task can tell
 * whether the post actually landed).
 */
import "../src/load-secrets.js";

const TIMEOUT_MS = 10_000;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main() {
  const argMsg = process.argv.slice(2).join(" ").trim();
  const message = argMsg || (await readStdin());

  if (!message) {
    console.error("post-slack: no message given (pass as arg or pipe via stdin)");
    process.exit(1);
  }

  const url = process.env.SLACK_HEALTHCHECK_WEBHOOK;
  if (!url) {
    console.error(
      "post-slack: SLACK_HEALTHCHECK_WEBHOOK not set. Add it to secrets/.env " +
        "(local) or it's read from Secret Manager in Cloud Functions.",
    );
    process.exit(1);
  }

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`post-slack: Slack ${res.status}: ${body.slice(0, 200)}`);
      process.exit(1);
    }
    console.log("post-slack: sent");
  } finally {
    clearTimeout(t);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
