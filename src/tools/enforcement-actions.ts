/**
 * MCP tool: get_enforcement_actions
 *
 * Returns SEC + DOJ + CFTC press releases / litigation releases from a unified
 * `enforcement_actions` collection. Pairs naturally with get_insider_transactions
 * / get_activist_stakes / get_tender_offers for "negative-event flag" detection
 * — agents can see when a company (or its executives) became the subject of an
 * enforcement action.
 *
 * Sources:
 *   SEC  — press releases RSS at sec.gov/news/pressreleases.rss
 *          (rolling ~50-item window)
 *   DOJ  — JSON API at justice.gov/api/v1/press_releases.json
 *          (266K+ historical records; v1A pulls latest ~200 per run)
 *   CFTC — HTML index scrape at cftc.gov/PressRoom/PressReleases (no RSS).
 *          v1A index-only (title + date + release number + URL).
 *
 * v1A is metadata + teaser only (CFTC: no body extracted). Full prose lives at `url`.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryEnforcementActions } from "../firestore.js";
import type {
  EnforcementAction,
  EnforcementActionsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_enforcement_actions",
  annotations: {
    title: "Regulatory Enforcement Actions",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns SEC + DOJ + CFTC + OCC + FDIC enforcement-related press",
    "releases. Five regulators, one tool. Use this when the user asks about:",
    "recent SEC charges, DOJ indictments, CFTC derivatives/swaps enforcement,",
    "OCC national-bank examination actions, FDIC bank-failure announcements",
    "or insured-deposit transfers, insider trading prosecutions, FCPA",
    "actions, fraud cases, antitrust enforcement, or to add a 'negative",
    "event' flag to a ticker or person by cross-checking against insider",
    "trades, activist filings, or tender offers.",
    "",
    "Sources:",
    "  source='sec'  — SEC press releases (sec.gov/news/pressreleases.rss).",
    "                  Rolling ~50-item RSS window; refreshes daily. SEC",
    "                  enforcement and policy statements are mixed in the",
    "                  same feed — filter by title substring (e.g.,",
    "                  'charges', 'fraud', 'insider trading') to narrow.",
    "  source='doj'  — DOJ press releases (justice.gov/api/v1/press_releases.json).",
    "                  Latest ~200 records refreshed daily; rich metadata",
    "                  including agency_component (issuing division) and",
    "                  topics[]. Common components: 'Criminal Division',",
    "                  'Antitrust Division', 'Tax Division', 'Civil Division',",
    "                  'Office of Public Affairs', 'United States Attorneys'.",
    "  source='cftc' — CFTC press releases (cftc.gov/PressRoom/PressReleases).",
    "                  HTML index scrape (no RSS). Rolling ~50-item window.",
    "                  Covers derivatives/swaps enforcement, prediction-market",
    "                  jurisdiction, spoofing prosecutions, and policy actions.",
    "                  v1A index-only (no body extracted) — follow `url` for",
    "                  the substantive announcement.",
    "  source='occ'  — OCC news releases (occ.treas.gov/news-issuances/",
    "                  news-releases/<year>/...). Covers national-bank",
    "                  enforcement, examination findings, capital/leverage",
    "                  rules, interagency announcements. Yearly index. Both",
    "                  OCC-only (`nr-occ-...`) and interagency (`nr-ia-...`)",
    "                  releases included; bulletins filtered out.",
    "  source='fdic' — FDIC press releases (fdic.gov/news/press-releases).",
    "                  Covers bank failures + insured-deposit transfers,",
    "                  exam-result releases, deposit-insurance rule changes,",
    "                  CRA evaluations. Bank-failure announcements are some",
    "                  of the highest-signal FDIC items for agents.",
    "",
    "v1A scope: metadata + teaser + description (capped ~3000 chars; empty",
    "for CFTC v1A). Full prose lives at `url` — agents follow for the",
    "substantive announcement. Pure-publisher posture: no derived 'severity'",
    "or 'outcome prediction' signals.",
    "",
    "Identifier format: action_id is 'sec-{guid-or-slug}', 'doj-{uuid}',",
    "'cftc-{release-number}', 'occ-{slug}', or 'fdic-{slug}'. Stable across",
    "re-scrapes.",
    "",
    "Cross-source tip: pair with get_insider_transactions to detect insider",
    "trades by executives at companies later named in enforcement charges,",
    "or with get_activist_stakes to spot enforcement-driven exit attempts.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      action_id: {
        type: "string",
        description:
          "Direct lookup ('sec-{guid}', 'doj-{uuid}', or 'cftc-{release-number}'). Fastest path.",
      },
      source: {
        type: "string",
        enum: ["sec", "doj", "cftc", "occ", "fdic", "ftc"],
        description:
          "Filter to one issuing agency: sec (SEC), doj (DOJ), cftc (CFTC), occ (OCC bank-regulator), fdic (FDIC bank-regulator), ftc (FTC antitrust + consumer protection).",
      },
      title: {
        type: "string",
        description:
          "Case-insensitive substring against the title / headline (e.g., 'insider trading', 'fraud', 'antitrust').",
      },
      text: {
        type: "string",
        description:
          "Case-insensitive substring against title + teaser + description combined. Use for company-name / person-name searches.",
      },
      agency_component: {
        type: "string",
        description:
          "Substring against the issuing DOJ component (e.g., 'criminal division', 'fraud section', 'antitrust'). Empty for most SEC items.",
      },
      topic: {
        type: "string",
        description:
          "Filter by DOJ topic tag (array-contains, e.g., 'Financial Fraud', 'Cybercrime', 'Public Corruption').",
      },
      since: {
        type: "string",
        description: "Published date lower bound (YYYY-MM-DD inclusive).",
      },
      until: {
        type: "string",
        description: "Published date upper bound (YYYY-MM-DD inclusive).",
      },
      sort_order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Default: desc (most recent announcements first).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum actions to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<EnforcementAction>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryEnforcementActions(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): EnforcementActionsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: EnforcementActionsQuery = {};

  if (args.action_id !== undefined) {
    if (typeof args.action_id !== "string") {
      throw new Error("action_id must be a string");
    }
    out.action_id = args.action_id;
  }

  if (args.source !== undefined) {
    const validSources = ["sec", "doj", "cftc", "occ", "fdic", "ftc"];
    if (!validSources.includes(args.source as string)) {
      throw new Error(
        `INVALID source: '${String(args.source)}' — expected one of ${validSources.join(", ")}`,
      );
    }
    out.source = args.source as EnforcementActionsQuery["source"];
  }

  if (args.title !== undefined) {
    if (typeof args.title !== "string") throw new Error("title must be a string");
    out.title = args.title;
  }

  if (args.text !== undefined) {
    if (typeof args.text !== "string") throw new Error("text must be a string");
    out.text = args.text;
  }

  if (args.agency_component !== undefined) {
    if (typeof args.agency_component !== "string") {
      throw new Error("agency_component must be a string");
    }
    out.agency_component = args.agency_component;
  }

  if (args.topic !== undefined) {
    if (typeof args.topic !== "string") throw new Error("topic must be a string");
    out.topic = args.topic;
  }

  if (args.since !== undefined) {
    if (
      typeof args.since !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.since)
    ) {
      throw new Error(`INVALID since: '${String(args.since)}' — expected YYYY-MM-DD`);
    }
    out.since = args.since;
  }
  if (args.until !== undefined) {
    if (
      typeof args.until !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.until)
    ) {
      throw new Error(`INVALID until: '${String(args.until)}' — expected YYYY-MM-DD`);
    }
    out.until = args.until;
  }

  if (args.sort_order !== undefined) {
    if (
      typeof args.sort_order !== "string" ||
      !["asc", "desc"].includes(args.sort_order)
    ) {
      throw new Error(`INVALID sort_order: '${String(args.sort_order)}'`);
    }
    out.sort_order = args.sort_order as "asc" | "desc";
  }

  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 500
    ) {
      throw new Error(
        `INVALID limit: '${String(args.limit)}' — expected integer 1..500`,
      );
    }
    out.limit = args.limit;
  }

  return out;
}
