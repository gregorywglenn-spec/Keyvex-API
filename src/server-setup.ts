/**
 * Shared MCP-server tool-registration logic. Used by both the stdio entry
 * (src/index.ts — for Claude Desktop) and the HTTP entry (functions/src/
 * index.ts → mcp HTTP function — for remote clients). Keeps DRY so any
 * change to error-handling or response shape happens in one place.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { findTool, TOOLS } from "./tools/index.js";

/**
 * Construct a fresh MCP Server instance with the standard tool capability.
 * For stateless HTTP serving, callers create one of these per request.
 */
export function createMcpServer(name: string, version: string): Server {
  return new Server(
    { name, version },
    { capabilities: { tools: {} } },
  );
}

/**
 * Wire the standard ListTools / CallTool handlers onto a Server instance.
 * Pulls definitions and handlers from the tools/ registry (TOOLS).
 *
 * Errors are surfaced as `isError: true` MCP responses. If a handler throws
 * with a "CODE: message" prefix (the convention in the input-validation
 * helpers), the code is extracted and surfaced separately so agents can
 * branch on it.
 *
 * Error messages are passed through `sanitizeErrorMessage()` before being
 * returned to the client. This strips Google Cloud Console URLs, the GCP
 * project identifier, and other infrastructure details that should never
 * leak to API consumers. Required for compliance with Anthropic Software
 * Directory Policy Section 5A (MCP servers must gracefully handle errors
 * and provide helpful feedback rather than generic error messages — but
 * "helpful" must not include internal infrastructure details).
 */
export function applyToolHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS.map((t) => t.definition),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = findTool(request.params.name);
    if (!tool) {
      return errorResult(
        "UNKNOWN_TOOL",
        `No tool registered named '${request.params.name}'`,
      );
    }
    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      // Log the full original error server-side so we can debug — this
      // shows up in Cloud Functions logs but never reaches the caller.
      const rawMessage = err instanceof Error ? err.message : String(err);
      const rawStack = err instanceof Error ? err.stack : undefined;
      console.error(
        `[mcp] tool '${request.params.name}' threw:`,
        rawMessage,
        rawStack ? `\n${rawStack}` : "",
      );

      // Extract any "CODE: message" prefix per the in-house convention.
      const codeMatch = /^([A-Z][A-Z0-9_]+):\s*/.exec(rawMessage);
      const code = codeMatch ? codeMatch[1]! : classifyError(rawMessage);
      const cleanMessage = codeMatch
        ? rawMessage.slice(codeMatch[0].length)
        : rawMessage;

      // Strip infrastructure details before returning to caller.
      const sanitized = sanitizeErrorMessage(cleanMessage);
      return errorResult(code, sanitized);
    }
  });
}

function errorResult(code: string, message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ code, message }, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * Classify a raw backend error message into a high-level code that an
 * agent can branch on without parsing message text.
 */
function classifyError(rawMessage: string): string {
  if (/FAILED_PRECONDITION.*requires an index/i.test(rawMessage)) {
    return "INDEX_MISSING";
  }
  if (/PERMISSION_DENIED/i.test(rawMessage)) {
    return "BACKEND_PERMISSION_DENIED";
  }
  if (/DEADLINE_EXCEEDED|TIMEOUT/i.test(rawMessage)) {
    return "BACKEND_TIMEOUT";
  }
  if (/UNAVAILABLE/i.test(rawMessage)) {
    return "BACKEND_UNAVAILABLE";
  }
  if (/RESOURCE_EXHAUSTED|QUOTA/i.test(rawMessage)) {
    return "BACKEND_QUOTA_EXCEEDED";
  }
  if (/NOT_FOUND/i.test(rawMessage)) {
    return "BACKEND_NOT_FOUND";
  }
  if (/INVALID_ARGUMENT/i.test(rawMessage)) {
    return "INVALID_ARGUMENT";
  }
  return "INTERNAL_ERROR";
}

/**
 * Strip infrastructure details from an error message before sending to
 * the client. Specifically:
 *
 *   - Firebase Console URLs (contain GCP project IDs + index-creation links)
 *   - The GCP project identifier (`capitaledge-api`) anywhere it appears
 *   - Other `*.googleapis.com` / `*.google.com` URLs
 *   - Verbose Firestore/gRPC framing (numeric status codes, internal phrases)
 *   - Specific known failure shapes get replaced with user-friendly text
 *
 * Replaces with friendly synonyms or `[redacted]` so the message stays
 * informative without leaking implementation details.
 */
export function sanitizeErrorMessage(message: string): string {
  let out = message;

  // Replace the index-required FAILED_PRECONDITION shape with a clear,
  // actionable message. This is the most common backend error a caller
  // can hit when combining filters that lack a composite index.
  out = out.replace(
    /\d+\s*FAILED_PRECONDITION:?\s*The query requires an index\.[\s\S]*/i,
    "Query requires a composite index that has not yet been provisioned for this filter combination. Try a simpler filter (e.g. drop one filter or one sort dimension), or contact contact@keyvex.com to request the index.",
  );

  // Strip Google Cloud Console URLs (these can carry GCP project IDs).
  out = out.replace(
    /https?:\/\/console\.(?:firebase|cloud)\.google\.com\/[^\s)\]]*/gi,
    "[redacted]",
  );

  // Strip any *.googleapis.com URL.
  out = out.replace(/https?:\/\/[a-z0-9.-]*\.googleapis\.com\/[^\s)\]]*/gi, "[redacted]");

  // Strip the GCP project ID anywhere it leaks (defense in depth).
  out = out.replace(/\bcapitaledge-api\b/g, "[project]");

  // Strip numeric gRPC status prefixes ("9 FAILED_PRECONDITION", etc.)
  // that the Firestore SDK includes; keep the descriptive symbol.
  out = out.replace(/^\d+\s+([A-Z_]+):?\s*/, "$1: ");

  // Collapse runs of whitespace introduced by redactions.
  out = out.replace(/\s+/g, " ").trim();

  return out;
}
