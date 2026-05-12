/**
 * KeyVex MCP Server — stdio entry point.
 *
 * Package name: `keyvex`. Public brand: KeyVex.
 *
 * Exposes US public financial disclosures (congressional trades, executive
 * insider transactions, institutional holdings, federal contracts, lobbying,
 * 8-K material events, member profiles) as MCP tools designed natively for
 * AI agents.
 *
 * Architecture:
 *   - src/tools/<tool>.ts    one file per tool, exports `definition` + `handler`
 *   - src/tools/index.ts     registry of all tools
 *   - src/server-setup.ts    shared Server + handler-registration logic
 *   - src/firestore.ts       data layer (auto-detects stub vs live mode)
 *   - src/types.ts           shared types
 *   - src/index.ts           this file — stdio wrapper for Claude Desktop
 *   - functions/src/index.ts companion HTTP wrapper (Firebase Cloud Functions)
 *
 * Transport: stdio for local clients (Claude Desktop). The HTTP/SSE entry
 * lives in functions/ and is deployed at https://us-central1-capitaledge-api.
 * cloudfunctions.net/mcp (will be remapped to mcp.keyvex.com once the domain
 * cutover happens).
 *
 * Note: the underlying Firebase project ID (`capitaledge-api`) is permanent
 * Google infrastructure — Google does not allow renaming project IDs. The
 * KeyVex brand is independent of that infra-side identifier; customer-facing
 * surfaces show "KeyVex" exclusively.
 *
 * Mode auto-detect: live Firestore is used when secrets/service-account.json
 * exists OR when running on Cloud Functions (ADC); otherwise the stub returns
 * realistic mock data. See firestore.ts.
 *
 * See README.md, MCP_PROJECT_HANDOFF.md, DATA_REQUIREMENTS_FOR_DASHBOARD.md,
 * and TOOL_DESIGN.md in the project root for full context.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isStubMode } from "./firestore.js";
import { applyToolHandlers, createMcpServer } from "./server-setup.js";
import { TOOLS } from "./tools/index.js";

const SERVER_NAME = "keyvex";
const SERVER_VERSION = "0.37.0";

// ─── Boot ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = createMcpServer(SERVER_NAME, SERVER_VERSION);
  applyToolHandlers(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr is convention — stdout is reserved for MCP protocol messages.
  const mode = isStubMode() ? "STUB MODE (no service account)" : "LIVE MODE";
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} — running on stdio — ${mode} — ${TOOLS.length} tool(s) registered:`,
  );
  for (const t of TOOLS) {
    console.error(`  • ${t.definition.name}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
