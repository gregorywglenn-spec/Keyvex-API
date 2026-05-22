/**
 * MCP tool: get_otc_market_weekly
 *
 * Returns FINRA OTC Transparency weekly summary records — the canonical
 * dark-pool / off-exchange (ATS + OTC) volume disclosure. The 15th MCP tool.
 *
 * Each row captures how much of a given security was traded in a given
 * Alternative Trading System (ATS, the formal term for "dark pool") or
 * OTC firm during a specific reporting week. ATSes are the venues commonly
 * called "dark pools": Goldman's Sigma X, JP Morgan's JPB-X, UBS's UBS ATS,
 * Liquidnet, IEX, etc.
 *
 * Pairs naturally with `get_insider_transactions` and
 * `get_institutional_holdings`: an unusual spike in dark-pool activity for
 * a ticker the week BEFORE an insider sells (or BEFORE 13F filings reveal
 * a big institutional position change) is a real political-alpha signal —
 * institutional accumulation/distribution before public knowledge.
 *
 * Pure-publisher posture: rows return as filed. KeyVex does not compute
 * "dark pool sentiment", "smart money" indicators, or "accumulation
 * intensity" scores — agents derive whatever they want from totals.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryOtcMarketWeekly } from "../firestore.js";
import type {
  OtcMarketWeekly,
  OtcMarketWeeklyQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_otc_market_weekly",
  annotations: {
    title: "FINRA OTC / Dark-Pool Volume",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns FINRA OTC Transparency weekly summary records — off-exchange",
    "(ATS / OTC) volume by security × venue × week. Use this for: dark-",
    "pool activity per ticker, which ATS venues dominate a stock's off-",
    "exchange trading, weekly off-exchange volume trends, or to cross-",
    "reference with insider/institutional activity for accumulation",
    "signals.",
    "",
    "Source: api.finra.org Data API, OTC Market group, weeklySummary",
    "dataset. ALL NMS stocks + OTC equities, reported by every ATS and",
    "FINRA-registered OTC firm. Coverage is comprehensive — there is no",
    "more authoritative dark-pool source.",
    "",
    "Each row carries: issue_symbol + issue_name, MPID + market_",
    "participant_name (venue identity), tier_identifier (T1 / T2 / OTCE),",
    "total_weekly_trade_count, total_weekly_share_quantity, total_",
    "notional_sum (dollars), and summary_type_code (ATS vs OTCE granularity).",
    "",
    "Common MPIDs to know:",
    "  JPBX  — JP Morgan JPB-X (largest ATS by volume)",
    "  UBSA  — UBS ATS",
    "  SGMT  — Goldman Sigma-X",
    "  IATS  — Instinet CBX",
    "  MSPL  — Morgan Stanley MS Pool",
    "  PURE  — Purestream",
    "  IEXG  — IEX",
    "  ITGP  — ITG POSIT",
    "",
    "Tier identifiers:",
    "  T1 / NMS — securities in S&P 500, Russell 1000, selected ETPs",
    "  T2       — all other NMS-listed stocks",
    "  OTCE     — over-the-counter equity securities (pink sheets, etc.)",
    "",
    "Composite weekly_id keys follow {weekStartDate}-{ticker}-{MPID}-",
    "{summaryTypeCode}, e.g., '2026-03-30-NVDA-JPBX-ATS_W_SMBL_FIRM'. Use",
    "for direct doc lookup, fastest path.",
    "",
    "FINRA publishes weekly data with a ~2-week lag. The most recent fully-",
    "published week is typically 2-3 weeks prior to the current date.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      weekly_id: {
        type: "string",
        description:
          "Composite weekly_id ('{weekStartDate}-{ticker}-{MPID}-{summaryTypeCode}'). Direct doc lookup, fastest.",
      },
      issue_symbol: {
        type: "string",
        description: "Stock ticker (e.g., 'NVDA', 'AAPL').",
      },
      issue_name: {
        type: "string",
        description:
          "Case-insensitive substring against the issuer's full name (e.g., 'tesla', 'apple').",
      },
      mpid: {
        type: "string",
        description:
          "ATS / OTC venue identifier (4-character MPID like 'JPBX', 'UBSA', 'SGMT').",
      },
      market_participant_name: {
        type: "string",
        description:
          "Case-insensitive substring against the venue name (e.g., 'jp morgan', 'goldman', 'iex').",
      },
      week_start_date: {
        type: "string",
        description:
          "ISO Monday week-start (YYYY-MM-DD). Use to scope to a single reporting week.",
      },
      tier_identifier: {
        type: "string",
        enum: ["T1", "T2", "NMS", "OTCE"],
        description:
          "Tier filter. T1 = S&P 500 / Russell 1000 / select ETPs. T2 = other NMS. OTCE = OTC pink sheets.",
      },
      summary_type_code: {
        type: "string",
        enum: [
          "ATS_W_SMBL_FIRM",
          "ATS_W_VOL_STATS",
          "OTCE_W_SMBL_FIRM",
          "OTCE_W_VOL_STATS",
        ],
        description:
          "Granularity: SMBL_FIRM = one row per ticker × venue (dark-pool detail). VOL_STATS = firm-level aggregates (no per-ticker breakdown).",
      },
      since: {
        type: "string",
        description: "Week-start date lower bound (YYYY-MM-DD inclusive).",
      },
      until: {
        type: "string",
        description: "Week-start date upper bound (YYYY-MM-DD inclusive).",
      },
      sort_by: {
        type: "string",
        enum: [
          "week_start_date",
          "total_weekly_share_quantity",
          "total_notional_sum",
          "total_weekly_trade_count",
        ],
        description:
          "Default: week_start_date (most recent first). Use total_notional_sum or total_weekly_share_quantity to rank biggest activity.",
      },
      sort_order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Default: desc.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum rows to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<OtcMarketWeekly>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryOtcMarketWeekly(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): OtcMarketWeeklyQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: OtcMarketWeeklyQuery = {};

  if (args.weekly_id !== undefined) {
    if (typeof args.weekly_id !== "string") {
      throw new Error("weekly_id must be a string");
    }
    out.weekly_id = args.weekly_id;
  }

  if (args.issue_symbol !== undefined) {
    if (
      typeof args.issue_symbol !== "string" ||
      !/^[A-Za-z][A-Za-z0-9./-]{0,9}$/.test(args.issue_symbol)
    ) {
      throw new Error(
        `INVALID_TICKER: '${String(args.issue_symbol)}' — expected stock ticker symbol`,
      );
    }
    out.issue_symbol = args.issue_symbol.toUpperCase();
  }

  if (args.issue_name !== undefined) {
    if (typeof args.issue_name !== "string") {
      throw new Error("issue_name must be a string");
    }
    out.issue_name = args.issue_name;
  }

  if (args.mpid !== undefined) {
    if (
      typeof args.mpid !== "string" ||
      !/^[A-Za-z0-9]{1,8}$/.test(args.mpid)
    ) {
      throw new Error(
        `INVALID_MPID: '${String(args.mpid)}' — expected 1-8 alphanumeric (e.g., 'JPBX', 'UBSA')`,
      );
    }
    out.mpid = args.mpid.toUpperCase();
  }

  if (args.market_participant_name !== undefined) {
    if (typeof args.market_participant_name !== "string") {
      throw new Error("market_participant_name must be a string");
    }
    out.market_participant_name = args.market_participant_name;
  }

  if (args.week_start_date !== undefined) {
    if (
      typeof args.week_start_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.week_start_date)
    ) {
      throw new Error(
        `INVALID week_start_date: '${String(args.week_start_date)}' — expected YYYY-MM-DD`,
      );
    }
    out.week_start_date = args.week_start_date;
  }

  if (args.tier_identifier !== undefined) {
    if (
      typeof args.tier_identifier !== "string" ||
      !["T1", "T2", "NMS", "OTCE"].includes(args.tier_identifier.toUpperCase())
    ) {
      throw new Error(
        `INVALID tier_identifier: '${String(args.tier_identifier)}' — expected T1 | T2 | NMS | OTCE`,
      );
    }
    out.tier_identifier = args.tier_identifier.toUpperCase();
  }

  if (args.summary_type_code !== undefined) {
    if (
      typeof args.summary_type_code !== "string" ||
      !["ATS_W_SMBL_FIRM", "ATS_W_VOL_STATS", "OTCE_W_SMBL_FIRM", "OTCE_W_VOL_STATS"].includes(
        args.summary_type_code,
      )
    ) {
      throw new Error(`INVALID summary_type_code: '${String(args.summary_type_code)}'`);
    }
    out.summary_type_code = args.summary_type_code;
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

  if (args.sort_by !== undefined) {
    if (
      typeof args.sort_by !== "string" ||
      !["week_start_date", "total_weekly_share_quantity", "total_notional_sum", "total_weekly_trade_count"].includes(
        args.sort_by,
      )
    ) {
      throw new Error(`INVALID sort_by: '${String(args.sort_by)}'`);
    }
    out.sort_by = args.sort_by as OtcMarketWeeklyQuery["sort_by"];
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
