/**
 * Randomized battle test — 30 queries that simulate real agent behavior.
 *
 * Each query is randomly composed from realistic parameter pools (mixing
 * tickers, member names, date ranges, sort orders, filter combinations).
 * Mirrors what an MCP customer's agent would actually generate during a
 * production conversation.
 */

const ENDPOINT = "https://mcp.keyvex.com";
const API_KEY =
  "daadc3245a89ec5b134b27a6bda572485b5bb50583a602da5870d36b33874d7f";

// ─── Random parameter pools ───────────────────────────────────────────

const TICKERS_LARGE = ["AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "TSLA"];
const TICKERS_MID = ["AMD", "AVGO", "ORCL", "CRM", "ADBE", "NFLX", "INTC", "CSCO", "QCOM", "PLTR", "SNOW", "CRWD", "PANW"];
const TICKERS_FIN = ["JPM", "BAC", "GS", "MS", "V", "MA", "AXP", "BLK", "SCHW"];
const TICKERS_HEALTH = ["UNH", "JNJ", "PFE", "MRK", "LLY", "ABBV", "TMO", "BMY", "AMGN", "GILD"];
const TICKERS_DEF = ["BA", "LMT", "RTX", "NOC", "GD", "HII", "GE", "HON"];
const TICKERS_CONS = ["WMT", "HD", "COST", "KO", "PEP", "MCD", "NKE", "DIS", "SBUX"];
const ALL_TICKERS = [
  ...TICKERS_LARGE, ...TICKERS_MID, ...TICKERS_FIN,
  ...TICKERS_HEALTH, ...TICKERS_DEF, ...TICKERS_CONS,
];

const FAMOUS_BIOGUIDES = [
  "C001035", // Susan Collins
  "P000197", // Nancy Pelosi
  "S000033", // Bernie Sanders
  "M001190", // Markwayne Mullin
  "B001299", // Jim Banks (chamber-switcher)
  "W000817", // Elizabeth Warren
  "R000122", // Marco Rubio
  "C001098", // Ted Cruz
];

const FAMOUS_NAMES = ["Pelosi", "Schumer", "Collins", "Cruz", "Warren", "Sanders", "Tuberville", "Mullin"];

const HISTORICAL_NAMES = ["Clay", "Webster", "Calhoun", "Sumner", "Lincoln", "Adams"];

const STATES = ["NY", "CA", "TX", "FL", "MA", "VA", "PA", "OH", "IL", "GA", "NC", "WA", "ME"];

const COMMITTEES = ["HSAS", "HSAP", "HSAG", "HSBA", "HSEN", "HSJU", "HSWM",
                    "SSAS", "SSAP", "SSBK", "SSCM", "SSFI", "SSJU"];

const CONTRACTORS = ["Lockheed Martin", "Boeing", "Raytheon", "Northrop Grumman",
                     "General Dynamics", "Pfizer", "Microsoft", "Amazon Web",
                     "SpaceX", "Booz Allen"];

const LOBBY_CLIENTS = ["Pfizer", "Microsoft", "Amazon", "Apple", "Meta",
                       "Boeing", "Lockheed Martin", "Google", "ExxonMobil"];

const ITEM_CODES_8K = ["1.01", "2.01", "2.02", "5.02", "7.01", "8.01"];
const ISSUE_CODES = ["DEF", "HCR", "TAX", "TRD", "TEC", "ENV", "MMM", "FIN"];

const SORT_ORDERS = ["desc", "desc", "desc", "asc"]; // 75% desc

// ─── Helpers ──────────────────────────────────────────────────────────

const rand = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
const sample = <T>(arr: T[], n: number): T[] => {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
};
const maybe = <T>(value: T, probability = 0.5): T | undefined =>
  Math.random() < probability ? value : undefined;
const randomDate = (yearsAgo: number): string => {
  const ms = Math.random() * yearsAgo * 365 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString().slice(0, 10);
};

interface Query {
  tool: string;
  args: Record<string, unknown>;
  intent: string; // human-readable description of what an agent would be asking
}

// ─── Tool query generators ────────────────────────────────────────────

const generators: Array<() => Query> = [
  // Form 4 — by ticker
  () => {
    const ticker = rand(ALL_TICKERS);
    const transaction_type = maybe(rand(["buy", "sell"]), 0.6);
    const min_value = maybe(rand([100000, 1000000, 5000000]), 0.4);
    return {
      tool: "get_insider_transactions",
      args: {
        ticker,
        ...(transaction_type !== undefined ? { transaction_type } : {}),
        ...(min_value !== undefined ? { min_value } : {}),
        sort_by: rand(["disclosure_date", "transaction_date", "total_value"]),
        sort_order: rand(SORT_ORDERS),
        limit: rand([5, 10, 20]),
      },
      intent: `Insider trades for ${ticker}${transaction_type ? ` (${transaction_type}s)` : ""}${min_value ? ` over $${min_value}` : ""}`,
    };
  },

  // Form 4 — by officer name substring
  () => {
    const ticker = rand(["AAPL", "TSLA", "MSFT", "NVDA"]);
    const officer_name = rand(["Cook", "Musk", "Nadella", "Huang", "Pichai"]);
    return {
      tool: "get_insider_transactions",
      args: {
        ticker,
        officer_name,
        sort_by: "disclosure_date",
        sort_order: "desc",
        limit: 5,
      },
      intent: `Find ${officer_name} trades at ${ticker}`,
    };
  },

  // 13F — top holders by ticker
  () => {
    const ticker = rand(ALL_TICKERS);
    return {
      tool: "get_institutional_holdings",
      args: {
        ticker,
        sort_by: rand(["market_value", "shares_held", "shares_change_pct"]),
        sort_order: "desc",
        limit: rand([5, 10]),
      },
      intent: `Top institutional holders of ${ticker}`,
    };
  },

  // Congressional — by ticker
  () => {
    const ticker = rand(ALL_TICKERS);
    const chamber = maybe(rand(["senate", "house"]), 0.4);
    const transaction_type = maybe(rand(["buy", "sell"]), 0.5);
    const since = maybe(randomDate(3), 0.6);
    return {
      tool: "get_congressional_trades",
      args: {
        ticker,
        ...(chamber !== undefined ? { chamber } : {}),
        ...(transaction_type !== undefined ? { transaction_type } : {}),
        ...(since !== undefined ? { since } : {}),
        sort_by: "disclosure_date",
        sort_order: "desc",
        limit: 10,
      },
      intent: `Congressional ${transaction_type ?? "trades"} of ${ticker}${chamber ? ` (${chamber})` : ""}${since ? ` since ${since}` : ""}`,
    };
  },

  // Congressional — by member name
  () => {
    const member_name = rand(FAMOUS_NAMES);
    return {
      tool: "get_congressional_trades",
      args: {
        member_name,
        sort_by: "disclosure_date",
        sort_order: "desc",
        limit: 10,
      },
      intent: `Recent trades by ${member_name}`,
    };
  },

  // Form 144 — planned sales by ticker
  () => {
    const ticker = rand(ALL_TICKERS);
    return {
      tool: "get_planned_insider_sales",
      args: {
        ticker,
        sort_by: rand(["filing_date", "aggregate_market_value", "approximate_sale_date"]),
        sort_order: "desc",
        limit: 5,
      },
      intent: `Planned sales at ${ticker}`,
    };
  },

  // Form 144 — biggest by aggregate value
  () => {
    return {
      tool: "get_planned_insider_sales",
      args: {
        min_value: rand([1000000, 5000000, 10000000]),
        sort_by: "aggregate_market_value",
        sort_order: "desc",
        limit: 10,
      },
      intent: "Biggest planned insider sales (any company)",
    };
  },

  // Form 3 — baselines
  () => {
    const ticker = rand(ALL_TICKERS);
    const is_derivative = maybe(rand([true, false]), 0.5);
    return {
      tool: "get_initial_ownership_baselines",
      args: {
        ticker,
        ...(is_derivative !== undefined ? { is_derivative } : {}),
        sort_by: rand(["filing_date", "shares_owned"]),
        sort_order: "desc",
        limit: 10,
      },
      intent: `${ticker} ${is_derivative === true ? "derivative" : is_derivative === false ? "non-derivative" : "all"} initial ownership baselines`,
    };
  },

  // 13D/G — activist stakes
  () => {
    const is_activist = maybe(true, 0.6);
    const since = randomDate(1);
    return {
      tool: "get_activist_stakes",
      args: {
        ...(is_activist ? { is_activist: true } : {}),
        since,
        sort_by: rand(["filing_date", "percent_of_class", "shares_owned"]),
        sort_order: "desc",
        limit: rand([5, 10]),
      },
      intent: `${is_activist ? "Activist" : "All"} stakes since ${since}`,
    };
  },

  // 13D/G — by ticker
  () => {
    const ticker = rand(ALL_TICKERS);
    return {
      tool: "get_activist_stakes",
      args: {
        ticker,
        sort_by: "percent_of_class",
        sort_order: "desc",
        limit: 5,
      },
      intent: `Largest 5%+ holders of ${ticker}`,
    };
  },

  // Federal contracts
  () => {
    const recipient_name = rand(CONTRACTORS);
    const since = maybe(randomDate(2), 0.5);
    const min_amount = maybe(rand([1000000, 10000000, 100000000]), 0.4);
    return {
      tool: "get_federal_contracts",
      args: {
        recipient_name,
        ...(since !== undefined ? { since } : {}),
        ...(min_amount !== undefined ? { min_amount } : {}),
        sort_by: rand(["award_amount", "last_modified_date", "start_date"]),
        sort_order: "desc",
        limit: 5,
      },
      intent: `${recipient_name} contracts${min_amount ? ` over $${min_amount}` : ""}${since ? ` since ${since}` : ""}`,
    };
  },

  // Member profile — by name
  () => {
    const member_name = rand(FAMOUS_NAMES);
    return {
      tool: "get_member_profile",
      args: { member_name },
      intent: `Member profile for ${member_name}`,
    };
  },

  // Member profile — by bioguide_id
  () => {
    const bioguide_id = rand(FAMOUS_BIOGUIDES);
    return {
      tool: "get_member_profile",
      args: { bioguide_id },
      intent: `Profile lookup for ${bioguide_id}`,
    };
  },

  // Member profile — by committee
  () => {
    const committee_id = rand(COMMITTEES);
    return {
      tool: "get_member_profile",
      args: { committee_id, limit: 10 },
      intent: `Members of ${committee_id} committee`,
    };
  },

  // Member profile — caucus query (state + chamber + party)
  () => {
    const state = rand(STATES);
    const chamber = rand(["house", "senate"]);
    return {
      tool: "get_member_profile",
      args: { state, chamber },
      intent: `${state} ${chamber} delegation`,
    };
  },

  // Historical member — by year
  () => {
    const active_year = 1800 + Math.floor(Math.random() * 224); // 1800-2023
    const chamber = maybe(rand(["house", "senate"]), 0.5);
    return {
      tool: "get_historical_member",
      args: {
        active_year,
        ...(chamber !== undefined ? { chamber } : {}),
        limit: 10,
      },
      intent: `Members serving in ${active_year}${chamber ? ` (${chamber})` : ""}`,
    };
  },

  // Historical member — by name
  () => {
    const member_name = rand(HISTORICAL_NAMES);
    return {
      tool: "get_historical_member",
      args: { member_name, limit: 5 },
      intent: `Historical search: ${member_name}`,
    };
  },

  // 8-K material events
  () => {
    const ticker = rand(ALL_TICKERS);
    const item_codes = sample(ITEM_CODES_8K, 1 + Math.floor(Math.random() * 2));
    return {
      tool: "get_material_events",
      args: {
        ticker,
        item_codes,
        sort_by: "filing_date",
        sort_order: "desc",
        limit: 5,
      },
      intent: `${ticker} 8-Ks with item codes ${item_codes.join("/")}`,
    };
  },

  // 8-K — recent activity (no ticker)
  () => {
    const item_codes = ["5.02"]; // exec changes
    return {
      tool: "get_material_events",
      args: {
        item_codes,
        sort_by: "filing_date",
        sort_order: "desc",
        limit: 10,
      },
      intent: "Recent executive-change 8-Ks (item 5.02) across all companies",
    };
  },

  // Lobbying — by client
  () => {
    const client_name = rand(LOBBY_CLIENTS);
    const filing_year = maybe(2020 + Math.floor(Math.random() * 6), 0.5);
    return {
      tool: "get_lobbying_filings",
      args: {
        client_name,
        ...(filing_year !== undefined ? { filing_year } : {}),
        sort_by: "dt_posted",
        sort_order: "desc",
        limit: 5,
      },
      intent: `${client_name} lobbying${filing_year ? ` ${filing_year}` : ""}`,
    };
  },

  // Lobbying — by issue
  () => {
    const general_issue_codes = sample(ISSUE_CODES, 1 + Math.floor(Math.random() * 2));
    const filing_year = 2020 + Math.floor(Math.random() * 6);
    return {
      tool: "get_lobbying_filings",
      args: {
        general_issue_codes,
        filing_year,
        sort_by: "income",
        sort_order: "desc",
        limit: 10,
      },
      intent: `Top spenders on ${general_issue_codes.join("/")} in ${filing_year}`,
    };
  },

  // Form 278 — by chamber + year
  () => {
    const chamber = maybe(rand(["house", "senate"]), 0.7);
    const filing_year = 2020 + Math.floor(Math.random() * 5);
    return {
      tool: "get_annual_financial_disclosures",
      args: {
        ...(chamber !== undefined ? { chamber } : {}),
        filing_year,
        sort_by: "filing_date",
        sort_order: "desc",
        limit: 5,
      },
      intent: `Form 278 disclosures from ${chamber ?? "any chamber"} for ${filing_year}`,
    };
  },
];

interface Result {
  num: number;
  intent: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  count: number;
  durationMs: number;
  sample?: unknown;
  error?: string;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{
  count: number;
  sample?: unknown;
}> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  const last = lines[lines.length - 1] ?? text;
  const env = JSON.parse(last) as {
    result?: { content?: { text: string }[]; isError?: boolean };
    error?: { code?: number; message?: string };
  };
  if (env.error) throw new Error(`${env.error.code}: ${env.error.message}`);
  if (env.result?.isError) {
    throw new Error(env.result.content?.[0]?.text ?? "tool returned error");
  }
  const inner = env.result?.content?.[0]?.text ?? "";
  const parsed = JSON.parse(inner) as {
    results?: unknown[]; result?: unknown; count?: number;
  };
  if (Array.isArray(parsed.results)) {
    return { count: parsed.count ?? parsed.results.length, sample: parsed.results[0] };
  }
  if (parsed.result) {
    return { count: 1, sample: parsed.result };
  }
  return { count: 0 };
}

function summarizeSample(s: unknown): string {
  if (!s || typeof s !== "object") return String(s);
  const obj = s as Record<string, unknown>;
  const keys = Object.keys(obj).slice(0, 5);
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") {
      parts.push(`${k}=${v.length > 30 ? v.slice(0, 30) + "…" : v}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}=${v}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}[${v.length}]`);
    } else if (v && typeof v === "object") {
      parts.push(`${k}{…}`);
    }
  }
  return parts.join(" ");
}

