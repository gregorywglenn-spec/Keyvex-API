/**
 * Read-only attempt to pull GCP Cloud Logging entries for a Cloud Function
 * via the same service-account-mediated REST pattern used in
 * `src/firebase-rest.ts`. If the service account doesn't have
 * `roles/logging.viewer`, this will return 403 and tell us we need Greg
 * to do it himself or grant the role.
 *
 * Usage:
 *   npx tsx scripts/_pull-gcp-logs.ts <function_name> <since_iso> [until_iso]
 *
 * Example:
 *   npx tsx scripts/_pull-gcp-logs.ts scrapeForm4HalfHourly 2026-05-25T12:30:00Z 2026-05-25T13:30:00Z
 */
import { GoogleAuth } from "google-auth-library";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_PATH = path.resolve(__dirname, "..", "secrets", "service-account.json");

async function main(): Promise<void> {
  const [, , fnName, since, until] = process.argv;
  if (!fnName || !since) {
    console.error(
      "Usage: npx tsx scripts/_pull-gcp-logs.ts <function_name> <since_iso> [until_iso]",
    );
    process.exit(1);
  }
  const untilClause = until ? ` AND timestamp <= "${until}"` : "";

  // Gen 2 functions surface in Cloud Logging as cloud_run_revision (since
  // they're Cloud Run under the hood). The function name appears as a
  // label on the cloud_run_revision resource.
  const filter = `
    resource.type = "cloud_run_revision"
    AND resource.labels.service_name = "${fnName}"
    AND timestamp >= "${since}"${untilClause}
  `.trim();

  const auth = new GoogleAuth({
    keyFilename: KEY_PATH,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  const token = tokenResp.token;
  if (!token) throw new Error("Failed to mint access token from service account");

  const body = {
    resourceNames: ["projects/capitaledge-api"],
    filter,
    orderBy: "timestamp desc",
    pageSize: 100,
  };

  const url = "https://logging.googleapis.com/v2/entries:list";
  console.error(`POST ${url}`);
  console.error(`filter: ${filter}`);
  console.error("");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`);
    console.error(text);
    process.exit(2);
  }

  let parsed: { entries?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("Response was not JSON:");
    console.error(text);
    process.exit(3);
  }

  const entries = parsed.entries ?? [];
  console.error(`OK — ${entries.length} entries returned`);
  console.error("");

  // Print entries newest-first (already in that order from orderBy desc)
  for (const e of entries) {
    const ts = e.timestamp as string | undefined;
    const sev = (e.severity as string | undefined) ?? "DEFAULT";
    const txt =
      (e.textPayload as string | undefined) ??
      JSON.stringify(e.jsonPayload ?? e.protoPayload ?? {}, null, 0);
    console.log(`[${ts}] [${sev}] ${txt}`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
