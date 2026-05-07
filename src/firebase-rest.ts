/**
 * Firebase REST API helper.
 *
 * Mints OAuth bearer tokens from the service account at secrets/service-account.json
 * and calls Google REST APIs (Firebase Hosting, Cloud Run, etc.) directly. Fills
 * gaps where the firebase CLI doesn't expose what we need — most notably custom-
 * domain management on Firebase Hosting.
 *
 * Service account scopes requested: Firebase + cloud-platform (broad, but we own
 * the project so the SA already has near-admin Firebase rights).
 *
 * Usage (CLI):
 *   npx tsx src/firebase-rest.ts list-sites
 *   npx tsx src/firebase-rest.ts list-domains keyvex-mcp
 *   npx tsx src/firebase-rest.ts get-domain keyvex-mcp mcp.keyvex.com
 *   npx tsx src/firebase-rest.ts add-domain keyvex-mcp mcp.keyvex.com
 *   npx tsx src/firebase-rest.ts token             # print a fresh bearer token
 *   npx tsx src/firebase-rest.ts raw GET /v1beta1/projects/capitaledge-api/sites
 *
 * Programmatic:
 *   import { firebaseRequest, getCustomDomain } from "./firebase-rest.js";
 *   const data = await getCustomDomain("keyvex-mcp", "mcp.keyvex.com");
 */

import * as path from "path";
import { fileURLToPath } from "url";
import { GoogleAuth } from "google-auth-library";

const PROJECT_ID = "capitaledge-api";
const HOSTING_API = "https://firebasehosting.googleapis.com";

let cachedAuth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (cachedAuth) return cachedAuth;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const keyFilename = path.join(repoRoot, "secrets", "service-account.json");
  cachedAuth = new GoogleAuth({
    keyFilename,
    scopes: [
      "https://www.googleapis.com/auth/firebase",
      "https://www.googleapis.com/auth/cloud-platform",
    ],
  });
  return cachedAuth;
}

export async function getAccessToken(): Promise<string> {
  const client = await getAuth().getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error("[firebase-rest] No access token returned from service account");
  }
  return tokenResponse.token;
}

export interface RestOptions {
  method?: string;
  body?: unknown;
  baseUrl?: string;
}

export async function firebaseRequest(
  pathOrUrl: string,
  options: RestOptions = {},
): Promise<unknown> {
  const token = await getAccessToken();
  const baseUrl = options.baseUrl ?? HOSTING_API;
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : baseUrl + (pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`);

  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    throw new Error(
      `[firebase-rest] ${res.status} ${res.statusText} on ${options.method ?? "GET"} ${url}\n${detail}`,
    );
  }

  return data;
}

// ─── Convenience wrappers ────────────────────────────────────────────────────

export async function listSites(): Promise<unknown> {
  return firebaseRequest(`/v1beta1/projects/${PROJECT_ID}/sites`);
}

export async function listCustomDomains(siteId: string): Promise<unknown> {
  return firebaseRequest(
    `/v1beta1/projects/${PROJECT_ID}/sites/${siteId}/customDomains`,
  );
}

export async function getCustomDomain(
  siteId: string,
  domain: string,
): Promise<unknown> {
  return firebaseRequest(
    `/v1beta1/projects/${PROJECT_ID}/sites/${siteId}/customDomains/${domain}`,
  );
}

export async function addCustomDomain(
  siteId: string,
  domain: string,
): Promise<unknown> {
  return firebaseRequest(
    `/v1beta1/projects/${PROJECT_ID}/sites/${siteId}/customDomains?customDomainId=${encodeURIComponent(domain)}`,
    { method: "POST", body: {} },
  );
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function help(): void {
  console.log(
    `Firebase REST CLI — mints tokens from secrets/service-account.json and calls
the Firebase Hosting REST API. Fills gaps the firebase CLI doesn't cover.

Commands:
  list-sites
  list-domains <siteId>
  get-domain <siteId> <domain>
  add-domain <siteId> <domain>
  token                          # print a fresh bearer token (for ad-hoc curl)
  raw <METHOD> <path> [json]     # raw REST call

Examples:
  npx tsx src/firebase-rest.ts list-sites
  npx tsx src/firebase-rest.ts list-domains keyvex-mcp
  npx tsx src/firebase-rest.ts get-domain keyvex-mcp mcp.keyvex.com
  npx tsx src/firebase-rest.ts raw GET /v1beta1/projects/capitaledge-api/sites
`,
  );
}

async function cli(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  let result: unknown;

  switch (cmd) {
    case "list-sites":
      result = await listSites();
      break;
    case "list-domains":
      if (!rest[0]) throw new Error("Usage: list-domains <siteId>");
      result = await listCustomDomains(rest[0]);
      break;
    case "get-domain":
      if (!rest[0] || !rest[1])
        throw new Error("Usage: get-domain <siteId> <domain>");
      result = await getCustomDomain(rest[0], rest[1]);
      break;
    case "add-domain":
      if (!rest[0] || !rest[1])
        throw new Error("Usage: add-domain <siteId> <domain>");
      result = await addCustomDomain(rest[0], rest[1]);
      break;
    case "token":
      result = await getAccessToken();
      break;
    case "raw": {
      if (!rest[0] || !rest[1])
        throw new Error("Usage: raw <METHOD> <path> [json-body]");
      const body = rest[2] ? JSON.parse(rest[2]) : undefined;
      result = await firebaseRequest(rest[1], { method: rest[0], body });
      break;
    }
    default:
      throw new Error(`Unknown command: ${cmd}. Run --help for usage.`);
  }

  if (typeof result === "string") {
    console.log(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

const invokedDirectly =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message ?? String(err));
    process.exit(1);
  });
}
