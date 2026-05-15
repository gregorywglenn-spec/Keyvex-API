/**
 * Local-only env-var loader.
 *
 * Reads `secrets/.env` at module load and sets every KEY=VALUE pair into
 * `process.env` (without overriding values already there). This lets us
 * keep API keys for FRED / EIA / GOVINFO / etc. on disk without
 * scattering `dotenv` configuration everywhere.
 *
 * Cloud Functions don't need this — Firebase Secret Manager already
 * populates `process.env` for declared secrets before this module runs.
 *
 * NEVER commit `secrets/.env`. The whole `secrets/` directory is
 * gitignored at the repo root. Keys here are local-dev convenience only.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", "secrets", ".env");

if (existsSync(envPath)) {
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // First writer wins — process.env already set (e.g., via shell export
    // or Firebase Secret Manager) takes precedence over the file.
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