async function main() {
  const N = 30;
  console.log(`# Randomized battle test — ${N} queries\n`);

  const results: Result[] = [];

  for (let i = 0; i < N; i++) {
    const gen = generators[Math.floor(Math.random() * generators.length)]!;
    const q = gen();
    const t0 = Date.now();

    try {
      const { count, sample } = await callTool(q.tool, q.args);
      const r: Result = {
        num: i + 1, intent: q.intent, tool: q.tool, args: q.args,
        ok: true, count, durationMs: Date.now() - t0, sample,
      };
      results.push(r);
      const status = count > 0 ? "✓" : "○";
      console.log(`[${i + 1}/${N}] ${status} ${q.tool} — ${q.intent}`);
      console.log(`    args: ${JSON.stringify(q.args)}`);
      console.log(`    → ${count} hit${count === 1 ? "" : "s"} in ${r.durationMs}ms`);
      if (sample) {
        console.log(`    sample: ${summarizeSample(sample)}`);
      }
    } catch (e) {
      const r: Result = {
        num: i + 1, intent: q.intent, tool: q.tool, args: q.args,
        ok: false, count: 0, durationMs: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      };
      results.push(r);
      console.log(`[${i + 1}/${N}] ✗ ${q.tool} — ${q.intent}`);
      console.log(`    args: ${JSON.stringify(q.args)}`);
      console.log(`    FAILED in ${r.durationMs}ms: ${r.error}`);
    }
    console.log("");
  }

  // ─── Summary ─────────────────────────────────────────────
  const ok = results.filter((r) => r.ok);
  const empty = ok.filter((r) => r.count === 0);
  const failed = results.filter((r) => !r.ok);
  const withData = ok.filter((r) => r.count > 0);
  const avgLatency = Math.round(results.reduce((s, r) => s + r.durationMs, 0) / results.length);

  console.log(`\n## Summary\n`);
  console.log(`  Total queries:     ${N}`);
  console.log(`  ✓ Returned data:   ${withData.length} (${Math.round(100 * withData.length / N)}%)`);
  console.log(`  ○ Returned 0 hits: ${empty.length}`);
  console.log(`  ✗ Failed:          ${failed.length}`);
  console.log(`  Avg latency:       ${avgLatency}ms`);

  // Per-tool breakdown
  const byTool: Record<string, { total: number; withData: number; failed: number }> = {};
  for (const r of results) {
    if (!byTool[r.tool]) byTool[r.tool] = { total: 0, withData: 0, failed: 0 };
    byTool[r.tool]!.total++;
    if (!r.ok) byTool[r.tool]!.failed++;
    else if (r.count > 0) byTool[r.tool]!.withData++;
  }
  console.log(`\n  Per-tool:`);
  for (const [tool, stats] of Object.entries(byTool).sort()) {
    console.log(
      `    ${tool.padEnd(36)} ${stats.withData}/${stats.total} with data, ${stats.failed} failed`,
    );
  }

  if (failed.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failed) {
      console.log(`    Q${f.num} (${f.tool}): ${f.error?.slice(0, 100)}`);
    }
  }
  if (empty.length > 0) {
    console.log(`\n  Empty results (genuine zero, not error):`);
    for (const e of empty) {
      console.log(`    Q${e.num} (${e.tool}): ${e.intent}`);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
