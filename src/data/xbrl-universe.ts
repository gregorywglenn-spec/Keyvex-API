/**
 * Curated XBRL ticker universe for fundamentals coverage.
 *
 * Selection rationale: this isn't the S&P 500. It's a focused ~110 tickers
 * chosen to cover the most-asked agent queries plus the cross-source play
 * KeyVex specializes in:
 *
 *   - Mega-caps + S&P 100 (every agent will ask about these)
 *   - Defense + aerospace (overlaps federal_contracts)
 *   - Major banks (overlaps enforcement_actions + CFPB)
 *   - Big tech (most-queried sector)
 *   - Healthcare insurers/pharma (overlaps OIG exclusions + lobbying)
 *   - Energy majors (overlaps macro + FERC)
 *   - High-traffic non-index names (TSLA, COIN, PLTR, etc.)
 *
 * Storage cost at ~6500 observations per company × 110 tickers ≈ 715K
 * records ≈ ~360 MB. Acceptable for v1A.
 *
 * v1.1 expansion path: full S&P 500 → Russell 1000 → all 11K SEC US
 * registrants. Add tickers below as needed; the scraper auto-skips
 * unknowns via the EDGAR ticker cache.
 */
export const XBRL_UNIVERSE: ReadonlyArray<string> = [
  // ── Mega-caps + S&P 100 core ───────────────────────────────────────────
  // Note: GOOGL covers Alphabet (CIK 1652044) — GOOG would re-scrape the
  // same CIK and overwrite. Only one share class per CIK in the universe.
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "BRK.B",
  "LLY", "JPM", "AVGO", "TSLA", "V", "WMT", "JNJ", "XOM", "MA", "UNH",
  "PG", "ORCL", "HD", "COST", "ABBV", "BAC", "NFLX", "KO", "CRM", "CVX",
  "MRK", "PEP", "AMD", "TMO", "ADBE", "ACN", "LIN", "WFC", "MCD", "CSCO",
  "DIS", "IBM", "ABT", "GE", "PM", "DHR", "AXP", "NOW", "CAT", "T",
  "VZ", "INTU", "MS", "ISRG", "AMGN", "GS", "TXN", "RTX", "COP", "PFE",
  "NEE", "SPGI", "BKNG", "BLK", "HON", "TJX", "LOW", "C", "NKE",
  "LMT", "ETN", "PGR", "UPS", "BSX", "SCHW", "MDT", "SYK", "ELV", "ADP",
  "BA", "BMY", "GILD", "MU", "VRTX", "CB", "KLAC", "INTC", "TMUS", "MO",
  "DE", "SBUX", "DUK", "AON", "ICE", "BDX", "CL", "SO",
  // MRSH = Marsh & McLennan — ticker changed from MMC (verified against
  // SEC submissions CIK 62709, 2026-06-10; same pattern as Fiserv FI).
  "CVS", "HCA", "MRSH", "EMR", "GD",
  // ── Defense + aerospace (federal contracts overlap) ────────────────────
  "NOC", "LHX", "GD", "TXT", "HII", "LDOS",
  // ── Banks (enforcement_actions + CFPB overlap) ─────────────────────────
  "USB", "PNC", "TFC", "COF", "BK", "STT",
  // ── Healthcare insurers + drug retail (OIG / lobbying overlap) ─────────
  "CI", "HUM", "CNC",
  // ── Big tech additions ─────────────────────────────────────────────────
  "PYPL", "UBER", "PANW", "ANET", "ABNB", "PLTR", "COIN", "RBLX", "SHOP",
  // ── Energy (FERC + macro overlap) ──────────────────────────────────────
  "SLB", "PSX", "OXY", "EOG", "MPC", "VLO",
  // ── Autos (NHTSA recalls overlap when we ship that) ────────────────────
  "F", "GM", "STLA",
];
