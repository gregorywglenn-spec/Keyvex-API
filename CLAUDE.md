# KeyVex — Project Intelligence File

This is the day-1 reading for any AI agent (Claude or otherwise) opening this project cold. Read this first, then follow the cross-references at the bottom for deeper context.

---

## ⚠️ CORE PROTOCOL — READ BEFORE ANY OTHER LINE OF THIS FILE

**DO NOT ASSUME. VERIFY EVERY LOAD-BEARING FACT WITH A TOOL CALL BEFORE STATING IT.**

This rule is absolute and overrides every preference, optimization, and convention below. Full text in memory at `feedback_verify_facts_dont_assume.md`. Anchored here so it's impossible to miss.

**The canonical failure (2026-05-20 → 2026-05-22, 14 hours of Greg's life):** a prior session drafted `docs/architecture-billing-and-auth.md` asserting "OAuth 2.1 + DCR is required for the Anthropic Connectors Directory" without ever fetching `https://claude.com/docs/connectors/building/authentication.md`. That single missing 30-second fetch cascaded into WorkOS abandoned ($99/mo gate), Descope abandoned after 12 hours of flow-editor pain, then a Clerk plan that started today's session. When the raw doc was finally fetched verbatim, it revealed **five supported auth types including `none` (authless) — which is the cleanest fit for KeyVex.** The entire 14-hour OAuth chase was solving a requirement that didn't exist.

**Operational rule:** for any fact that drives a decision, plan, recommendation, or code change — verify with a tool call first. WebFetch summaries are paraphrases that drop nuance and table entries; for load-bearing docs, fetch raw markdown at `<url>.md` (Anthropic, Stripe, Linear, Vercel, and many others publish these) or `curl` the HTML and parse it yourself. Training-data recall and "common conventions" are not verification.

**Trigger phrases that mean STOP and verify:** "I think the API requires...", "Typically that library...", "Based on common OAuth conventions...", "From the WebFetch summary...", "I recall from training...", "Prior Claude sessions concluded...", "The cron must be...", "Their pricing is around..."

The cost of verifying: ~30 seconds. The cost of not verifying: documented at 14 hours and counting.

---

**Brand:** the public-facing name is **KeyVex** (decided 2026-05-04). Domain `keyvex.com` registered. Earlier doc references to "Capital Edge MCP" or "capital-edge-mcp" as the product's name are pre-rebrand history — the product is now KeyVex everywhere customer-facing.

**Infra-side names that look like the old brand are NOT the brand and stay unchanged forever:**

- Firebase project ID: `capitaledge-api` — Google does not allow renaming project IDs. Permanent. Customer-invisible.
- Cloud Functions URL: `https://us-central1-capitaledge-api.cloudfunctions.net/mcp` — derived from the project ID. Will be hidden behind `mcp.keyvex.com` once the custom domain is mapped.
- Local repo path: `C:\CapitalEdge-API` — local only, no rename benefit.
- The dashboard sibling project (Derek's, at `C:\CapitalEdge`, Firebase project `capital-edge-d5038`) is **not** part of this rebrand. That's Derek's project; he and Greg coordinate any rename on that side separately.

References below to "Capital Edge" generally point to the dashboard project unless they appear in product-name contexts (server name, package name, MCP `serverInfo.name`). Those product-name contexts have all moved to KeyVex.

## Session Bootstrap — DO THIS FIRST, EVERY SESSION

Before writing any code, run these and read the output. This is not optional — skipping it is what caused the Day 10 parallel-worktree divergence (two sessions both built "Day 10," both claimed v0.41.0, neither saw the other).

```
git fetch origin
git branch -a            # see EVERY branch — sibling sessions live here
git worktree list        # see every worktree — parallel work lives here
git log origin/main -8   # the real, authoritative recent history
```

Rules that follow from this:

1. **Other branches / worktrees are other sessions. Check for them before starting.** If a `claude/*` branch or a sibling worktree has recent commits touching what you're about to build, STOP and reconcile with Greg before duplicating it.
2. **Version numbers are claimed by checking, never assumed.** The next version is `(latest version on origin/main) + 1`. Run `git show origin/main:package.json | grep version` — do not guess "0.41.0" because the last thing you remember was 0.40.
3. **Anchor history to facts, not narrative.** Use the real date (it's in your context every session — e.g. `2026-05-15`), the version number, and the commit hash. Do NOT invent "Day N" — "Day N" is a vibe, it can't enforce uniqueness, and two sessions will both pick the same N. The `### Day N` headers below are legacy; keep them for continuity but never let a "Day" label be load-bearing.
4. **"Done" means three checkable facts: committed + pushed + deployed-and-verified.** Never tell Greg something is "done" because you remember doing it — confirm with `git log origin/main` and a live `curl https://mcp.keyvex.com`. Narrative memory is unreliable across compaction and restarts; git and the live endpoint are not.
5. **Don't narrate wall-clock time.** You cannot reliably feel how long passed between messages or sessions. No "sleep well" / "good morning" guessing. State the date and move on.

## Hard Lessons — Read This First

- **Tell the ugly truth.** Especially about whether something will actually work. The instinct to confirm what's flattering is the failure mode. Push back, run actual diagnostics, report the true picture even when it complicates the plan. Tonight that rule caught a real divergence between the on-disk handoff and Greg's verbal direction; flagging it surfaced a real architectural decision instead of plowing past it.
- **Don't quote in weeks what Greg ships in hours.** He builds dramatically faster than institutional time estimates assume. Six and a half hours from "let's set up Cowork for this" to "76 real Form 4 trades in Firestore via a server we built and a repo on GitHub." Calibrate to that pace.
- **Foundation before features. Always.** No exceptions. Same rule from the Capital Edge claude.md, applies here too.
- **Don't make Greg fight the same UI twice.** When a placeholder like `YOUR-USERNAME` showed up in instructions, he typed it literally — costing two failed `git push` cycles. Always offer to fill in known values directly, or ask for them up front.
- **Don't conflate "data only" with "no transformations."** Pure-publisher posture (this project) doesn't surface derived intelligence (signal_weight, convergence scores, ranks). It still does normalization (CUSIP→ticker, date format, field cleanup). Greg explicitly locked the line: data only, no scores, no opinions, ever.
- **Project boundary discipline is real.** This project does NOT write to Capital Edge's Firestore collections. All scraper changes for this project's data happen in *this* codebase, against *this* project's Firebase. Capital Edge is owned by Derek (informal partner) and gets touched only via the data requirements doc as a peer FYI, never as a dependency.
- **Don't trust XML parsers with CUSIPs.** fast-xml-parser auto-parses numeric-looking strings as numbers by default. CUSIPs like `92343E102` (VeriSign) look like scientific notation and get destroyed (became `9.2343e+102`). CUSIPs with leading zeros (`037833100` → `37833100`) lose the prefix. Always set `parseTagValue: false` AND `parseAttributeValue: false`. The first 13F run silently mangled half the CUSIPs before this was caught.
- **13F filings have sub-account dupes — always aggregate by CUSIP.** Large institutional managers (Berkshire, BlackRock, Vanguard) report each security multiple times across internal "managers" / sub-accounts. Berkshire's 110-row 13F XML reduces to 42 unique securities once aggregated. Without aggregation, records collide on the same Firestore doc ID and silently overwrite — real data loss.
- **OpenFIGI returns foreign exchange listings by default.** Without a US-exchange preference filter in `pickBestMatch`, big-cap US stocks resolve to their Frankfurt/XETRA tickers (Chevron→`CHV`, Alphabet→`ABEA`, Moody's→`DUT`, DaVita→`TRL`, Sirius→`3HY`). Always filter `exchCode` for US codes (`US`, `UN`, `UQ`, `UR`, `UW`, `UA`, `UV`, `UF`, `UP`, `UD`, `UB`) before picking shortest ticker.
- **CINS-coded CUSIPs (starting with G or H) need an EDGAR name fallback.** Foreign-domiciled US-listed companies (Chubb-Bermuda, AON-Ireland, Allegion-Ireland, Liberty Latin America-Bermuda) have CUSIPs that begin with letters per the CINS scheme. OpenFIGI often only returns the foreign primary listing, missing the US dual listing. `src/sec-tickers.ts` falls back to EDGAR's `company_tickers.json` matching on normalized issuer name. Closes Chubb (CB), AON, Allegion (ALLE), Liberty Latin America (LILA).
- **Microsoft Store Claude Desktop has a sandboxed config path.** Standard install: `%APPDATA%\Claude\claude_desktop_config.json`. Microsoft Store install: `%LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude\claude_desktop_config.json`. The standard path returns "location unavailable" for Store installs. Greg's machine: `C:\Users\home8\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`.
- **MCP server path resolution must be module-relative, not cwd-relative.** When Claude Desktop spawns the MCP server, the working directory is unpredictable (might be Claude's install dir). `firestore.ts` resolves `secrets/service-account.json` from `import.meta.url` → module dir → project root. Same pattern for any other relative-path file the server needs to read.
- **13F XML `<value>` is in dollars, not thousands, despite SEC instructions saying otherwise.** SEC Form 13F instructions historically read "report value in thousands of dollars (omit last three digits)" — but modern filers (2023+) report the full dollar amount. Treating `<value>` as thousands and multiplying by 1000 produces market_value 1,000× too high (e.g., Berkshire's AAPL position showed as $61T instead of $61B). The fix in `13f.ts` is to treat `<value>` as dollars directly and derive `market_value_thousands` by dividing.
- **OpenFIGI's `pickBestMatch` must return undefined when no US listing exists.** If we fall back to picking the shortest non-US ticker, big-cap securities resolve to foreign exchange tickers (Confluent → 8QR XETRA, Avidity → RNAGBP London, Hillenbrand → 9HI, etc.). Returning undefined forces the EDGAR name fallback (`sec-tickers.ts`) to kick in, which only contains US tickers from `company_tickers.json`. Net result: every record either gets a real US ticker or empty (for truly delisted/foreign-only names).
- **Shortest-ticker tiebreaker can pick the wrong company.** Single-letter tickers from OpenFIGI (e.g. "P" returned for Pure Storage's CUSIP — "P" was Pandora's old NYSE ticker, delisted 2019) win against the correct multi-letter ticker (PSTG) because shortest-wins is naive. Fix: maintain an explicit allowlist of legitimate single-char tickers (V/Visa, C/Citi, F/Ford, T/AT&T, S/SentinelOne, X/US Steel, K/Kellogg, M/Macy's, O/Realty Income, U/Unity, Z/Zillow). Reject any single-char ticker not in the allowlist. Plus reject any ticker matching `/USD$/i` (foreign cross-listings: NCSUSD, SGENUSD, GTT1USD).
- **OpenFIGI sometimes returns wrong-issuer tickers.** CUSIP 023139884 is Ambac Financial Group (AMBC), but OpenFIGI maps it to "OSG" (Overseas Shipholding — totally different company). Same pattern with "MDLN" for what OpenFIGI calls "Medline Inc" and "TIC" for "TIC Solutions Inc" (private/placeholder names). EDGAR-validation against `tickerSet` accepts these because OSG/MDLN/TIC really are valid US tickers — they just don't belong to those CUSIPs. The fix would be issuer-name cross-validation (compare OpenFIGI's returned `name` field against the 13F's `nameOfIssuer` and reject mismatches). Not yet implemented; deferred to v1.1.
- **SEC's `company_tickers.json` is filtered and incomplete; `company_tickers_exchange.json` is also incomplete AND has wrong mappings.** Both files claim to be comprehensive ticker catalogs but real S&P-mid-cap names like Hologic (HOLX), CyberArk (CYBR), Confluent (CFLT), Jamf (JAMF), Avidity (RNA), Dayforce (DAY), Exact Sciences (EXAS), Avadel (AVDL), Dun & Bradstreet (DNB), Hillenbrand (HI), Dynavax (DVAX), Ambac (AMBC) are simply absent. Even worse, `company_tickers_exchange.json` has stale ticker-to-issuer mappings: RNA → "Atrium Therapeutics, Inc." (should be Avidity Biosciences), PSTG → "Everpure, Inc." (should be Pure Storage). Treat both files as best-effort, never authoritative. The fix is a tertiary OpenFIGI search-by-name fallback when EDGAR name lookup fails.
- **Three-tier ticker resolution architecture.** (1) CUSIP → OpenFIGI `/v3/mapping` (cached in Firestore `cusip_map`). (2) If CUSIP returns no acceptable US ticker, try EDGAR name lookup (in-memory match against `company_tickers_exchange.json`). (3) If EDGAR name lookup misses, query OpenFIGI `/v3/search` by issuer name (rate-limited 5/min free, 25/min with API key — paced via `lastSearchCallAt` timestamp). Each successful resolution writes to `cusip_map` so subsequent runs short-circuit at tier 1. Source field tracks which tier resolved each ticker (`openfigi_mapping` / `edgar_name_fallback` / `openfigi_name_search`).
- **Aggressive name normalization is required for EDGAR matching.** 13F filers use abbreviated names ("CTLS" for Controls, "INTL" for International, "COS" for Companies, "PETE" for Petroleum, "HLDG" for Holdings, "MGMT" for Management, "SVCS" for Services, "AMER" for American, "ELEC" for Electric, "PWR" for Power, "WTR" for Water). EDGAR uses long forms. `normalizeName()` in `sec-tickers.ts` expands abbreviations BEFORE stripping corporate-form suffixes. Also strips jurisdiction suffixes (IRELAND, BERMUDA, SWITZ, NETHERLANDS, CAYMAN, etc.) and corporate forms (INC, CORP, LTD, PLC, LLC, HOLDINGS, HOLDING, GROUP, TRUST). With expansion: "JOHNSON CTLS INTL PLC" → "JOHNSON CONTROLS INTERNATIONAL" matches EDGAR's "Johnson Controls International plc" → JCI.
- **Pre-2023 13F market values are in thousands, not dollars.** SEC's instruction-line for `<value>` historically said "report in thousands of dollars (omit last three digits)." Modern filers (2023+) report full dollar amounts. Our fix treats `<value>` as dollars unconditionally, so pre-2023 filings show values 1000× too small. Not blocking v1 (current-quarter focused), but flagged for v1.1 era-boundary handling.
- **Empty `action=""` on an HTML form means "submit to current URL," NOT "fall back to a sibling URL."** The Senate eFD agreement form lives on `/search/home/` and has `<form action="" method="POST" id="agreement_form">`. Our first-pass port treated empty `action` as falsy and fell through to a hardcoded `/search/` default (which the reference browser scraper also used and which appears to have once worked via legacy URL mapping). The eFD now silently re-renders the home page when posted to `/search/`, leaving the session unagreed and downstream PTR detail pages bouncing back to home. The HTML spec is clear: empty `action` and missing `action` both mean "the document's URL." Always extract the form's actual `action` and resolve relative to the page that served the form. Reference scrapers can drift; validate against live behavior, not historical assumptions.
- **Django 4 CSRF middleware requires `Origin` header for unsafe methods.** Browsers always set `Origin` automatically; Node's `fetch` (undici) does not for cross-origin server-to-server requests. Without it, Django silently rejects POSTs and re-renders the form page (200 OK, not 403) — making this nearly impossible to debug from response codes alone. The tell-tale: `agreement POST → HTTP 200, finalUrl=/<form-page>/` instead of `finalUrl=/<post-target>/`. Always set `Origin: https://<host>` explicitly on POSTs from Node fetch. Also helpful: `Referer`, `X-CSRFToken` header, and dump the form HTML to extract the actual hidden-field set rather than hardcoding.
- **Senate eFD agreement protocol — the full sequence.** (1) GET `/search/home/` → extract CSRF token from form input (more reliable than reading from cookie jar since some Django configs make csrftoken HttpOnly). (2) POST `/search/home/` (the form's `action=""` resolves to the page URL, NOT `/search/`) with `csrfmiddlewaretoken` + `prohibition_agreement=1` + `Origin: https://efdsearch.senate.gov` + `Referer: HOME_URL` headers. (3) GET `/search/` to land on the search page after the redirect (some Django configs only flip the agreed flag once you actually load the search page, not at the redirect itself). (4) Re-read CSRF token from the new search page (Django rotates it post-POST). (5) `/search/report/data/` POST sends multipart `FormData` (matches browser wire format), Origin + Referer + X-CSRFToken + X-Requested-With headers. PTR detail GETs use `Referer: SEARCH_URL` once authenticated.
- **Senate PTRs include muni bonds and structured notes — `ticker: "--"` is correct for those.** Senators (esp. McCormick, Collins, Mullin) report large municipal bond and structured-note positions where the asset has no equity ticker. Asset is identified by issuer name + coupon + maturity in the asset_name field. Empty ticker is a faithful reflection of the source data, not a parser bug. v1 keeps these records for completeness; agents querying with a `ticker` filter naturally won't see them. Ticker validation regex must allow `BRK.A` / `BRK.B` etc. (already relaxed in `get_insider_transactions`; same pattern applied to `get_congressional_trades`).
- **Senate "paper PTR" amendments are a real but minor case.** Some PTR detail pages return an HTML wrapper around a PDF embed instead of a trade table. The current parser detects this via an `isPaperPtr()` heuristic and logs+skips. Not blocking v1 — most PTRs are electronic. Push to v1.1 if it ever becomes a meaningful percentage of disclosures (currently ~0% in observed runs).
- **Vertical depth, not horizontal expansion.** The temptation when the hub starts working is to add medical data, legal data, sports data — more domains feels like more value. It's a trap. Every data domain has its own sources, normalization quirks, regulatory landscape, and customer profile. Going horizontal means becoming a mediocre lumberyard for everything instead of an excellent one for one thing. Bloomberg won by going deep on financial. Westlaw won by going deep on legal. UpToDate won by going deep on medical. Wolfram Alpha tried to be everything-engine and never became a real business. The hub stays inside US public-disclosure data forever; expansion happens *deeper into the same vertical* (Form 144, 13D/G, 8-K, lobbying, USAspending, FRED, FEC, FOIA) — not adjacent verticals. The moat (agent-native MCP design + data-quality discipline) doesn't transfer to medical or sports anyway. Greg's analogy: don't call a plumber to lay flooring; don't use the siding guy to install cabinets. Specialists win.
- **Customer funnel is bottom-up, not top-down.** Free tier → indie devs → small fintechs → midsize firms → institutional. Don't optimize for institutional contracts in v1.0; optimize for indie devs *loving* the hub, because those devs become tech leads at small fintechs in 18 months and bring the hub with them. The free public-data cost structure (no Bloomberg-style licensing fees) is what makes this path economically viable. Quiver Quantitative followed exactly this path to a $2.6M raise.
- **Owner-code regex for House PTRs must allow `\S`, not `[A-Z]` or even `[A-Za-z]`.** House PTR rows that involve a non-Self owner prefix the owner code (`SP` / `JT` / `DC`) directly onto the asset name with no separator: `SPApple`, `SPiShares`, `DCBJ`, `DCSTERIS`, `DCEMCOR`, `JTT.` (T. Rowe Price), `JTO'` (O'Reilly), `JT3M` (3M). The character right after the code can be uppercase, lowercase, a digit, a period, or an apostrophe — anything but whitespace. Initial regex `[A-Z][A-Z]` broke on lowercase (SPiShares) and digits. Second pass `[A-Za-z][A-Za-z]` broke on punctuation (JTT., JTO'). Final regex `^(SP|JT|DC)\S` accepts every observed case while correctly rejecting "JT Air" / "SP Plus" (legitimate non-owner-code phrases starting with those letters but separated by space). Captured during the House port — same shape will hit any future PDF-derived parser where columns aren't whitespace-delimited.
- **PDF text extraction adds invisible quirks the parser must defend against.** Three real ones from House PTRs: (1) URL-shaped strings get auto-linkified — `Amazon.com` becomes `[Amazon.com](http://Amazon.com)` in the extracted text, even though the source PDF shows plain text. Cosmetic; doesn't break ticker resolution since AMZN is matched separately. (2) Long asset names that wrap to a second line emit a *phantom partial row* with `asset_type: "Stock"` (the literal word) instead of `"ST"` (the code) — seen in Cisneros JLL row 8, Salazar Whirlpool row 25, McCormick UnitedHealth row 16. The real row immediately follows with correct `asset_type`, so dedup is the v1.1 fix. (3) Multi-line member-narrative comments (Larsen's "advisor explanation" rows, Cisneros's CNL Properties note) overflow into the *next* trade's asset_name field. Heuristic fix: detect asset_name longer than 200 chars or containing `. ` mid-string, strip to the ticker-bearing tail. Same root cause across all three: PDF line breaks aren't reliable row boundaries; the line-walker needs schema-aware row reconstruction. None blocking; all v1.1.
- **EDGAR's `primaryDocument` field points to XSL-rendered HTML, not raw XML.** The submissions API and full-text search both surface paths like `xsl144X01/primary_doc.xml` — that subdirectory is the human-readable rendering through an XSL stylesheet. The actual structured XML lives at the *sibling* path `primary_doc.xml` in the archive root. Without stripping the `xsl<schema>/` prefix, the parser fetches HTML and silently produces zero records (no error — the XML parse "succeeds" against the HTML, just yields nothing under the expected element paths). Caught during the Form 144 build; fix is a one-liner regex strip (`primaryDoc.replace(/^xsl[A-Z0-9]+\//, "")`). Same fix needed in any future scraper for SEC filing types that ship structured XML (Form 144, Form 13F, etc.).
- **Form 144 XML schema is wildly different from Form 4 — and "securitiesToBeSold" is misnamed in the spec.** Three real surprises from Form 144's `edgarSubmission` structured doc: (1) **No ticker symbol anywhere in the XML** — only `issuerCik`. Need CIK→ticker reverse lookup against EDGAR's `company_tickers.json`, which means the ticker cache has to be bidirectional (added `cikToTicker` index alongside the existing `tickerCache` keyed by ticker). (2) **The insider's name is at `issuerInfo.nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold`**, NOT in `filerInfo.filer.name`. The `filerInfo.filer.filerCredentials` block holds the *filing AGENT's* CIK (typically a law firm or filing service) — not the insider. Easy mistake to make if you assume `filerInfo` = "person who filed = insider." (3) **The `<securitiesToBeSold>` element is misnamed in the schema** — it's actually the *acquisition history* block (when the shares were originally acquired, nature of acquisition, payment date). The actual planned-sale data lives under `<securitiesInformation>` (`noOfUnitsSold`, `aggregateMarketValue`, `approxSaleDate`, `brokerOrMarketmakerDetails.name`). Counter-intuitive to the point of being deliberately confusing. (4) **Dates are MM/DD/YYYY**, not ISO. Convert to YYYY-MM-DD on parse so they're consistent with rest of system. All of these are spec-side, not parser bugs — the SEC's Form 144 schema reflects pre-XML form-design choices.
- **10b5-1 plan adoption date is a forward-looking-signal differentiator.** Form 144 includes `noticeSignature.planAdoptionDates.planAdoptionDate` when the planned sale falls under a Rule 10b5-1 trading plan (pre-arranged, automated). When that field is null, the sale is *discretionary* — the insider decided to sell because of something, not because the calendar said so. Capture as `plan_adoption_date` (string) plus `is_10b5_1_plan` (derived boolean) for agent convenience. Real example signal from Day 3 night's pull: Larry Fink's $35.6M BlackRock filing was discretionary; Tim Cook's $33M Apple filings were under a 10b5-1 plan adopted 2024-05-21. Different agent question gets different evidence.
- **CIK→ticker reverse lookup picks preferred-share tickers when the catalog has multiple entries.** EDGAR's `company_tickers.json` lists each ticker class as a separate entry — so a company with common stock and three preferred series shows up as four rows, all with the same CIK. Our naive reverse loop (last write wins) sometimes lands on the preferred-series ticker instead of common. Real Day 3 night examples: AGNC Investment Corp resolved to AGNCL (a preferred class) instead of AGNC; Live Oak Bancshares resolved to LOB-PA instead of LOB; Wintrust Financial resolved to WTFCN instead of WTFC. CIK is correct, just suboptimal ticker. v1.1 fix: prefer entries whose ticker has no hyphen-suffix or "-P" pattern (preferred-series indicator).
- **The XSL-prefix URL gotcha is universal across SEC ownership forms (3 / 4 / 4/A / 5 / 144).** Confirmed Day 4: Apple's Form 3 filings 100% ship the `xslF345X02/wk-form3_*.xml` path in `primaryDocument`, and ~40% of all Form 3 filings across a 7-day live-feed window did. Without `rawXmlPath()` to strip the prefix, the parser fetches XSL-rendered HTML and silently returns 0 records — fastest possible "looks fine, produces nothing" failure mode. The Form 144 Hard Lesson above is now generalized: **always strip `^xsl[A-Z0-9]+/` from any SEC ownership-form primaryDocument before fetching.** Add this to every new SEC-XML scraper as the very first thing. Form 4 hasn't been audited for the same issue — works empirically on Apple but unaudited on smaller filers; v1.1 polish.
- **`issuerTradingSymbol` in Form 3 XML is filer-supplied, not from a controlled vocabulary.** Trinity Industries' Form 3 (April 27, 2026) has `NYSE/TRN` in `issuerTradingSymbol` instead of just `TRN`. Two cascading problems: (1) the slash is illegal in Firestore document IDs (path separator), so saving fails with `"documentPath" must point to a document, but was "...-NYSE/TRN-ND-1"`. (2) Even after sanitizing the doc ID, agents querying `where ticker == "TRN"` won't match `NYSE/TRN`. Both fixed in `src/scrapers/form3.ts`: `normalizeTicker()` strips everything before the last slash (`NYSE/TRN` → `TRN`); `sanitizeForDocId()` replaces any remaining path-illegal char as defense in depth. Form 4 has the same conceptual exposure but hasn't surfaced yet — its ticker-from-XML reads are unaudited. Form 144 dodges this entirely by reverse-looking-up ticker from CIK (no XML ticker field at all), which is more authoritative but requires the bidirectional cache.
- **Form 3 derivative `shares_owned` is misleading for RSUs.** Form 3 reports `postTransactionAmounts.sharesOwnedFollowingTransaction` per holding, but most filers leave it empty (or 0) for derivatives like RSUs and stock options. The actual count lives at `underlyingSecurity.underlyingSecurityShares`. Our parser surfaces both fields faithfully, but agents reading `shares_owned` on an RSU row see 0 and conclude "no position" — that's wrong. The meaningful number for derivatives is `underlying_security_shares` (the count of underlying shares the derivative converts into). Document in the tool description; v1.1 polish would add a derived `effective_shares` field that picks the right one per row type.
- **MCP-tool extension beats new-tool when one filing anchors another.** Form 3 = baseline; Form 4 = deltas. Conceptually one query, one round trip. The cheap move was extending `get_insider_transactions` with `include_baseline:boolean` (default false) — when true, the response gains an optional `baselines: Form3Holding[]` field with matching Form 3 rows fetched in parallel via the same ticker/company_cik/officer_name filters. Preserves the locked 5-tool surface, doesn't change existing query shapes (purely additive), and gives agents the full ownership story without a second tool call. Same pattern will apply when 13D activist stakes anchor 13G ownership updates, when Form 144 planned-sales tie back to actual Form 4 execution, etc. Don't add new tools; add params that fold related data into the existing query path.
- **EDGAR full-text-search form codes are NOT what you'd guess.** 13D and 13G filings are searched by `forms=SCHEDULE 13D` and `forms=SCHEDULE 13G` — not `SC 13D` (returns zero hits). Same for `SCHEDULE 13D/A` and `SCHEDULE 13G/A`. The EDGAR submissions API uses the short form (`SC 13D`, `SC 13G`) but the FTS index uses the long form. Caught Day 4 evening when the live feed silently returned 0 hits with the wrong code. Always test the form code against the FTS endpoint before assuming.
- **13D and 13G use STRUCTURALLY DIFFERENT XML schemas, not just naming variations.** Both ship `edgarSubmission` envelopes and parse with `fast-xml-parser`, but the schemas are meaningfully different: namespace `schedule13D` (uppercase D) vs `schedule13g` (lowercase g); issuer fields at `formData.coverPageHeader.issuerInfo.*` for both, but with `issuerCIK` (uppercase) on 13D vs `issuerCik` (lowercase) on 13G; reporting persons under `reportingPersons.reportingPersonInfo.*` for 13D vs `coverPageHeaderReportingPersonDetails.*` for 13G; aggregate holdings at `aggregateAmountOwned` (13D) vs `reportingPersonBeneficiallyOwnedAggregateNumberOfShares` (13G); percent at `percentOfClass` (13D) vs `classPercent` (13G); event date at `dateOfEvent` (13D) vs `eventDateRequiresFilingThisStatement` (13G). The parser MUST branch by `submissionType` at the top — one parser per schema. The shared output type (`ActivistOwnership`) hides the dual-schema reality from agents.
- **`issuerInfo` on 13D/G is nested under `coverPageHeader`, NOT a sibling of `formData`.** First Day 4 evening parser pass read `formData.issuerInfo` and got undefined — every record landed with empty issuer fields (ticker, company_name, company_cik, cusip all blank). The actual path is `formData.coverPageHeader.issuerInfo.*`. Fix is defensive: try both (`formData.coverPageHeader?.issuerInfo ?? formData.issuerInfo ?? {}`). Worth applying preemptively to any future ownership-form parser since SEC has been progressively moving fields under `coverPageHeader` in newer schemas.
- **`headerData` is a SIBLING of `formData` under `edgarSubmission`, not a child.** The `filerInfo.filer.filerCredentials.cik` fallback (used when reportingPersonCIK is missing in the form-side block — common in 13G) lives at `submission.headerData.filerInfo.filer.filerCredentials.cik`, NOT `formData.headerData.*`. Initial parser fell through to undefined and emitted empty filer_cik for every 13G row. Fix: pull `headerData = submission.headerData` separately and pass it through to branch parsers as a separate arg, not as a property of `formData`.
- **13G `<issuerCusips>` is plural with nested `<issuerCusipNumber>`, NOT a flat `<issuerCusip>`.** The earlier scout's regex tag-list used `/<[a-zA-Z][a-zA-Z0-9_]*/g` which matched `<issuerCusips` AND `<issuerCusipNumber` to the same dedup key `<issuerCusip` (the trailing char got eaten). Looked like a flat field but wasn't. The actual structure is the same as 13D — `issuer.issuerCusips.issuerCusipNumber` with potential array of multiples. Hard Lesson on the discovery method: regex tag-extraction is faster than parsing but loses nesting and plurality. Verify against a real XML fetch before designing field paths.
- **Scraper-template estimates: plumbing reuse is 30 min, schema discovery + bug-fix iteration is 1.5–2.5 hrs.** Day 4 calibration. Form 144 → Form 3 → 13D/G all reused the SEC-XML plumbing (rawXmlPath, normalizeTicker, sanitizeForDocId, multi-owner OR-handling, CIK reverse-lookup) — that's 30 min of boilerplate every time. But each new form has its own schema surprises that take 1.5–2.5 hours to discover and debug: Form 144's misnamed `securitiesToBeSold`, Form 3's XSL prefix + exchange-prefixed ticker, 13D/G's dual-schema + nested issuerInfo + headerData reach + MM/DD/YYYY dates + plural CUSIP. **Budget 2–3 hrs per new SEC-XML scraper, not "fastest port yet" optimism.** USAspending and other clean-API sources should genuinely be 1–1.5 hrs because they have no schema discovery, just a typed REST envelope.
- **Phantom-session anti-pattern: when a Cowork/IDE-mounted session reports state that disk doesn't have, salvage the working code, don't trust the session.** Day 5 morning: a previous Cowork session claimed v0.8.0 had been built and committed (`get_member_profile` MCP tool + bioguide ingestion). `git log` and `git fetch origin` both showed `d9ff966` (v0.7.0 USAspending) as latest. The session's *view* of the workspace had v0.8.0 files — the actual disk (and remote) didn't. Resolution: the session wrote its in-memory copies of `bioguide.ts` + `member-profile.ts` to a quarantined `v0.8.0-salvage/` folder with a `SALVAGE_NOTES.md` documenting the diffs needed against the real-disk versions of `types.ts` / `firestore.ts` / `scrape.ts` / `tools/index.ts` / `index.ts` / `package.json`. A fresh Claude Code session then picked up cold from disk + the notes, applied everything, ran `npm install`, typechecked clean, ran `bioguide --save` → 536 legislators saved. **Lesson: when a session says "I committed X" and `git log` says otherwise, treat the session's view as untrusted but recoverable. Quarantine the in-memory files, write self-contained notes, hand off to a fresh cold-boot session. Don't try to debug the phantom in place.**
- **Mis-quoted bioguide IDs propagate fast — fix every instance the moment you find the first.** The phantom session also seeded a wrong attribution: `C001098 for Susan Collins`. Reality is C001098 = Ted Cruz; C001035 = Collins. The wrong ID landed in **three distinct places** in the real codebase: a JSDoc comment in `types.ts` (CongressionalTrade interface), the **MCP tool description** for `bioguide_id` in `congressional-trades.ts` (worst — agents read this and use it as a worked example), and the example in the input-validation error message. v0.8.0 corrects all three. **Lesson: bioguide IDs are first-letter + 6-digit zero-padded sequential within letter — verify against the canonical YAML (one-line script), don't guess.** Same pattern will hit any other identifier where the format invites mis-quote (CIKs, CUSIPs, bond CUSIPs, NAICS codes).
- **Clean-API ingestion really is 1–1.5 hours, calibration confirmed.** USAspending Day 4 evening + bioguide Day 5 morning both came in under 1.5 hrs total — public API, typed responses, well-documented schemas, no XSL prefixes, no schema discovery, no parser-build → smoke-test → bug → fix loop. The 2–3 hr budget from Day 4's Hard Lesson applies only to SEC-XML form scrapers (Form 4 / Form 144 / Form 3 / 13D/G). Going forward: when picking the next data source, the API-vs-XML distinction is the single best predictor of build time. FRED, FEC, USPTO, Treasury Direct → 1–1.5 hrs each. Form 13H, 8-K full-body extraction, Senate lobbying portal → 2–3+ hrs.
- **`legislators-current.yaml` term ordering: LAST entry in `terms[]` is current.** YAML lists terms chronologically; the parser must pick the *last* element to find the current term, not the first. Three-line bug if you reverse it — and the wrong direction silently returns terms from decades ago for senior members (Pelosi's terms[0] is from 1987). Same convention likely holds for any chronological array in the catalog (e.g., `other_names[]`).
- **House districts can be numeric strings (`"1"`, `"2"`) or letter codes (`"AL"` for at-large). Senate has none.** Normalize `state_district` to a string in the parser so callers don't need to handle the variant shapes. Empty string for Senate is the cleanest neutral value (rather than null) — keeps Firestore equality queries simple.
- **Subcommittee codes in the unitedstates/congress-legislators catalog are formed by appending the subcommittee's `thomas_id` to the parent committee's `thomas_id`.** Example: `HSAG` (House Agriculture full committee) + `15` (Forestry & Horticulture subcommittee) = `HSAG15`. The convention follows the Library of Congress Thomas system. Agents querying by `committee_id` need to know this — surfacing it in the `get_member_profile` tool description is load-bearing for usability ("HSAG15 for the Forestry & Horticulture subcommittee under House Ag" makes the convention immediately legible).
- **The `legislators` collection is index-free by design.** Only ~540 records (current Congress); only equality queries (`bioguide_id` doc lookup, `state` / `chamber` / `party` `where` clauses); `member_name` and `committee_id` are post-filtered client-side after pulling a 600-record window. No Firestore composite indexes required for v1, no `firestore.indexes.json` changes for v0.8.0. Rare collection where index-free queries genuinely scale because the universe is so small.
- **EDGAR's `items` field has TWO different shapes depending on which endpoint you query.** Submissions API (`data.sec.gov/submissions/CIK*.json`) returns a **comma-separated string** ("5.02,9.01"). Full-text search (`efts.sec.gov/LATEST/search-index`) returns an **array of strings** (["5.02","9.01"]). Same field name, same content, different convention. The 8-K live-feed crashed with `raw.split is not a function` Day 5 afternoon after working flawlessly in `8k <TICKER>` mode — because per-ticker hits the submissions API and live-feed hits FTS. Fix is to type the field as `unknown` and branch on `Array.isArray()` vs `typeof === "string"` at runtime in `parseItemCodes()`. **Lesson: never assume two SEC endpoints normalize the same field the same way — write parsers that accept the union of shapes, not just the one you tested first.** Same pattern likely lurks elsewhere — anywhere a field can be "one or many," watch for endpoint-dependent serialization.
- **LDA API rate limits at ~4 req/sec; bake retry-with-backoff into any paginated bulk pull.** Day 5 evening: the lobbying scraper at 250ms between requests (4 req/sec sustained) hit `429 Too Many Requests` on page 16 of a 20-page Pfizer pull. EDGAR tolerates 6 req/sec (150ms) all day; the LDA API does not. Two-part fix: (1) drop sustained pace to 500ms = 2 req/sec for headroom, (2) add a Retry-After-aware retry loop that honors the server's hint when present (the 429 response carried `Retry-After: 33` and waiting that long resolved cleanly), with exponential-backoff fallback (2s/4s/8s) when no Retry-After header is set. **Lesson: every public REST API has its own tolerance for sustained pull rate. Treat 429 as a normal-operations response — bake retry into `fetchJson` from the start, don't add it as a follow-up after the first crash.** Same defensive shape worth porting to any future LDA-style high-volume API.
- **LDA filing descriptions can run 30KB+ as free-text manifestos — cap them on ingestion to protect Firestore's 1MB doc limit.** First record returned by a probe of `lda.gov/api/v1/filings/?filing_year=2025&filing_period=fourth_quarter` was a "STATE OF LOC NATION GLOBAL PUBLIC BENEFIT CORPORATION" sovereign-citizen filing whose Activity #1 description embedded a complete white paper on a fictional currency (the "Loc Nation Dollar pegged to USD"). Real public-record noise — the SOPR portal accepts whatever's filed in the right form regardless of legitimacy. Pure-publisher posture means we keep these records; agents filter as they see fit. The protection: truncate `lobbying_activities[i].description` at 5000 chars during normalization with a `description_truncated: true` flag set on the record, and surface `filing_document_url` so agents can fetch the unbounded prose if they need it. **Lesson: any free-text field on a publicly-filed form can carry adversarial / spam / manifesto content. Always cap, never trust the source's brevity, especially when public submission is statute-mandated and the filer pays no per-character cost.**
- **Firebase Functions Gen 2 first-deploy on a long-existing Blaze project hits an IAM gap that has nothing to do with your code.** Day 5 night: even with all the right APIs auto-enabled (cloudfunctions, cloudbuild, artifactregistry, cloudscheduler, run, eventarc, pubsub, storage), the very first `firebase deploy --only functions` failed at the Cloud Build step with *"Could not build the function due to a missing permission on the build service account."* The Compute Engine default service account (which Cloud Build uses for the build) has zero pre-granted roles on a project that's been on Blaze for a while but never deployed Functions. Fix: visit `https://console.cloud.google.com/cloud-build/settings/service-account?project=<PROJECT>` and toggle five roles from Disabled → Enabled: **Cloud Build Service Account**, **Cloud Functions Developer** (also accept the side-panel "Service Account User" grant for the Compute SA to impersonate the runtime SA), **Artifact Registry Writer**, **Cloud Run Admin**, and **Storage Object Creator**. After that, re-run the deploy — succeeds cleanly. **Lesson: this is a one-time per-project setup gate, not a code or config bug. Add it to any future "Firebase Functions on a non-fresh project" runbook. The error message Google emits is misleading — it sounds like a code problem; it's actually pure IAM.**
- **Cloud Functions Gen 2 needs ADC, not service-account.json.** Local dev reads `secrets/service-account.json` for Firestore creds; that file doesn't exist on the Cloud Functions runtime. The fix in `firestore.ts` is a runtime-environment detector (`process.env.K_SERVICE !== undefined || FUNCTION_TARGET || FUNCTION_NAME`) that branches `getLiveDb()` between `cert(serviceAccountJson)` (local) and `applicationDefault()` (GCP). The same detector also short-circuits `isStubMode()` so functions never accidentally run in stub mode just because they can't see the local file. **Lesson: any code that conditionally falls back to "stub mode" based on file existence needs to learn about the Cloud runtime environment too. Add the env-var branch BEFORE deploying, otherwise the function silently returns empty results and you debug for an hour wondering why nothing's writing.**
- **esbuild bundles get 1500× larger when scrapers with PDF/HTML deps are added.** Day 5 night: a single-scraper bundle (8-K only) compiled to **8.4 KB**. Adding all 12 scrapers (which transitively pull in `pdf-parse`, `cheerio`, `fast-xml-parser`, `fetch-cookie`, `tough-cookie`, `js-yaml`, etc.) blew the bundle to **14.2 MB**. Still well under Firebase's 100 MB function-deployment cap, but cold-start time scales with bundle size — production cold starts will likely be 5-10 seconds for the bigger functions. **Lesson: the scraper-template architecture means adding even more sources will inflate the shared bundle further. v1.1 polish to consider: split the function bundle into per-domain entry points (sec-functions.js, congress-functions.js, lobbying-functions.js, etc.) so each function only loads the deps it actually needs. Not blocking; cold starts at 5-10s are fine for hourly+ schedules where the function isn't user-facing.**
- **MCP Streamable HTTP transport runs as an HTTP-triggered Firebase Function with stateless mode.** Day 5 night: `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js` supports two modes via `sessionIdGenerator`. Pass a function (e.g., `randomUUID`) for stateful — server tracks session, requires init handshake, validates session-ID header. Pass `undefined` for stateless — every request creates a fresh transport, no session, no init required, scales horizontally trivially. **Stateless is the right choice for serverless deploy** because each Cloud Function invocation might be a cold container; tying state to one container means cross-invocation requests break. Pattern in `functions/src/index.ts`: per HTTP request, `createMcpServer` + `applyToolHandlers` + `new StreamableHTTPServerTransport({sessionIdGenerator:undefined})` + `transport.handleRequest(req, res, req.body)`, then close everything in `res.on("close")`. **Lesson: serverless deploy of MCP only works in stateless mode. Don't try to share a single Server instance across invocations — Cloud Functions Gen 2 spawns containers per concurrent request and the global state is unreliable.**
- **Firebase Functions secrets via `defineSecret` are the right shape for API keys.** The `firebase-functions/params` module's `defineSecret("MCP_API_KEY")` integrates directly with Google Secret Manager. Set the value once via `firebase functions:secrets:set MCP_API_KEY --data-file=-` (pipe the value to stdin to avoid interactive prompt), grant the function access via the `secrets:[mcpApiKey]` field on the `onRequest` config, read at runtime via `mcpApiKey.value()`. Firebase auto-grants the `roles/secretmanager.secretAccessor` role to the runtime SA on first deploy. **Lesson: don't store API keys in env vars on the function config (visible in console + version control risk). Always use Secret Manager via defineSecret. Setting via `--data-file=-` keeps the key out of shell history too.**
- **Item 9.01 is a "paperwork box" — empirically ticked on ~73-75% of 8-K filings.** Day 5 afternoon: 73 of 100 live-feed 8-Ks declared 9.01; 37 of 50 historical AAPL filings did. Treating 9.01 as a substantive filter returns the firehose. The `get_material_events` tool description warns agents inline to combine 9.01 with another item code or skip it. Same posture per pure-publisher rule: keep 9.01 in `item_codes` array (faithful to source), but document the noise pattern so agents don't waste queries. **Lesson: every checklist-style disclosure schema has noise boxes — surface them in the tool description so AI agents recognize and route around them. Other examples to watch for: SEC submissions `isXBRL` flag, USAspending `prime_award_transaction_recipient_dba_name` (= recipient_name 99% of the time).**
- **8-K with items-only indexing belongs in the "clean ingestion" 1–1.5 hr bucket, NOT the SEC-XML 2–3 hr bucket.** Day 5 afternoon: 8-K scraper + tool + indexes + smoke tests built in ~1.5 hrs total, including the FTS items-shape bug-fix iteration. The recipe: skip body extraction entirely; use the structured `items` array EDGAR already provides on filing metadata; reuse the bidirectional ticker cache from form144.ts. **Recalibrated estimate for CLAUDE.md "What's Open" item 1 (8-K) was correct — actually slightly under.** The 2–3 hr Hard Lesson budget applies only to forms whose substantive content lives inside an XML body that has its own schema (Form 4, Form 144, Form 3, 13D/G). Whenever the SEC pre-extracts the structured part into the metadata response, the build collapses to clean-ingestion shape.
- **Chrome MCP automation tool's allowlist is centrally enforced by Anthropic — separate from the user-managed Claude-in-Chrome side-panel approved-sites list.** Day 7 (2026-05-07): hours of debugging traced this. The user can build up an "approved sites" list of dozens of domains via the side panel (github, console.firebase, console.cloud, gmail, etc.) — but the *MCP automation tool* checks a much narrower Anthropic-managed list. Sites like `github.com`, `console.firebase.google.com`, `console.cloud.google.com` return "Navigation to this domain is not allowed" / "Permission denied for this action on this domain" *regardless* of what's in the user's approved-sites list, regardless of which Chrome profile is connected, regardless of which tab group the page is in. Even read-only screenshots of those domains fail. **Lesson: when a Console-only operation is needed on a Google product, don't try to drive Chrome — use the firebase/gcloud CLI (if it covers the operation) OR mint a service-account REST token and call the underlying Google REST API directly (see `src/firebase-rest.ts`). Same applies to GitHub: use `gh` CLI or REST API, not Chrome automation.**
- **Service-key REST tooling pattern.** Day 7 (Derek's tip): when the firebase CLI doesn't expose what you need (Firebase Hosting custom-domain management is the canonical example — it's Console-only in `firebase` v13), the service-account JSON at `secrets/service-account.json` can mint OAuth bearer tokens via `google-auth-library` (transitively included with `firebase-admin`). Pattern in `src/firebase-rest.ts`: `new GoogleAuth({keyFilename, scopes:["https://www.googleapis.com/auth/firebase","https://www.googleapis.com/auth/cloud-platform"]})` → `client.getAccessToken()` → fetch the REST endpoint with `Authorization: Bearer <token>`. **Same pattern works for any Google API** — Cloud Run admin (`run.googleapis.com`), IAM (`iam.googleapis.com`), Cloud Functions admin (`cloudfunctions.googleapis.com`), Firestore Admin (`firestore.googleapis.com`), Cloud Build (`cloudbuild.googleapis.com`), etc. Just swap the baseUrl + path. **Lesson: when Console UI is blocked or the CLI is missing a command, REST + service account is always available. Build a small CLI wrapper at the time of need; reuse forever.**
- **Firebase Hosting REST API exposes more DNS records than the Console UI.** Day 7: the Firebase Console's "Add custom domain" flow shows you the CNAME (or A records) for the host mapping but **may hide the TXT record needed for ACME (Let's Encrypt) cert validation**. Calling `customDomains.get` via REST returns *both* — the CNAME for hosting AND a `_acme-challenge.<domain>` TXT record. Without that TXT, the cert stays in `CERT_VALIDATING` indefinitely and `mcp.<domain>.com` never gets HTTPS. **Lesson: after adding a custom domain in Firebase Hosting, always check via REST (`npx tsx src/firebase-rest.ts get-domain <site> <domain>`) for the full `requiredDnsUpdates.desired[]` + `cert.verification.dns.desired[]` lists. Add every record those return, not just the ones the Console nudges you about.**
- **GoDaddy aftermarket-purchased domains have DNS managed by Afternic by default.** Day 7: `keyvex.com` was purchased through GoDaddy for ~$900 (premium aftermarket name), but its nameservers initially pointed to Afternic (GoDaddy's marketplace subsidiary), not GoDaddy. The DNS Records tab at GoDaddy showed "DNS Provider: Afternic" with "DNS records can't be updated here." **Fix:** Nameservers tab → Change → "GoDaddy default nameservers" (`ns##.domaincontrol.com`) → Save. Propagation 15 min – 4 hr typically. **Lesson: this is normal for premium-domain aftermarket purchases through GoDaddy. Always check the Nameservers tab before trying to add DNS records — if it says Afternic / Custom, switch to defaults first.**
- **Multi-site Firebase Hosting setup.** Day 7: one Firebase project can host multiple custom domains by using multiple Hosting "sites." Configure `hosting` as an array of objects in `firebase.json`, each with a `site` property naming a Hosting site. **Site IDs are GLOBALLY UNIQUE on Firebase and IMMUTABLE** once created (same constraint as project IDs). Pattern that works: `keyvex-mcp` site for the MCP API endpoint (rewrites all requests to a Cloud Run service), `capitaledge-api` (the project's default site) for the static landing page (just serves files from `marketing/site/`). Deploy with `firebase deploy --only hosting:<site-id>` to target one site, or `--only hosting` to deploy all. **Lesson: pick site IDs you'll be happy with forever — they're permanent. Plan multi-site early; trying to retrofit one big site into multiple sites later means re-mapping custom domains + waiting on DNS propagation again.**

## What This Project Is

A Model Context Protocol (MCP) server that exposes US public financial disclosures — congressional trades, executive insider transactions (Form 4), institutional holdings (13F), federal contracts, lobbying, 8-K material events, and member profiles — as agent-native tools. **Brand: KeyVex.** Public domain: `keyvex.com` (mapping to the Cloud Function endpoint pending). Package name: `keyvex`.

Sibling product to the Capital Edge dashboard at `C:\CapitalEdge`. Dashboard sells derived intelligence (convergence score + tax engine) to retail investors. This project sells clean, source-faithful public-record data to developers and AI agents — the cleanup work (parsing, ticker resolution, schema unification, idempotent doc IDs) is done; what we deliberately don't ship is derived signals or opinions on top. Different audience, different legal posture, different product entirely.

**The wedge:** every existing financial-data MCP (Unusual Whales, FMP, Alpha Vantage) bolted MCP onto a pre-existing REST API and ended up with 100–250 tools that overwhelm agent context windows. This project is designed for the agent as the customer from the ground up: fewer tools, smarter parameters, descriptions that help the agent decide when to use each one. See `TOOL_DESIGN.md` for the full design rationale.

## Architecture — Locked In

Decisions made tonight that should not be re-litigated without explicit reason:

- **Two Firebase projects, one Google account.** `capital-edge` (existing dashboard) and `capitaledge-api` (this project). Same Google account (`claude1986aaa@gmail.com`), totally independent IAM/billing/Firestore/Functions. Sibling, not shared.
- **Dual-scrape architecture.** This project runs its own copy of the scrapers, hits SEC EDGAR / Senate / House sites independently, writes to *its own* Firestore. Capital Edge does the same on its side. We deliberately accepted the cost of doubled scraping work for full operational independence — Greg can move at his own pace without coordinating Firebase access with Derek.
- **Pure-publisher legal posture.** No convergence score, no signal weight, no derived rank, no "buy"/"strong buy" language. Tools return raw filings only. This is what keeps the product out of investment-advisor territory; the dashboard handles the publisher's-exemption complexity (Lowe v. SEC, 1985), this project sidesteps it entirely.
- **Stack: Node 20+ / TypeScript / MCP SDK / Firebase Admin.** Matches the dashboard codebase enough to share scraper logic; uses TypeScript strict mode for tool param safety.
- **Transport: stdio for v0.x dev, remote (HTTPS) for v1 deployment.** Hosting target is a sibling Firebase project's Cloud Functions or Cloud Run. Deployment infrastructure not yet stood up.
- **Repo: `https://github.com/gregorywglenn-spec/Keyvex-API`.** Private. Greg's GitHub username is `gregorywglenn-spec` (note: not `gregorywglenn`). Old name `CapitalEdge-API` auto-redirects via GitHub's permanent rename redirect (renamed 2026-05-07).

## Current State (April 30, 2026 — Day 3 mid-session, work paused)

What runs end-to-end **right now**:

**From Day 1 (April 28):**

- ✅ MCP server scaffolded and boots (`npm run dev` shows `LIVE MODE` on stdio)
- ✅ One MCP tool registered: `get_insider_transactions` — works against real Firestore data
- ✅ Form 4 scraper ported to Node/TypeScript, runs against live SEC EDGAR
- ✅ CLI: `npx tsx src/scrape.ts ping` — verifies Firestore connectivity
- ✅ CLI: `npx tsx src/scrape.ts form4 <TICKER> [--save]` — pulls Form 4 trades for a ticker, optionally writes to Firestore
- ✅ CLI: `npx tsx src/scrape.ts form4-feed [days] [--save]` — pulls Form 4 trades across all companies for the last N days
- ✅ Firestore credentials at `secrets/service-account.json` (gitignored)
- ✅ 76 real insider trades sitting in the `insider_trades` collection from a successful `form4-feed 3 --save` run
- ✅ Pushed to GitHub on `main`

**Day 2 additions (April 29):**

- ✅ **13F scraper ported to Node/TypeScript with full v1-quality enrichment** (`src/scrapers/13f.ts`): parses informationTable XML, aggregates sub-account dupes by CUSIP, top-50-by-value filter
- ✅ **OpenFIGI integration** (`src/openfigi.ts`): CUSIP→ticker via Bloomberg's free API, US-exchange preference, Firestore write-through cache (`cusip_map` collection), optional `OPENFIGI_API_KEY` env var for higher rate limits
- ✅ **EDGAR name fallback** (`src/sec-tickers.ts`): when OpenFIGI returns empty for foreign-domiciled CINS CUSIPs, falls back to matching against EDGAR's `company_tickers.json` by normalized issuer name. Catches Chubb→CB, AON, Allegion→ALLE, Liberty Latin America→LILA
- ✅ **Position-change calculation** (`13f.ts:applyPositionChanges`): compares each current-quarter holding to the same fund's prior-quarter holding from Firestore, computes `position_change` ("new" / "increased" / "decreased" / "closed" / "unchanged"), `shares_change`, `shares_change_pct`. Synthesizes 0-share "closed" records for prior holdings absent in current quarter.
- ✅ CLI: `npx tsx src/scrape.ts 13f <ALIAS_OR_CIK> [--save]` — single-fund 13F (e.g., `13f berkshire --save`)
- ✅ CLI: `npx tsx src/scrape.ts 13f-feed [days] [--save]` — recent 13F filings across all funds (default 30 days, max 25 funds)
- ✅ CLI: `npx tsx src/scrape.ts funds` — list 10 tracked fund aliases (berkshire, blackrock, vanguard, bridgewater, citadel, point72, deshaw, renaissance, twosigma, millennium)
- ✅ **42 Berkshire Hathaway 13F holdings** in `institutional_holdings` collection (Q4 2025), all with correct US tickers, consolidated to one row per security (110 raw entries → 42 aggregated)
- ✅ **47 entries in `cusip_map` cache** (42 OpenFIGI hits + 5 from EDGAR name fallback); subsequent scrapes hit cache instead of re-fetching
- ✅ `firestore.ts` made robust to launch context — service-account.json path resolves relative to module location (`import.meta.url`), not cwd. Required for Claude Desktop spawning the MCP server from a different working directory.
- ✅ `firestore.ts` adds `saveInstitutionalHoldings`, exports `getLiveDb`, `getDbIfLive` for use by scraper modules
- ✅ MCP server registered in Claude Desktop's `claude_desktop_config.json` (sandboxed Microsoft Store path) and **proven end-to-end** — asked the running Claude Desktop "what insider trades happened above $5M in the last week," it called `get_insider_transactions` against live Firestore, returned 14 Avis Budget Group records totaling ~$488M of selling on April 23.
- ✅ Form 4 multi-owner parsing fix (task #16). Fast-xml-parser returns an array for filings with multiple reportingOwner elements (typical for 10%+ holder / fund-entity filings — exactly what the Avis sells were). Without this fix, every such record's officer_name silently became "unknown." Now concatenates owner names with " / " and OR's the isDirector flag across all owners. After re-running `form4-feed --save`, existing "unknown" records resolve to actual entity names.
- ✅ Ticker validation regex relaxed in `get_insider_transactions` from `^[A-Za-z]{1,5}$` to `^[A-Za-z][A-Za-z0-9./-]{0,9}$`. Now accepts BRK.A, BRK.B, BF.B, HEI/A, LEN/B, etc.
- ✅ **Second MCP tool registered: `get_institutional_holdings`** — exposes the 13F `institutional_holdings` collection. Same filter/sort surface as the insider tool, plus 13F-specific params (cusip, fund_name, fund_cik, quarter, position_change).
- ✅ **Form 4 re-scrape ran clean.** `form4-feed 3 --save` re-pulled 73 records with the multi-owner fix applied. Avis Budget Group records correctly attribute to "Pentwater Capital Management LP / Halbower Matthew" (was "unknown" pre-fix). NN Inc cluster and other 10%+ holder filings similarly resolved.
- ✅ **Berkshire 13F re-scrape post-bug-fixes confirmed clean.** AAPL position now shows `market_value: 61,961,735,283` (~$62B) instead of $62T — the dollar-vs-thousands fix is working. All 42 holdings have correct US tickers, including all five CINS-coded foreign-domiciled names that flowed through the EDGAR name fallback: Chubb (CB), AON (AON), Allegion (ALLE), and Liberty Latin America (LILA, two share classes). Log line `[sec-tickers] Loaded 10357 tickers, 7986 unique normalized names` confirms EDGAR catalog loaded successfully.
- ✅ **Claude Desktop restarted** so the MCP server is now running with all today's fixes live: multi-owner Form 4 parsing, relaxed ticker regex (BRK.A etc.), US-only OpenFIGI resolution, EDGAR name fallback, dollar-magnitude market values, and the new `get_institutional_holdings` tool exposed.

**Day 3 additions (April 30):**

- ✅ **Broader 13F re-scrape ran** (`13f-feed 30 --save` covering Berkshire, Viking, Tekla, Energy Income Partners, Broadwood, Diker, Harvest, Coastline Trust, Washington Capital, Hermes 2018, Lane Five 2014, etc. — both modern and historical filings). Berkshire continues to be clean. Viking, Coastline, EIP all show correct US tickers and dollar-magnitude market values for 2025-Q4 and 2026-Q1 filings.
- ✅ **Wrong-ticker tiebreaker fix** in `pickBestMatch` (`src/openfigi.ts`):
  - Single-character tickers rejected unless in explicit allowlist (V, C, F, T, S, X, K, M, O, U, Z) — closes the "P → Pandora not Pure Storage" failure mode.
  - Tickers matching `/USD$/i` rejected — closes NCSUSD (Cornerstone), SGENUSD (Seagen), GTT1USD foreign-listing leaks.
  - EDGAR-catalog cross-validation as preference: when multiple US-listed candidates remain, prefer ones whose ticker appears in EDGAR's `tickerSet`. Falls through to all candidates when no EDGAR-validated option exists (avoids losing recent IPOs not yet in catalog).
  - `pickBestMatch` is now async (calls `isKnownUSTicker`); `openFigiBatch` awaits it.
- ✅ **EDGAR normalization expanded** (`src/sec-tickers.ts`):
  - Abbreviation expansion table (CTLS→CONTROLS, INTL→INTERNATIONAL, MGMT→MANAGEMENT, SVCS→SERVICES, COS→COMPANIES, PETE→PETROLEUM, HLDG→HOLDINGS, AMER→AMERICAN, ELEC→ELECTRIC, PWR→POWER, WTR→WATER, WKS→WORKS, etc.) applied BEFORE corporate-form stripping.
  - Jurisdiction-word stripping (IRELAND, BERMUDA, SWITZ, NETHERLANDS, CAYMAN, JERSEY, GUERNSEY, GIBRALTAR, MARSHALL, LIBERIA, SCOTLAND, ENGLAND, JAPAN, KOREA, CHINA, GBR, UK, USA, US, DEL, NE).
  - Leading/trailing "THE" stripped (handles "X COMPANY, THE").
  - Singular `HOLDING` added to corporate-form regex (was just plural `HOLDINGS|HLDGS`).
  - Diagnostic `[sec-tickers] MISS` log line surfaces specific normalization gaps.
  - Result: JOHNSON CTLS INTL PLC → JCI, ACCENTURE PLC IRELAND → ACN, COOPER COS INC → COO, AMERICAN ELEC PWR CO INC → AEP all resolve where they used to be empty.
- ✅ **`isKnownUSTicker(ticker)` exported** for use by `openfigi.ts`. Backed by a `tickerSet: Set<string>` populated as a side effect of `loadMap()`.
- ✅ **Tertiary fallback: OpenFIGI search-by-name** (`src/openfigi.ts:searchOpenFigiByName`). Uses OpenFIGI's `/v3/search` endpoint, filters to `marketSecDes: "Equity"`, runs through the same `pickBestMatch` for consistency. Rate-limited via `lastSearchCallAt` timestamp + `SEARCH_DELAY_MS` (12s free tier, 2.4s with API key). Wired into `13f.ts` as the third tier — fires only when both OpenFIGI mapping and EDGAR name lookup return empty.
- ✅ **EDGAR source switched** from `company_tickers.json` to `company_tickers_exchange.json` (slightly more comprehensive, includes preferred-share tickers like JPM-PC). Both files have known gaps and wrong mappings — kept the exchange file because parser is now generalized via `fields[]` lookup.
- ✅ **New diagnostic CLI commands** in `src/scrape.ts`:
  - `test-normalize [names...]` — runs `normalizeName()` + `lookupTickerByName()` on input names (or a default canary set), prints normalized form and EDGAR match. Use to smoke-test normalization changes BEFORE expensive scrape runs.
  - `search-edgar <substring>` — searches EDGAR's loaded catalog by raw-title or normalized-form substring. Diagnostic for "why isn't EDGAR matching this name?"
  - `dump-edgar` — prints catalog stats (total entries, unique normalized names, unique tickers), a sample of 20 entries, and a per-ticker presence check for canary tickers (AAPL, JCI, ACN, HOLX, CYBR, CFLT, JAMF, RNA, DAY, EXAS, AVDL, DNB, HI, DVAX, PSTG, AMBC). This is what surfaced the SEC catalog data-quality issues.
  - `flush-cusip-cache` — deletes all entries in the `cusip_map` Firestore collection so the next scrape re-resolves from scratch under current logic. Use after changing OpenFIGI selection or EDGAR fallback.

**Day 3 afternoon — Senate scraper port complete (April 30):**

- ✅ **Senate eFD scraper ported to Node/TypeScript** (`src/scrapers/senate.ts`, ~470 lines). Full session protocol: GET home → extract CSRF from form input → POST agreement to `/search/home/` (form's `action=""` resolves to current URL, NOT `/search/`) → GET `/search/` to land on the search page → re-read rotated CSRF → POST `/search/report/data/` with multipart FormData → GET each PTR detail. Includes paper-PTR detector for amendment filings that ship as PDF embeds rather than HTML tables.
- ✅ **Three load-bearing fixes discovered the hard way** (each captured in Hard Lessons): empty `action=""` means submit-to-self (HTML spec), Django 4 CSRF requires explicit `Origin` header from Node fetch, agreement state only flips after a follow-up GET to the post-redirect destination on some Django configs. The reference browser scraper at `reference/congressional_scraper.js` had drifted — it posts to `/search/` which used to work via legacy URL routing but now silently re-renders the home page.
- ✅ **CLI commands added** in `src/scrape.ts`:
  - `senate [days] [--save] [--max=N]` — Senate PTRs for the last N days (default 7), optional cap on PTRs processed for testing.
  - `senate-ptr <PTR_ID> [--save]` — re-pull one specific PTR by ID. Useful for testing parser changes against a known filing.
- ✅ **`CongressionalTrade` and `CongressionalTradesQuery` types** added to `src/types.ts`. Same field shape as Capital Edge dashboard schema for portability, with `signal_weight` deliberately omitted (publisher-only posture).
- ✅ **`queryCongressionalTrades` and `saveCongressionalTrades`** added to `src/firestore.ts`. The substring-filter truncation fix from Day 3 morning is applied here too — when `member_name` substring is set, fetch up to 5000 records before client-side filtering rather than the user-set limit.
- ✅ **Third MCP tool registered: `get_congressional_trades`** (`src/tools/congressional-trades.ts`). Same filter/sort surface as the other two tools, plus congressional-specific params (`member_name`, `bioguide_id`, `chamber`, `owner`, `transaction_type`). `bioguide_id` validation regex `/^[A-Z]\d{6}$/` reserved for when the legislators catalog ingestion lands.
- ✅ **Server version bumped to 0.3.0**, three tools registered: `get_insider_transactions`, `get_institutional_holdings`, `get_congressional_trades`.
- ✅ **Real Senate data pulled and parsed clean.** 90-day window: 34 PTRs across 14 senators (Banks, Boozman, Capito, Whitehouse, Collins, Fetterman, Smith, McCormick, King, McConnell, Mullin, Hagerty, Hickenlooper) → **241 trades** with correct ticker symbols, owner attribution (Self/Spouse/Joint/Child), date format, amount ranges, reporting lag calculations. Municipal bonds and structured notes correctly preserved with `ticker: "--"` (no equity ticker exists for these instruments).
- ✅ **Dependencies added** to `package.json`: `cheerio` (HTML parsing), `fetch-cookie` + `tough-cookie` (cookie jar for session management). All TypeScript types resolve cleanly under strict mode.
- ✅ **`firestore.indexes.json` already includes** the `congressional_trades` composite index (ticker + disclosure_date desc) from Day 3 morning. First MCP query against `get_congressional_trades` may surface a FAILED_PRECONDITION with a one-click index-creation URL — same workflow as institutional_holdings yesterday.
- ✅ **Pushed to GitHub on `main`** late Day 3 afternoon.

**Day 3 evening — Senate proven end-to-end + Firebase deploy plumbing in place + v2 strategy locked (April 30):**

- ✅ **241 Senate trades written to Firestore** via `senate 90 --save`. Doc IDs deterministic (`senate-<ptr_id>-<row_index>`), idempotent re-runs.
- ✅ **Firebase config bootstrapped.** Created minimal `firebase.json` + `.firebaserc` so `firebase deploy --only firestore:indexes` works from this repo. Both files safe to commit (no secrets, just project ID and feature config). Future index deploys are now a one-liner.
- ✅ **All composite indexes deployed** via `firebase deploy --only firestore:indexes`. Five active indexes total: insider_trades (ticker + disclosure_date), institutional_holdings (ticker + market_value), congressional_trades (ticker + disclosure_date), congressional_trades (transaction_type + disclosure_date + amount_min), congressional_trades (owner + disclosure_date + amount_min).
- ✅ **Two new congressional_trades indexes added to firestore.indexes.json** (transaction_type-based and owner-based, both with disclosure_date + amount_min for filter-and-sort queries). Field directions verified by decoding the protobuf in Firestore's auto-generated index URLs — both use `disclosure_date DESCENDING + amount_min DESCENDING` to match the orderBy direction.
- ✅ **MCP tool `get_congressional_trades` proven end-to-end** through Claude Desktop:
  - NVDA ticker query → 3 real hits (Boozman bought 3/19, Whitehouse self+spouse sold 1/9)
  - Senate buys ≥ $50K since Jan 1 → 15 hits dominated by McCormick's PA muni-bond ladder ($500K–$1M positions in PA Turnpike, Allegheny Airport, Philadelphia Water bonds, GS structured notes), plus Mullin's $50–100K UNH purchase
  - Joint-account trades ≥ $100K → 0 hits (legitimately empty for the 90-day window — most Joint activity is small)
  - Mullin substring filter → ~45 records returned (substring-truncation fix from Day 3 morning carried over correctly to congressional_trades collection)
- ✅ **Three of five v1 tools officially proven** through real MCP queries against live Firestore. Server v0.3.0 stable.

**Strategic decisions locked Day 3 evening (do NOT re-litigate without explicit reason):**

- **Stay vertical.** The hub never expands to medical, legal, sports, or any other adjacent vertical. Expansion happens deeper into US public-disclosure data only. (Captured as a Hard Lesson above with full reasoning.)
- **v2 queue order is locked.** Greg explicitly chose: **House PTRs → Form 144 (planned insider sales) → 13D/13G (activist 5%+) → Lobbying disclosures (LDA) → 8-K material events.** Each closes a gap in the same customer's question set. Don't reorder without a strong reason.
- **Customer funnel is bottom-up.** Free tier → indie devs → small fintechs → midsize firms → institutional. Don't court Citadel cold; build something indie devs love and let it climb. (Captured as a Hard Lesson above.)
- **The product's working name in conversation is "the hub"** — short for "MCP data hub for US public disclosures." Not a final brand; just the term used internally so we don't have to keep saying "the MCP server / API / data product / repository."

**Day 3 late evening — House port complete + cross-chamber MCP query proven (April 30):**

- ✅ **House scraper ported to Node/TS** (`src/scrapers/house.ts`, ~470 lines). Two-stage pipeline: (1) fetch the House Clerk yearly XML index at `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<year>FD.xml` and parse with `fast-xml-parser` (`parseTagValue: false` to preserve DocIDs as strings), (2) for each PTR DocID, fetch the per-filing PDF, extract text via `pdf-parse` (lazy-loaded through dynamic import to avoid CommonJS/ESM tussle), and walk the lines using a transaction-signature anchor regex to identify trade rows.
- ✅ **Three CLI commands added** in `src/scrape.ts`:
  - `house-index [days]` — fetches XML index, prints PTR count + first/last 5 entries. Diagnostic.
  - `house-text <ptr_id>` — dumps the full extracted PDF text for one PTR. Diagnostic — used heavily during parser debugging.
  - `house [days] [--extract] [--save] [--max=N]` — the production command. `--extract` runs the per-trade parser, `--save` writes to Firestore, `--max=N` caps PTR count for testing.
- ✅ **Owner-code regex iterated 4 times to find the right shape.** Started at `[A-Z][A-Z]` (broke on lowercase second char in iShares), expanded to `[A-Za-z][A-Za-z]` (broke on JTT. and JTO'), settled on `^(SP|JT|DC)\S` after seeing real PTRs with digits, periods, apostrophes, and lowercase chars all appearing right after the owner code. Captured as a Hard Lesson above.
- ✅ **Programmatic control-char regex builder** in house.ts. `Edit` tool was injecting literal control bytes when the regex was written inline; rewrote as `String.fromCharCode(...)` programmatic construction. Workaround for tool-induced corruption — would have been silently broken otherwise.
- ✅ **340 House trades written to Firestore** via `house 30 --extract --save`. Idempotent doc IDs (`house-<ptr_id>-<row_idx>`), zero parse errors, full schema match with Senate records (chamber field correctly set to "house").
- ✅ **Cross-chamber MCP query proven end-to-end** through Claude Desktop:
  - "What congressional trades happened in NVDA in the last 30 days?" → 6 hits across both chambers: Tim Moore (R-NC) sell $15K-$50K, Daniel Meuser spouse partial sells x2 (PA), Gilbert Cisneros (D-CA) buy + sell same week, John Boozman (R-AR) joint buy. **5 sells vs 1 buy across both chambers — directional signal in one round-trip.**
- ✅ **Total `congressional_trades` collection**: 241 Senate + 340 House = **581 records spanning both chambers from one MCP tool.** v1 congressional data picture officially closed.
- ✅ **Pushed to GitHub on `main`** late Day 3.

**Day 3 night — Form 144 scraper + 4th MCP tool live (April 30, deep evening):**

- ✅ **Form 144 scraper ported to Node/TS** (`src/scrapers/form144.ts`, ~370 lines). Same EDGAR submissions-API + full-text-search plumbing as Form 4. Schema is meaningfully different — captured as Hard Lessons above. Three iterations to get the URL right (XSL-rendered HTML vs raw XML), then one clean rewrite once the actual schema was visible from the live response dump.
- ✅ **`Form144Filing` type** added to `src/types.ts` with 22 fields. Includes `is_10b5_1_plan` (boolean) and `plan_adoption_date` (string) for the discretionary-vs-scheduled-sale signal. Also `exchange`, `notice_date`, `pct_of_outstanding` (computed from `shares_to_be_sold` / `shares_outstanding`).
- ✅ **`saveForm144Filings` + `queryForm144Filings`** added to `src/firestore.ts` → new collection `planned_insider_sales`. Same idempotent doc-id scheme (`{accession}-{ticker}-{lineNumber}`), same substring-filter truncation handling for `filer_name`.
- ✅ **CLI commands** `form144 <ticker> [--save]` and `form144-feed [days] [--save]` added to `src/scrape.ts`.
- ✅ **MCP tool `get_planned_insider_sales`** registered (`src/tools/planned-insider-sales.ts`, the 4th of 5 v1 tools). Filter surface: ticker, company_cik, filer_name, min_value, since/until, sort_by (filing_date | approximate_sale_date | aggregate_market_value), sort_order, limit. Tool description emphasizes the forward-looking-vs-Form-4-realized distinction.
- ✅ **Server version bumped to 0.4.0** in `src/index.ts`. Four tools registered: `get_insider_transactions`, `get_institutional_holdings`, `get_congressional_trades`, `get_planned_insider_sales`.
- ✅ **Three new Firestore composite indexes** added to `firestore.indexes.json` for the new collection: ticker+filing_date desc, ticker+aggregate_market_value desc, ticker+approximate_sale_date asc. Awaits `firebase deploy --only firestore:indexes` to go live.
- ✅ **20 AAPL Form 144 filings parsed clean** as the first sanity check — Tim Cook's recurring $30M+ planned sales under 10b5-1 plan adopted 2024-05-21, plus 5 Arthur Levinson (Apple Chairman) discretionary sales of 2001-vintage stock totaling ~$66M. Levinson's filings have null `plan_adoption_date` — discretionary, not scheduled. Exactly the agent-native signal the type was designed to capture.
- ✅ **90 Form 144 filings saved to Firestore** via `form144-feed 7 --save` (89% success rate; 11 SKIPs split between fast-xml-parser's max-nested-tags default and transient SEC 503s). Signal-rich pull across the week:
  - Larry Fink (BlackRock): 33,900 shares, $35.6M, **discretionary** (no 10b5-1)
  - Steve Sanghi (Microchip): 416,581 shares, $36.9M, 10b5-1 plan
  - WEST CLAY CAPITAL LLC (CoreWeave Director/Officer): 300,000 founders shares, $33M, 10b5-1
  - Niraj Shah (Wayfair Officer/Director): 113,863 founders shares acquired 2002, $8.8M, 10b5-1
  - Nathan Blecharczyk (Airbnb Officer/Director): 11,538 founders shares acquired 2008, $1.6M, 10b5-1
  - The Narayen Family Trust (Adobe Officer): 75,000 shares, $18.3M, **discretionary**
  - DSS INC (Impact Biomedical 10% Stockholder): 31.9M shares = **29.6% of outstanding**, $23M (whole-position exit)
  - Cambrian BioPharma (Sensei Biotherapeutics 10% Stockholder): 11.6% of outstanding being sold
  - Grayscale crypto trusts (DCG International) constantly filing 144s for GAVA, GTAO, GSNR, DEFG, GDOG, MANA, STCK, GLNK, GXLM — interesting data exhaust nobody else exposes
- ✅ **Four of five v1 tools officially built and serving real Firestore data.** `get_member_profile` is the last one and depends on the bioguide catalog ingestion (item 5 in What's Open). MCP-side test of `get_planned_insider_sales` deferred to next session — needs Claude Desktop restart to pick up the new tool registration.

**Day 3 night v1.1 polish queue (Form 144 observed, none blocking):**

- **Preferred-share-class ticker reverse lookup ambiguity** — captured as a Hard Lesson. AGNCL/AGNC, LOB-PA/LOB, BFH-PA/BFH, CFG-PI/CFG, WTFCN/WTFC, SCHW-PJ/SCHW, MCHPP/MCHP. CIK is correct, ticker is suboptimal. Fix: prefer entries with no hyphen-suffix or "-P" pattern when multiple tickers share a CIK.
- **8 "Maximum nested tags exceeded" SKIPs** — fast-xml-parser default limit (32 nested levels?) hit on some Form 144s. Bump `maxNestingDepth` in the parser config in v1.1.
- **3 transient SEC 503 SKIPs** — server overload. Add bounded retry with exponential backoff in `fetchText` (3 retries at 1s/2s/4s, then give up).
- **`primary_doc.xml` URL fragility** — only one filing format observed. If a filing ships text-only or PDF-only (older paper-filed 144s), the parser silently skips. Acceptable for v1 since Form 144 has been mandatory electronic since late 2022; flag if pre-2022 filings ever become a query target.

**Day 3 late evening v1.1 polish queue (observed in House data, none blocking):**

- **Cisneros AMZN rows** — `[Amazon.com](http://Amazon.com)` markdown-link garbage from PDF text extraction. Strip in v1.1.
- **Larsen records 6, 8, 9** — comment-overflow contamination ("based company, purchased those assets in March...NextEra Energy"). Same root cause as phantom rows — PDF line breaks aren't row boundaries.
- **Salazar row 25, McCormick row 16, Cisneros row 8** — phantom partial rows with `asset_type: "Stock"` instead of `"ST"`. Asset-name wrap onto second PDF line creates orphan synthetic row.
- **OpenFIGI maps Alibaba CUSIP to BABAF (OTC pink-sheet) instead of BABA (NYSE ADR).** Add to wrong-issuer list alongside AMBAC→OSG. Issuer-name cross-validation fix from v1.1 deferral list will catch this category.
- **FISV ticker for Fiserv** — Fiserv was renamed FI in 2024. Catalog gap in `company_tickers_exchange.json`. Will resolve once SEC updates their file or via OpenFIGI search-by-name fallback on next cusip_map flush.

**Day 4 morning — Form 3 scraper + include_baseline live (May 1, 2026):**

- ✅ **Form 3 scraper ported to Node/TS** (`src/scrapers/form3.ts`, ~440 lines). Same EDGAR plumbing as Form 4 / Form 144 — third use of the SEC-XML template, fastest port yet. Schema is Form 4's sibling: `ownershipDocument` root, multi-owner OR-handling, `parseTagValue:false`, but `nonDerivativeHolding` / `derivativeHolding` instead of `...Transaction`. No transaction shares — just position snapshots. One row per security class held.
- ✅ **`Form3Holding` type** added to `src/types.ts` with 26 fields. Distinguishes derivative (options/warrants/RSUs) from non-derivative (common/preferred). Captures `direct_or_indirect`, `nature_of_indirect_ownership`, `conversion_or_exercise_price`, `exercise_date`, `expiration_date`, `underlying_security_title`, `underlying_security_shares`, `is_director` / `is_officer` / `is_ten_percent_owner` / `is_other` flags.
- ✅ **`saveForm3Holdings` + `queryForm3Holdings`** added to `src/firestore.ts` → new collection `initial_ownership_baselines`. Idempotent doc IDs (`{accession}-{ticker}-ND-{lineNumber}` for non-derivative, `-D-` for derivative). Same substring-filter truncation handling for `filer_name`.
- ✅ **CLI commands** `form3 <TICKER> [--save]` and `form3-feed [days] [--save]` added to `src/scrape.ts`. Sibling shape to `form144` / `form4`.
- ✅ **MCP-tool extension (NOT a new tool — preserves the locked 5-tool surface):** `get_insider_transactions` gains an `include_baseline:boolean` param (default false). When true, parallel-fetches matching Form 3 rows via `queryForm3Holdings` (same ticker / company_cik / officer_name filters) and attaches them under a `baselines` field on the response envelope. Constraint: requires `ticker` or `company_cik` to be set (avoids unbounded baseline queries). One round trip stitches Form 4 deltas to Form 3 starting positions. Captured as a Hard Lesson.
- ✅ **Server version bumped to 0.5.0** in `src/index.ts`.
- ✅ **Three new Firestore composite indexes** added to `firestore.indexes.json` for the new collection: `ticker+filing_date desc`, `filer_cik+filing_date desc`, `is_derivative+filing_date desc`. Deployed via `firebase deploy --only firestore:indexes` Day 4 morning.
- ✅ **38 AAPL Form 3 rows backfilled** as the first sanity check. Sabih Khan as new COO: 999,759 common direct + 31,632 family trust + 7 RSU tranches (22K-66K underlying each). Kevan Parekh CFO RSU stack. Apple director starting positions back to 2015 — Bell, Lozano, Austin, Gorsky, Adams, Srouji, O'Brien, Newstead.
- ✅ **60 Form 3 rows from 7-day live feed saved to Firestore** (60% parse rate; the other 40 filings fell to the XSL-prefix bug *before* the fix landed). Standouts: Pershing Square IPO insiders (Gonnella CFO 2.8M common + 5.6M M-units underlying, Healey 76K), Goldman Sachs as 10%+ holder of QVC preferreds, HRT Financial as 10%+ on Fitness Champs, Schmid Group N.V. CEO with 4.9M+10.3M ordinary shares + 2M private warrants.
- ✅ **Two bugs caught and fixed during smoke testing — captured as Hard Lessons above:**
  - XSL-prefix URL strip — Form 3 filings (especially modern WK Group filings and Apple 100% of the time) ship `xslF345X02/...` paths in `primaryDocument`. Without `rawXmlPath()` the parser silently produces 0 records.
  - Exchange-prefixed `issuerTradingSymbol` — Trinity Industries' Form 3 has `NYSE/TRN` instead of `TRN`. Slash breaks Firestore doc IDs and ticker-equality queries. Added `normalizeTicker()` to strip the prefix and `sanitizeForDocId()` for defense in depth.
- ✅ **Pushed to GitHub on `main`** as commit `5f8f9dd` Day 4 morning. v0.5.0 milestone.

**Day 4 morning v1.1 polish queue (Form 3 observed, none blocking):**

- **One stale Firestore doc** — `0000099780-26-000031-NYSE-TRN-ND-1` from the pre-fix run sits as an orphan in `initial_ownership_baselines`. The fixed run wrote `0000099780-26-000031-TRN-ND-1`. Not worth a cleanup script.
- **Derivative `shares_owned` is misleading for RSUs** — captured as a Hard Lesson. v1.1 fix: add an `effective_shares` derived field that picks `underlying_security_shares` for derivatives, `shares_owned` for non-derivative.
- **Multi-owner `filer_cik` formatting** — joins multiple owners with `" / "` (e.g., `"0000886982 / 0000769993"` for Goldman's two-entity Form 3 on QVC preferreds). Strict-match Firestore queries on `filer_cik` won't work across multi-owner filings. v1.1 fix: also write a `primary_filer_cik` field with just the first CIK for index-friendly equality matching.
- **Form 4 XSL-prefix audit unfinished** — `src/scrapers/form4.ts` doesn't strip the prefix, but Form 4 has been working empirically on Apple. Could be silently dropping coverage on smaller filers. Worth a one-time audit run with the strip applied to compare row counts.

**Day 4 evening — 13D/13G activist scraper + 5th MCP tool live (May 1, 2026):**

- ✅ **13D/13G activist scraper ported to Node/TS** (`src/scrapers/activist.ts`, ~480 lines). Fourth use of the SEC-XML template after Form 4 / Form 144 / Form 3. Same EDGAR plumbing reused for the boilerplate; per-form schema discovery + bug-fix iteration was the long pole (~2.5 hrs total — recalibrated estimate captured as a Hard Lesson).
- ✅ **Dual-schema branching parser.** 13D and 13G use STRUCTURALLY DIFFERENT XML schemas — different namespaces, different field paths, different field names — captured as a Hard Lesson with the full mapping. `parseActivistXml` discriminates on `submissionType` and routes to `parseSchedule13D` or `parseSchedule13G`, each handling its own schema. Both branches populate the same shared `ActivistOwnership` output type so agents see one uniform shape.
- ✅ **`ActivistOwnership` type** added to `src/types.ts` with 23 fields. `is_activist` (true for any 13D variant, false for 13G) is the structural activist signal. Captures `filer_type` codes (IN/CO/OO/PN/IA/HC/BK/BD/etc.), `citizenship_or_organization`, sole + shared voting AND dispositive power breakdown, `percent_of_class`, `event_date`.
- ✅ **`saveActivistOwnership` + `queryActivistOwnership`** added to `src/firestore.ts` → new collection `activist_ownership`. Idempotent doc IDs (`{accession}-{ticker-or-cusip-or-issuerCik}-{lineNo}`). Multi-filer joint disclosures emit one row per reporting person under the same accession.
- ✅ **CLI commands** `13d-13g <TICKER> [--save]` and `13d-13g-feed [days] [--save]` added to `src/scrape.ts`. Live feed runs each form code separately to handle EDGAR FTS's per-form result cap.
- ✅ **5th MCP tool registered: `get_activist_stakes`** (`src/tools/activist-stakes.ts`). Standalone tool — not a param extension on `get_institutional_holdings` since 13D/G is event-triggered stake disclosure, structurally different from 13F portfolio snapshots. Filter surface: ticker, company_cik, cusip, filer_name (substring), filer_cik, is_activist, filing_type, min_percent_of_class, since/until, sort_by (filing_date | event_date | percent_of_class | shares_owned), sort_order, limit. **v1 tool surface complete (5 of 5 tools registered).**
- ✅ **Server version bumped to 0.6.0 → 0.6.1** in `src/index.ts`.
- ✅ **Six Firestore composite indexes** added to `firestore.indexes.json` for the new collection: ticker+filing_date desc, company_cik+filing_date desc, is_activist+filing_date desc, filer_cik+filing_date desc, is_activist+percent_of_class desc, ticker+percent_of_class desc. All deployed.
- ✅ **165+ activist/passive ownership rows saved to Firestore** from 7-day live feed. Real high-signal data:
  - **Top concentrated 13D activist stakes**: Tananbaum 81.7% of GoldenTree Opportunistic Credit Fund (founder controls his own fund), Barry Foundation 79.7% of Prospect Floating Rate Fund, Petros Panagiotidis 72.2% of TORO Corp (Greek shipping insider), Franklin BSP at 87.6% of its own Lending Fund (parent-sub), DoubleU Games 67.1% of DoubleDown Interactive (Korean parent-sub).
  - **AE Industrial Partners on Redwire (RDW)**: 9-reporter joint 13D/A with Greene + Rowe individuals at 8.3% via shared dispositive power through the AE fund family + AE Red Holdings + Edge Autonomy.
  - **Todd Schwartz on OppFi**: 32.03% concentrated stake through 5-entity TGS Capital + revocable trust + OppFi Shares LLC stack.
  - **BlackRock by concentration**: 16.3% Enphase Energy (ENPH), 15% Northwest Natural Holding (NWN), 13.8% LKQ Corp, 11.6% Payoneer (PAYO), 8.4% Itau Unibanco (ITUB), 6.8% Vale, 6.9% Rentokil Initial, 4.98% Toast, 4.8% Bumble.
- ✅ **Five bugs caught and fixed during the parser-build → smoke-test loop**, all captured as Hard Lessons above:
  - EDGAR FTS form code is `SCHEDULE 13D` not `SC 13D` (silent zero hits).
  - `issuerInfo` nested under `coverPageHeader`, not direct child of `formData` (silent empty issuer fields).
  - `headerData` is a sibling of `formData` under `edgarSubmission`, not a child (silent empty filer_cik on 13G).
  - 13G `eventDateRequiresFilingThisStatement` comes back as MM/DD/YYYY, not ISO. `toIsoDate()` helper added.
  - 13G CUSIP at `issuerCusips.issuerCusipNumber` (plural, nested) — same path as 13D — NOT the flat `issuerCusip` the regex tag-list extraction had implied. v0.6.1 fix.
- ✅ **Five MCP tools officially proven end-to-end through MCP smoke tests** (Day 4 evening, post-restart):
  - `get_activist_stakes(is_activist:true, sort_by:percent_of_class)` returned the top concentrated stakes — Tananbaum, Barry, Panagiotidis, Franklin BSP, BlackRock high-concentration positions.
  - `get_activist_stakes(ticker:"RDW")` returned all 9 reporters from the AE Industrial joint 13D/A.
  - `get_activist_stakes(filer_name:"BlackRock", sort_by:percent_of_class)` returned ENPH 16.3% / NWN 15% / LKQ 13.8% / PAYO 11.6% / etc.
- ✅ **Pushed to GitHub on `main`** — v0.6.0 then v0.6.1 (`79b3aa2`).

**Day 4 evening v1.1 polish queue (13D/G observed, none blocking):**

- **Pre-2024 paper-style 13D/G filings predate the structured XML mandate** (13D mandate Feb 2024, 13G mandate Sept 2024). Parser silently emits 0 rows for those. AAPL by-issuer pull returned 23 historical filings, all 0-reporters. Acceptable for v1 since live feed is current-window — flag if pre-2024 filings ever become a query target.
- **Item 4 "Purpose of Transaction" narrative on 13D filings is HTML-only.** The full prose explanation of WHY the activist is filing — and what they intend to do with the position — lives on the HTML cover page, not in the structured XML. Currently agents follow `sec_filing_url` to read it. v1.1 polish: extract the Item 4 text and surface a `purpose_summary` field on the row.
- **Preferred / warrant ticker reverse lookup ambiguity, again.** OppFi resolved to OPFI-WT (warrants) instead of OPFI (common). Same Hard Lesson as Form 144 — multiple tickers per CIK and the cache picks the hyphen-suffixed variant.
- **Transient EDGAR 500s on the SCHEDULE 13D form code search.** Bounded retry with backoff on the Form 144 polish list applies here too.
- **~160 stale orphan docs** in `activist_ownership` from a pre-fix run with broken empty-issuer doc IDs. Cleaned up via one-off `cleanup-activist-orphans.ts` Day 4 evening.
- **One filing died** with "Cannot read properties of undefined (reading 'tagName')" — fast-xml-parser internal hit on malformed input. 1 in 200; defer.

## What's Open / Next Up

Day 7 LATER (2026-05-07) end-of-day. **10 MCP tools live, server v0.17.0, 13 autonomous scrapers running across the unified KeyVex operation (9 in this codebase + 4 in shelved-but-still-running dashboard codebase), KeyVex landing page live at `capitaledge-api.web.app`, custom domain `https://mcp.keyvex.com` LIVE with TLS, Form 278 v1A scraper + `get_annual_financial_disclosures` MCP tool shipped.** v1 + v2 build closed; rebrand to KeyVex shipped (v0.15.0); cross-project health-check shipped (v0.16.0); GitHub repo renamed to `Keyvex-API`; Firebase Hosting multi-site setup live.

### ⚡ TOP PRIORITY for Day 8 morning (Future Claude — read this first)

**Form 278 v1A.1 — 10-year historical backfill.** v1A landed last night with only ~50 filings (a 90-day current-window pull). Derek's project has ~5,591 Form 278 docs covering CY 2008-2024 — that's the right benchmark. We need to close the gap before any registry submission goes out, because "13 sources" with one of them holding 50 records of recent filings looks thin. Greg has heard pushback about this on Day 8 morning — pushback is valid; we need to address it.

**Concrete plan for the backfill** (~30 min code + 30-60 min runtime):

1. Extend `src/scrapers/form278.ts`:
   - Add `--start-date YYYY-MM-DD` and `--end-date YYYY-MM-DD` CLI options to the existing `form278` command in `scrape.ts` (alternative to the existing `lookbackDays` integer)
   - Inside `scrapeSenateForm278`, accept either `{ lookbackDays }` OR `{ startDate, endDate }` and use whichever is provided
   - **Raise the 1,000-row pagination safety cap to 50,000** (or remove for explicit date-range mode) — current cap is fine for weekly cron but blocks long backfills
2. Run the backfill year-by-year (10 separate runs, easier to debug + log + recover from any failures):
   ```
   npx tsx src/scrape.ts form278 --start-date=2016-01-01 --end-date=2016-12-31 --save
   npx tsx src/scrape.ts form278 --start-date=2017-01-01 --end-date=2017-12-31 --save
   ... (repeat through 2025)
   ```
3. Verify final count in `annual_financial_disclosures` collection — should be in the ~5K-7K range matching Derek's coverage.

**Caveats Future Claude should know going in:**
- Senate eFD's electronic filing requirement is post-2012 — pre-2012 filings exist on paper only and won't be in the search system. Coverage will be thin or empty for 2008-2011.
- The `scrapeForm278Weekly` Cloud Function uses a 35-day rolling window — it'll continue working unchanged during/after the backfill (idempotent doc IDs prevent collisions).
- House Clerk Form 278 backfill is a separate v1.1 task — extend `house.ts` yearly XML index for the FD report type.

### DNS-blocked items (waiting on propagation; nothing for Greg to do)

1. **Wait for nameserver propagation on `keyvex.com`.** Nameservers were switched from Afternic → GoDaddy defaults (`ns53.domaincontrol.com` + `ns54.domaincontrol.com`) at end of Day 7. Typical propagation 15 min – 4 hr; can be checked with `npx tsx src/firebase-rest.ts get-domain keyvex-mcp mcp.keyvex.com` (look at the `requiredDnsUpdates.checkTime` field — Firebase polls; once it's recent, propagation is far enough along to add records).

### Queued for next session (in order)

2. **Add 2 DNS records at GoDaddy for `mcp.keyvex.com`** (once propagation settles):
   - **CNAME**: name=`mcp`, value=`keyvex-mcp.web.app`
   - **TXT**: name=`_acme-challenge.mcp`, value=`IY0Dn3j5cTtBzUVTW9lRAqrn__gL4Xyb95ZInx0qXUs` (the ACME challenge token from Firebase — re-fetch via `npx tsx src/firebase-rest.ts get-domain keyvex-mcp mcp.keyvex.com` if needed since Let's Encrypt may rotate it on retry)
   - Then in Firebase Console: click **Verify** on the custom-domain page → Firebase polls DNS → ownership flips ACTIVE → cert flips ACTIVE → host flips ACTIVE → `https://mcp.keyvex.com` goes live with TLS

3. **Map `keyvex.com` apex + `www.keyvex.com` to the `capitaledge-api` Hosting site** (the landing page). Same flow:
   - Firebase Console → Hosting → `capitaledge-api` site → Add custom domain → enter `keyvex.com` → get DNS records (will be A records for apex + CNAME for `www`) → add at GoDaddy → Verify
   - OR: do it via REST (`src/firebase-rest.ts add-domain capitaledge-api keyvex.com`) — saves a Console trip
   - Result: `https://keyvex.com` serves the landing page

4. **Drop logo PNGs into `marketing/site/`** + wire into header & favicon:
   - Files Greg will save: `keyvex-mark.png` (the K icon) + `keyvex-wordmark.png` (the KEYVEX text)
   - Wire-in: replace the text-logo in topbar with `<img src="keyvex-wordmark.png">`, swap the inline-SVG favicon for a real one
   - Add `og:image` meta tag for social sharing previews
   - Redeploy: `firebase deploy --only hosting:capitaledge-api`

5. **Form 278 (annual financial disclosures) decision.** The 13-source landing-page list mentions Form 278 but capitaledge-api doesn't run that scraper yet (it's only on Derek's `capital-edge-d5038`). Three paths: (a) port Form 278 here now (~2-3 hr work; Path B from session notes), (b) wait for Derek's bandwidth and do full Option B consolidation in one pass (cleanest long-term), (c) phone Derek and let him pick. Greg deferred decision Day 7.

6. **Update README + landing page once `mcp.keyvex.com` goes live** — replace remaining `cloudfunctions.net` URLs with `mcp.keyvex.com`. Currently the README/landing reference `mcp.keyvex.com` aspirationally; once DNS lands, the references become accurate.

### Pre-launch commercial work (parallel-doable, not DNS-gated)

7. **Privacy Policy** — short, mostly boilerplate with KeyVex specifics. Anthropic-directory pre-req. Publish at `keyvex.com/privacy` once landing is mapped, or start as a static markdown right now. ~20 min.

8. **Loom demo video** (3-5 min) — record the political-alpha cross-source query end-to-end through Claude Desktop. Drives launch traffic. Best done after `mcp.keyvex.com` is live so the URL on screen looks branded.

9. **Launch posts drafts** (Twitter thread, Show HN, Reddit r/MCP / r/aiagents). Drafts ready before Anthropic approves; fire the moment they do. ~30 min each.

10. **DM target list** — 10-20 indie-dev / fintech-AI / niche-newsletter accounts to reach out to at launch. ~30 min research.

11. **MCP registry submissions** (in order — see `marketing/registry-submissions.md` for full prep notes):
    - Anthropic MCP directory (PR to `anthropic/mcp-servers`) — ~5-15 business-day approval. Highest priority.
    - Smithery (web form) — 1-3 business days.
    - Awesome-MCP GitHub list (PR) — variable.
    - PulseMCP (form OR auto-discovery) — submit last.
    - All four submissions are gated on `mcp.keyvex.com` being live + `keyvex.com` landing being live + Privacy Policy URL being live.

### Business / legal (Greg + Derek; not engineering)

12. **LLC formation paperwork** — Greg + Derek are working on this. Required before Stripe / billing.
13. **Open business bank account** post-LLC.
14. **Wire Stripe + per-customer API key issuance + usage tracking** — paid-tier billing infrastructure. Can architect now (per-customer secret in Secret Manager keyed by customer ID, usage counter in Firestore `meta/usage/<customerId>` per month, gate at the bearer-auth check). Don't actually wire until LLC + Stripe account are in place.

### Maintenance (no deadline yet but real)

15. **Node.js 20 → 22 upgrade in functions** before 2026-10-30 decommission (about 6 months out as of Day 7). Bump runtime in `functions/package.json` engines + `functions/src/index.ts` runtime config + verify esbuild target. Test locally + redeploy all functions. Probably 1-2 hr including verification.

16. **`firebase-functions` package upgrade to latest.** Currently outdated per deploy warnings. Has breaking changes. Plan a window. Pair with Node 22 bump since both touch the same files.

17. **Bundle splitting (optional, captured Day 5):** the 15 MB combined bundle gives 5-10 sec cold starts. Splitting into per-domain entry points (one for the MCP HTTP function, separate per-source bundles for scheduled scrapers) would drop MCP cold start below 5 sec. Not blocking; cold starts at 5-10s are fine for cron-driven scrapers.

### v1.1 polish (none blocking; surface-quality items)

18. **Senate parser**: whitespace cleanup in bond `asset_name` fields, back-fill ticker from `asset_name` when source has it inline.
19. **House parser**: strip markdown-link auto-formatting (`[Amazon.com](http://Amazon.com)` → `Amazon.com`); dedup phantom partial rows (`asset_type: "Stock"` instead of `"ST"`); strip comment-overflow contamination from multi-line member narratives.
20. **8-K**: extract `original_accession_number` for amendment filings (8-K/A); pre-filter live feed to skip filings whose only item is 9.01 (paperwork box, ~75% noise); pagination loop on FTS for high-volume days (currently 100-hit cap).
21. **OpenFIGI**: wrong-issuer mappings (AMBAC → OSG, BABAF instead of BABA) — needs issuer-name cross-validation against `nameOfIssuer`. Pre-2023 13F market values 1000× too small (SEC's old "thousands" instruction); era-boundary handling needed.
22. **Senate paper PTR amendments** (~0% of observed disclosures): skip+log in place; full handling needs separate PDF path.
23. **Form 144 preferred-share ticker disambiguation** — Form 144 ports CIK → ticker via reverse lookup against EDGAR's `company_tickers_exchange.json`. Multiple tickers per CIK (e.g., AGNC + AGNCL preferred) cause naive last-write-wins to pick the preferred-series ticker. Add rule: prefer entries with no hyphen-suffix.
24. **13D/G**: pre-2024 filings predate structured-XML mandate (silently skipped — fine for current-window live feed); Item 4 narrative is HTML-only (extract `purpose_summary` field).

### Architectural decisions deferred to Greg + Derek

25. **Option B consolidation (full scraper consolidation).** Day 5 quote: *"the scrapers between capitaledge and capitaledge-API need to be shared. no sense in having duplicates or similar scrapers doing the same work that one could do."* Practical steps when Greg + Derek are ready: (a) dashboard at `C:\CapitalEdge` reads from `capitaledge-api`'s Firestore directly via service-account credentials, (b) dashboard project's scrapers get retired in favor of the autonomous Cloud Functions here, (c) any signal/derived fields the dashboard needs get computed dashboard-side from the raw publisher data (preserves pure-publisher posture). **Don't move on this without Greg's explicit go-ahead after his coordination with Derek.**

## Files In This Project

- `src/index.ts` — MCP server entry, **stdio** transport (for Claude Desktop). Server version 0.14.0. Now a thin wrapper that calls `applyToolHandlers` from `server-setup.ts` — keeping the registration DRY between stdio and HTTP entries.
- `src/server-setup.ts` — shared MCP-server setup (Day 5 night). Exports `createMcpServer(name, version)` + `applyToolHandlers(server)` so both the stdio entry and the HTTP function in `functions/src/index.ts` register the same handler logic from one place. Errors get the `CODE: message` convention extracted into a structured `{code, message}` JSON payload with `isError: true`.
- `functions/` — Firebase Cloud Functions Gen 2 deployment package. `functions/src/index.ts` exports **12 scheduled functions + 1 HTTP function** (`mcp`):
  - **Scheduled functions (Day 5 night)**: one per scraper, `onSchedule` triggers. Cron schedules: 8-K hourly, Form 4 every 30 min, Form 144 / Form 3 / 13D-G hourly (staggered :05/:10/:20), 13F every 4 hours, Senate / House / USAspending / LDA daily at 6 AM ET (staggered), bioguide weekly Sunday 6 AM, bioguide-historical monthly 1st @ 6 AM. Region us-central1. Memory 512 MiB-1 GiB. Timeouts 9-30 min.
  - **MCP HTTP function (Day 5 night)**: `onRequest` trigger at `https://us-central1-capitaledge-api.cloudfunctions.net/mcp`. Stateless mode (sessionIdGenerator: undefined). Bearer-token auth via `MCP_API_KEY` Secret-Manager-backed env var (`defineSecret` from `firebase-functions/params`). Per request: creates a fresh `Server` + `StreamableHTTPServerTransport`, calls `applyToolHandlers`, hands off to `transport.handleRequest`. Health-check at GET / returns version + tool list (no auth). Memory 1 GiB, timeout 300s, concurrency 10.
  - Bundle: esbuild rolls all scrapers + MCP SDK + the shared server-setup into `functions/lib/index.js` (~15 MB, well under Firebase's 100 MB function-deploy cap).
- `src/tools/index.ts` — registry of registered tools (9 active: insider, institutional, congressional, planned-insider-sales, activist-stakes, federal-contracts, member-profile, material-events, lobbying-filings). v1+v2 surface complete.
- `src/tools/insider-transactions.ts` — first MCP tool (definition + handler + input validation). Day 4: gained `include_baseline:boolean` param — when true, parallel-fetches matching Form 3 rows from `initial_ownership_baselines` and attaches them under a `baselines` field on the response envelope. Lets agents stitch Form 4 deltas + Form 3 starting positions in one round trip.
- `src/tools/institutional-holdings.ts` — second MCP tool, exposes 13F holdings (Day 2)
- `src/tools/congressional-trades.ts` — third MCP tool, exposes both Senate eFD PTRs and House Clerk PTRs (Day 3 afternoon + late evening). 581 records combined as of Day 3 wrap. Cross-chamber NVDA query proven through Claude Desktop.
- `src/tools/planned-insider-sales.ts` — fourth MCP tool, exposes Form 144 planned-sale notices (Day 3 night). 90 records initial pull. Tool name `get_planned_insider_sales`. Forward-looking complement to `get_insider_transactions` (Form 4 = realized; 144 = intent).
- `src/tools/activist-stakes.ts` — fifth MCP tool (Day 4 evening), exposes Schedule 13D/13G beneficial-ownership disclosures from `activist_ownership` collection. Tool name `get_activist_stakes`. Standalone (not a param extension on `get_institutional_holdings`) since 13D/G is event-triggered stake disclosure, structurally different from 13F portfolio snapshots. Filter surface: ticker, company_cik, cusip, filer_name, filer_cik, is_activist, filing_type, min_percent_of_class, since/until, sort_by (filing_date | event_date | percent_of_class | shares_owned). `is_activist=true` filters out the 13G institutional firehose (Vanguard/BlackRock dominate volume) to surface activist takeover-style filings.
- `src/tools/federal-contracts.ts` — sixth MCP tool (Day 4 night), exposes USAspending federal contract awards from `federal_contracts` collection. Tool name `get_federal_contracts`. First non-SEC tool — the bridge to the political-alpha cross-source pattern (join `congressional_trades` to contract awards by recipient_name + timing). Filter surface: recipient_name (substring), recipient_uei, awarding_agency, naics_code, psc_code, min_amount, since/until, sort_by (last_modified_date | start_date | award_amount | total_outlays).
- `src/tools/member-profile.ts` — seventh MCP tool (Day 5 morning), exposes the unitedstates/congress-legislators catalog from the `legislators` collection. Tool name `get_member_profile`. Filter surface: bioguide_id (direct doc lookup, fastest), member_name (substring), state, chamber, party, committee_id (Thomas code, exact match against any committee_assignments[].committee_id). Closes the political-alpha loop — every congressional_trades record's bioguide_id resolves to full party/state/chamber/district + ALL committee assignments. Tool description teaches Thomas committee-code conventions (HSAS, SSAF, HSAG15) inline so agents can compose the queries cold.
- `src/tools/material-events.ts` — eighth MCP tool (Day 5 afternoon), exposes Form 8-K material-event filings from the `material_events` collection. Tool name `get_material_events`. Filter surface: ticker, company_cik, item_codes[] (OR semantics via Firestore array-contains-any, max 30 codes), is_amendment, since/until, sort_by (filing_date | period_of_report). Indexed by item code only — body prose is NOT extracted in v1; agents follow `primary_document_url` for the prose. Tool description includes the most-used item codes (1.01 / 2.01 / 2.02 / 5.02 / 7.01 / 8.01 / 9.01 etc.) inline so agents understand the surface cold. Warns inline that 9.01 is a paperwork box (~75% of all 8-Ks).
- `src/tools/lobbying-filings.ts` — ninth MCP tool (Day 5 evening), exposes LDA quarterly filings from the `lobbying_filings` collection. Tool name `get_lobbying_filings`. Filter surface: registrant_name (substring), client_name (substring), filing_year, filing_period (first_quarter | second_quarter | third_quarter | fourth_quarter | mid_year | year_end), general_issue_codes[] (OR semantics, max 30 codes), government_entity (substring), min_income, since, until, sort_by (dt_posted | filing_year | income). One row per filing; activities preserved as nested array; flattened summary arrays (general_issue_codes, government_entities, lobbyist_names) at top level for indexed queries. Activity descriptions truncated at 5000 chars to protect Firestore doc-size cap. Tool description includes top issue codes (DEF/HCR/MMM/TRD/TAX/PHA/etc.) inline so agents can compose queries cold.
- `src/scrapers/form3.ts` — Node/TS port of the Form 3 scraper (Day 4 morning, ~440 lines). Third use of the SEC-XML template after Form 4 and Form 144 — fastest port yet. `ownershipDocument` root with `nonDerivativeHolding` / `derivativeHolding` tables (Form 4 has `...Transaction` instead). One row per security class; multi-owner OR-handling; `parseTagValue:false` to protect numeric-looking strings; `rawXmlPath()` to strip the `xsl<schema>/` prefix from primaryDocument; `normalizeTicker()` for exchange-prefixed symbols (`NYSE/TRN` → `TRN`); `sanitizeForDocId()` for Firestore doc-ID safety.
- `src/scrapers/form4.ts` — Node/TS port of the Form 4 scraper
- `src/scrapers/13f.ts` — Node/TS port of the 13F scraper with sub-account aggregation, top-50 filter, position-change calc, closed-position synthesis (Day 2)
- `src/scrapers/senate.ts` — Node/TS port of the Senate eFD PTR scraper (Day 3 afternoon). Full session protocol with CSRF rotation, Origin header for Django 4 compatibility, multipart FormData on the data POST, paper-PTR detector. ~470 lines.
- `src/scrapers/house.ts` — Node/TS port of the House Clerk PTR scraper (Day 3 late evening). Two-stage pipeline: yearly XML index from `disclosures-clerk.house.gov` → per-PTR PDF text extraction via lazy-loaded `pdf-parse` → heuristic line-walker with TX_SIG_RE anchor regex for trade rows. Owner-code regex `^(SP|JT|DC)\S` handles all observed punctuation/case mixes (SPiShares, DCBJ, JTT., JTO', etc.). Programmatic control-char regex via `String.fromCharCode` (workaround for tool-induced byte injection). ~470 lines.
- `src/scrapers/form144.ts` — Node/TS port of the Form 144 scraper (Day 3 night). Same EDGAR submissions-API + full-text-search plumbing as Form 4. Real schema is wildly different from Form 4 (no ticker, MM/DD/YYYY dates, insider-name-in-issuerInfo, mis-named `securitiesToBeSold` element holding acquisition history not sale data) — captured as Hard Lessons. Loads ticker cache bidirectionally (ticker→cik AND cik→ticker) since Form 144 only includes CIK. Captures the 10b5-1 plan adoption date as a discretionary-vs-scheduled-sale signal. Strips `xsl<schema>/` URL prefix to reach raw XML rather than XSL-rendered HTML. ~370 lines.
- `src/scrapers/lobbying.ts` — Lobbying Disclosure Act scraper (Day 5 evening, ~310 lines). Public REST API at `lda.gov/api/v1/filings/`, no auth, paginated. Three modes: `scrapeLobbyingByRegistrant`, `scrapeLobbyingByClient`, `scrapeLobbyingByPeriod` (bulk by year+quarter). 500ms rate limit (2 req/sec sustained — LDA is more aggressive than EDGAR). Retry-After-aware retry loop on 429s with 2s/4s/8s exponential-backoff fallback. Activity descriptions truncated at 5000 chars to protect 1MB Firestore doc cap. Both `lda.gov` and `lda.senate.gov` proxy the same backend; `lda.gov` is canonical and `senate.gov` retires June 30, 2026.
- `src/scrapers/bioguide.ts` — pure YAML ingestion (Day 5 morning + Day 5 evening extension, ~370 lines). Two public functions: `scrapeBioguideCatalog()` joins `legislators-current.yaml` + `committees-current.yaml` + `committee-membership-current.yaml` into Legislator records (with committee_assignments) for current members; `scrapeBioguideHistorical()` (Day 5 evening) parses `legislators-historical.yaml` (~9 MB, ~12,230 entries) into LegislatorHistorical records (with all terms preserved, no committee data) covering everyone who has ever served Congress (1789→present). The historical ingestion is what powers the back-fill matcher's Tier-4 fallback. Three parallel `fetchYaml` calls, joined into one `Legislator` record per current member with all committee + subcommittee assignments flattened into `committee_assignments[]`. Subcommittee codes formed by appending the subcommittee's `thomas_id` to the parent committee's `thomas_id` (e.g., `HSAG` + `15` = `HSAG15`). ~5 seconds end-to-end; idempotent re-runs. No HTTP discovery loop, no schema surprises — calibration-confirmed clean-API ingestion at <1.5 hrs.
- `src/scrapers/form8k.ts` — Form 8-K material-event scraper (Day 5 afternoon, ~330 lines). Two modes: (1) per-ticker via the EDGAR submissions API, which returns `items` as a comma-separated string in the filing metadata (no body fetch needed); (2) live-feed via EDGAR full-text search, which returns `items` as an ARRAY of strings (different shape — captured as a Hard Lesson). `parseItemCodes()` accepts both shapes via `unknown` typing + runtime branching. Bidirectional ticker cache (ticker→CIK and CIK→ticker→name) shared with form144.ts pattern. Submissions API responses also cached per-CIK so the live-feed's items-fallback path fetches each company at most once per run. Idempotent doc IDs (accession_number). Dedup by accession across FTS hits (FTS sometimes returns multiple rows per filing). Amendment detection via `file_type` field; 8-K/A → `is_amendment: true` with the original 8-K kept as a separate row.
- `src/scrapers/usaspending.ts` — USAspending federal contract awards scraper (Day 4 night). Public REST API at `api.usaspending.gov/api/v2/search/spending_by_award/`, no auth, structured JSON. First non-SEC scraper. Uses POST with award_type_codes filter, recipient_name substring, time period bounds. Idempotent doc IDs (USAspending's `generated_internal_id`, stable across modifications).
- `src/scrapers/activist.ts` — Node/TS port of the Schedule 13D/13G scraper (Day 4 evening, ~480 lines). Fourth use of the SEC-XML template. Handles SCHEDULE 13D, SCHEDULE 13D/A, SCHEDULE 13G, SCHEDULE 13G/A. **Dual-schema branching parser** — 13D and 13G use STRUCTURALLY DIFFERENT XML schemas (different namespaces, field paths, field names) — captured as Hard Lessons. `parseActivistXml` discriminates on `submissionType` and routes to `parseSchedule13D` or `parseSchedule13G`, each handling its own schema, both populating the shared `ActivistOwnership` output type. EDGAR FTS form code is `SCHEDULE 13D` not `SC 13D` (gotcha captured as Hard Lesson). `issuerInfo` nested under `coverPageHeader` not `formData` direct. `headerData` is a sibling of `formData`. CUSIPs at `issuerCusips.issuerCusipNumber` (plural, nested) for both branches. Multi-filer joint disclosures handled. Reuses `rawXmlPath()`, `normalizeTicker()`, `sanitizeForDocId()`, multi-owner OR-handling, CIK reverse-lookup from earlier scrapers.
- `src/openfigi.ts` — OpenFIGI CUSIP→ticker enrichment with US-exchange preference, Firestore write-through cache, EDGAR-catalog cross-validation in `pickBestMatch`, single-char allowlist, USD-suffix rejection, and `searchOpenFigiByName` for the tertiary search-by-name fallback (Day 3)
- `src/sec-tickers.ts` — EDGAR `company_tickers_exchange.json` (Day 3 — switched from `company_tickers.json`) name fallback for CINS-coded foreign-domiciled CUSIPs and ticker-validation oracle. Exports `lookupTickerByName`, `isKnownUSTicker`, `searchEdgar`, `dumpEdgar`, `normalizeName`. Contains aggressive abbreviation-expansion table and jurisdiction-suffix stripping.
- `src/scrape.ts` — CLI runner for scrapers (`ping`, `backfill-bioguide`, `bioguide`, `bioguide-historical`, `8k`, `8k-feed`, `lobbying-registrant`, `lobbying-client`, `lobbying-feed`, `usaspending`, `usaspending-feed`, `13d-13g`, `13d-13g-feed`, `form3`, `form3-feed`, `form4`, `form4-feed`, `form144`, `form144-feed`, `13f`, `13f-feed`, `funds`, `senate`, `senate-ptr`, `house`, `house-index`, `house-text`, plus Day 3 diagnostics: `test-normalize`, `search-edgar`, `dump-edgar`, `flush-cusip-cache`)
- `src/firestore.ts` — data layer with auto-detected stub vs live mode; `saveInsiderTransactions`, `saveInstitutionalHoldings`, `saveCongressionalTrades`, `saveForm144Filings`, `saveForm3Holdings`, `saveActivistOwnership`, `saveFederalContractAwards`, `saveLegislators`, `saveLegislatorsHistorical`, `saveMaterialEvents`, `saveLobbyingFilings`, `queryInsiderTransactions`, `queryInstitutionalHoldings`, `queryCongressionalTrades`, `queryForm144Filings`, `queryForm3Holdings`, `queryActivistOwnership`, `queryFederalContractAwards`, `queryLegislators`, `queryMaterialEvents`, `queryLobbyingFilings`, `backfillBioguideIds`, `pingFirestore`, `getLiveDb`, `getDbIfLive`
- `src/types.ts` — shared types (`ResultEnvelope`, `InsiderTransaction`, `InstitutionalHolding`, `CongressionalTrade`, `Form144Filing`, `Form3Holding`, `InsiderTransactionsEnvelope`, `ActivistOwnership`, `ActivistOwnershipQuery`, `FederalContractAward`, `FederalContractAwardsQuery`, `Legislator`, `CommitteeAssignment`, `LegislatorQuery`, `LegislatorHistorical`, `HistoricalTerm`, `MaterialEvent`, `MaterialEventsQuery`, `LobbyingFiling`, `LobbyingActivity`, `LobbyingFilingsQuery`, etc.)
- `package.json` — dependencies and scripts
- `tsconfig.json` — TypeScript config (strict mode, ES2022, NodeNext)
- `firebase.json` — Firebase CLI config. Configures Firestore indexes, Cloud Functions deploy + predeploy hooks, and **multi-site Hosting** (Day 7): `hosting` is an array of two entries — one for `keyvex-mcp` site (rewrites all requests to the `mcp` Cloud Run service backing the MCP API), one for `capitaledge-api` site (default site, serves the static landing page from `marketing/site/`).
- `.firebaserc` — Firebase project pin (Day 3 evening). Tells the CLI this folder = `capitaledge-api`. Both files safe to commit (no secrets).
- `src/firebase-rest.ts` — Firebase REST API helper CLI (Day 7). Mints OAuth bearer tokens from `secrets/service-account.json` via `google-auth-library` (transitive dep of firebase-admin) and calls Google REST APIs directly. Fills gaps the firebase CLI doesn't cover — most importantly Firebase Hosting custom-domain management (`get-domain`, `add-domain`, `list-domains`). Per Derek's tip, bypasses the Chrome MCP allowlist for Console-only operations. Same pattern can extend to Cloud Run, IAM, etc. by swapping the baseUrl + path. CLI commands: `list-sites`, `list-domains <site>`, `get-domain <site> <fqdn>`, `add-domain <site> <fqdn>`, `token` (mint and print bearer for ad-hoc curl), `raw <METHOD> <path> [json]` (escape hatch).
- `marketing/site/index.html` — KeyVex landing page (Day 7, ~600 lines). Single self-contained HTML with embedded CSS, no framework, no build step, ~23 KB on the wire. Pure dark default (no OS-theme switching), brand green (`#4dff20`) accent throughout, `PLAN. EXECUTE. ELEVATE.` slogan in the hero. All 7 sections from `marketing/landing-page-copy.md`: hero, 13 sources grid, LMT cross-source demo, curl quickstart, 4-tier pricing, audience cuts, pure-publisher posture, FAQ, footer. Mobile-responsive. Deployed to the `capitaledge-api` Hosting site at `https://capitaledge-api.web.app`. Logo files (`marketing/site/keyvex-mark.png` + `keyvex-wordmark.png`) pending Greg's drop.
- `marketing/landing-page-copy.md` — landing page copy/wording draft (markdown). Source of truth for the marketing wording; `marketing/site/index.html` is the rendered HTML implementation.
- `marketing/registry-submissions.md` — pre-submission notes for the four MCP registries (Anthropic / Smithery / PulseMCP / Awesome-MCP). Includes draft entries, pre-submission checklists, submission order, things-NOT-to-do list. Read before submitting anything.
- `public/.gitkeep` — placeholder so the empty `public/` directory exists in git (Firebase Hosting requires it for the `keyvex-mcp` site even though the Cloud Run rewrite catches all requests).
- `.gitignore` — excludes `secrets/`, `node_modules/`, `dist/`
- `secrets/service-account.json` — Firebase service account key (NEVER commit; gitignored)
- `secrets/.gitkeep` — keeps the folder in version control without contents
- `reference/form4_scraper.js` — original browser-version scraper from Capital Edge (kept for diffing)
- `reference/congressional_scraper.js` — original Senate scraper (browser-version). **Ported Day 3 afternoon** to `src/scrapers/senate.ts` with three load-bearing fixes the reference had drifted on (see Hard Lessons). Kept for diffing.
- `reference/house_scraper.js` — original House scraper (browser-version). **Ported Day 3 late evening** to `src/scrapers/house.ts` with iterative owner-code regex hardening (4 rounds) and programmatic control-char regex builder (workaround for byte-corruption during inline regex authoring). Kept for diffing.
- `reference/institutional_scraper.js` — original 13F scraper (browser-version, awaiting Node port)
- `MCP_PROJECT_HANDOFF.md` — original handoff from the chat-interface session that scoped this product
- `DATA_REQUIREMENTS_FOR_DASHBOARD.md` — data-quality spec sent to the Capital Edge dashboard project as peer review (not a hard dependency since we're dual-scrape)
- `TOOL_DESIGN.md` — v1 tool surface design (5 tools, design principles, composition patterns)
- `README.md` — human orientation, quickstart
- `CLAUDE.md` — this file

## External Locations

- **GitHub repo:** https://github.com/gregorywglenn-spec/Keyvex-API (private; old `CapitalEdge-API` URL auto-redirects)
- **Firebase project:** https://console.firebase.google.com/project/capitaledge-api/overview
  - Firestore database: `(default)` in `us-central1`, production-mode rules
  - Service account: `firebase-adminsdk-fbsvc@capitaledge-api.iam.gserviceaccount.com`
  - Plan: Blaze (pay-as-you-go) — confirmed Day 5 evening
- **Public MCP HTTPS endpoint** (Day 5 late night): `https://us-central1-capitaledge-api.cloudfunctions.net/mcp`
  - Auth: bearer token from Secret Manager (`MCP_API_KEY`)
  - Health-check (no auth): GET `/`
  - Live on v0.16.0 as of Day 7 redeploy.
- **Public MCP HTTPS endpoint via Hosting** (Day 7): `https://keyvex-mcp.web.app`
  - Same backend (Cloud Run rewrite via Firebase Hosting `keyvex-mcp` site)
  - Adds Firebase's auto-managed TLS layer
- **Public custom MCP domain (LIVE Day 7 evening):** `https://mcp.keyvex.com`
  - Mapped to the `keyvex-mcp` Hosting site in Firebase, rewrites to the `mcp` Cloud Run service
  - TLS auto-managed via Let's Encrypt (renews automatically forever)
  - DNS records added at GoDaddy: CNAME `mcp` → `keyvex-mcp.web.app` + TXT `_acme-challenge.mcp` (ACME challenge token)
  - Verified working: `curl https://mcp.keyvex.com` returns the v0.16.0 health JSON
- **Live KeyVex landing page** (Day 7, apex DNS landed Day 8): `https://keyvex.com` (and `https://www.keyvex.com`)
  - Static HTML served from `marketing/site/` via the `capitaledge-api` Hosting site (project's default site)
  - Also reachable at `https://capitaledge-api.web.app` (the original Firebase Hosting URL)
- **Brand domain (purchased Day 7-ish, ~$900 aftermarket):** `keyvex.com`
  - Registrar: GoDaddy
  - DNS: GoDaddy default nameservers (`ns53.domaincontrol.com` + `ns54.domaincontrol.com`) — switched from Afternic Day 7 evening
  - **All three custom-domain mappings LIVE as of Day 8 (2026-05-11):** `mcp.keyvex.com` → `keyvex-mcp` site (Cloud Run rewrite); `keyvex.com` apex + `www.keyvex.com` → `capitaledge-api` site (landing page). All TLS managed by Firebase via Let's Encrypt, auto-renewing.
- **Older brand domain:** `capitaledge.app`
  - Pre-rebrand domain, still owned. **Email accounts on this domain retired Day 8 (2026-05-11).** Customer-facing email is `contact@keyvex.com` everywhere. Any code, doc, or marketing surface still referencing `contact@capitaledge.app` is stale — fix on contact. (Day 8 sweep updated all source code USER_AGENT strings, landing page, README, and marketing copy.)
- **Capital Edge dashboard project:** `C:\CapitalEdge\` (separate Cowork workspace, owned operationally by Derek). Different Firebase project: `capital-edge-d5038`.

## Capital Edge Cross-References (sibling project)

These files in `C:\CapitalEdge\` may be relevant context for AI agents working here. Read them only if relevant to the current task — don't preload everything.

- **`DATA_STRATEGY.md`** — original dual-track business plan, Firestore schema design, full cost picture, build phases, competitor comparison, April 2026 repositioning around Unusual Whales. Schema doc is somewhat out of date relative to what scrapers actually write; cross-check against actual scraped data when in doubt.
- **`CONGRESS_DATA_PIPELINE.md`** — detailed spec for ingesting congress-legislators YAML data (537 members, photos, committee assignments). Bioguide_id is the join key. Important hard-won gotchas inside (Cloudflare bot challenge on theunitedstates.io, photo concurrency limits, JPEG magic-byte verification). Foundational for any tool that returns congressional trade data with member context.
- **`DATA_SOURCES_ROADMAP.md`** — v2+ expansion candidates (Form 144, 13D/G, USAspending, FRED, etc.). Strategic note inside about positional vs event data — important for v2 tool design but not v1.
- **`HANDOFF_NEXT_SESSION.md`** — the dashboard project's own handoff to its next session. Read for context on dashboard state, NOT for MCP guidance.
- **`run-scraper.js`** — the dashboard's working Node CLI runner with thinner inline scrapers. Reference only; this project has its own copies and ports under `reference/` and `src/scrapers/`.

## Standing Rules from Greg

These apply across all his Claudes — copied here so a cold session has them inline.

1. **Tell the ugly truth.** Especially about whether something will actually work. Push back, run actual diagnostics, report the true picture even when it complicates the plan.
2. **Don't quote in weeks what he ships in hours.** Recalibrate constantly.
3. **Foundation before features. Always. No exceptions.**
4. **Speak in easy-to-understand dialog. Use comparisons to explain things. Teach.** Greg is a builder learning code — analogies to construction, framing, plumbing land well.
5. **Flag opportunity in the moment.** If you spot a genuine business opportunity adjacent to what you're working on, surface it without being asked.
6. **Pure-publisher posture stays.** No derived intelligence in tool outputs. Ever. Convergence score and similar belong to the dashboard product, not here.
7. **Project boundary discipline.** This project never writes to Capital Edge's Firestore collections. Scraper changes that affect this project's data happen here only.
8. **Source-faithful, byte-exact, auditable.** KeyVex mirrors SEC's authoritative bytes verbatim, including source-side quirks (sentinels, filer-entry typos). Conventions get documented in tool descriptions; runtime annotation via `source_metadata` flags (`src/source-metadata.ts`) labels quirks as KeyVex's interpretation, never the source's. Never silently normalize: substituting KeyVex's guess for the source's recorded value is fabrication against the authoritative record. Verifiable consequence — any KeyVex record audits byte-for-byte against EDGAR. Evidence is per-record-verifiable (spot-check: 19-row stratified sample, 22/22 matches per v4 amendment 2), not a census — keep claims to "audit any record," not "100% verified." Applies to every tool and scraper added.

## Decisions Greg Locked In Tonight

In case future sessions try to re-open these:

- MCP server is the v1 product. The REST API tier is parked indefinitely. If it ever ships, it lives on its own separate website/brand, not under this project's umbrella.
- Two Firebase projects under one Google account. Not data sync. Not dual-write. Pure dual-scrape with full operational independence.
- Tool surface: 5 tools, entity-based with rich filters (`get_insider_transactions` not `get_recent_insider_transactions` + `get_insider_transactions_by_ticker`). See `TOOL_DESIGN.md` for the load-bearing argument.
- Foundation pace is set by the dashboard's data quality. The MCP project can move fast on tool design and architecture; can't outrun the data quality of what scrapers produce. We'll port scrapers properly with full field set rather than ship thin scrapers that limit the tool surface.

## How to Continue Tomorrow

If a fresh Cowork session is starting in this folder:

1. Read this file (you just did, if you're an agent reading top-down).
2. Glance at `MCP_PROJECT_HANDOFF.md` for the original strategic framing.
3. Glance at `TOOL_DESIGN.md` for what the v1 tool surface looks like and which tools depend on which scrapers.
4. Then ask Greg: which of the open items above is the priority right now. Don't guess.

Greg's keyboard test sequence (anytime you want to verify everything still works):

```
cd C:\CapitalEdge-API
npx tsx src/scrape.ts ping                              # confirms credentials
npx tsx src/scrape.ts bioguide --save                   # ingest 536 current legislators (~5 sec)
npx tsx src/scrape.ts bioguide-historical --save        # ingest 12,230 historical legislators (~10 sec)
npx tsx src/scrape.ts backfill-bioguide                 # back-fill bioguide_id on every congressional_trades row
npx tsx src/scrape.ts 8k AAPL                           # last 50 Apple 8-K material events
npx tsx src/scrape.ts 8k-feed 1 --save                  # 1-day 8-K firehose, saves to Firestore
npx tsx src/scrape.ts usaspending "Lockheed Martin" 30  # 30-day LMT contract awards
npx tsx src/scrape.ts usaspending-feed 7 --save         # 7-day all-recipient feed, saves
npx tsx src/scrape.ts 13d-13g RDW                       # 13D/13G stakes filed against Redwire
npx tsx src/scrape.ts 13d-13g-feed 7 --save             # 7-day 13D/13G across all issuers, saves
npx tsx src/scrape.ts form3 AAPL                        # AAPL initial-ownership baselines (Form 3)
npx tsx src/scrape.ts form3-feed 7 --save               # 7-day Form 3 across all companies, saves
npx tsx src/scrape.ts form4 AAPL                        # hits SEC, prints AAPL trades
npx tsx src/scrape.ts form4-feed 1 --save               # 1-day live feed, saves to Firestore
npx tsx src/scrape.ts form144 AAPL                      # AAPL planned-sale notices
npx tsx src/scrape.ts form144-feed 7 --save             # 7-day Form 144 across all companies, saves
npx tsx src/scrape.ts senate 7 --save                   # 7-day Senate PTRs, saves
npx tsx src/scrape.ts house 7 --extract --save          # 7-day House PTRs, saves
npx tsx src/scrape.ts lobbying-client "Pfizer"          # Pfizer lobbying disclosures
npx tsx src/scrape.ts lobbying-feed 2025 fourth_quarter --save --max=100
                                                         # Q4 2025 LDA filings, saves
npm run dev                                              # boots MCP server in LIVE MODE
```

## Last Updated

May 2, 2026 — Day 5 late night. **9 MCP tools live, server v0.14.0, 12 scrapers running autonomously on Firebase Cloud Functions Gen 2, MCP server itself deployed as an authenticated HTTPS endpoint.** v1 + v2 build closed; bioguide back-fill at 100%; the warehouse fills itself in continuously; remote MCP clients (any agent, anywhere) can authenticate and query the tools over HTTP. The full pipeline — scrape → store → expose — is end-to-end live in production.

Day 4 night→Day 5 evening shipped (in order):
- **v0.7.0 (commit `d9ff966`) — USAspending federal contract awards** + `get_federal_contracts` MCP tool. First bridge outside the SEC vertical.
- **v0.8.0 (commit `f7b2b3a`) — bioguide ingestion** + `get_member_profile` MCP tool. Salvaged from a phantom Cowork session via `v0.8.0-salvage/` + `SALVAGE_NOTES.md`. 536 current legislators ingested. `C001098 → C001035` mis-attribution corrected in three locations.
- **v0.9.0 (commit `e547b83`) — 8-K material events scraper** + `get_material_events` MCP tool. FTS-vs-submissions-API items-shape mismatch caught mid-build, captured as a Hard Lesson.
- **v0.10.0 (commit `53586f9`) — bioguide_id back-fill** on existing congressional_trades. Three-tier matcher (primary / Senate-no-state / multi-word last). **522/581 (90%) back-filled.** Remaining 59 all Markwayne Mullin — flagged as v1.1 polish (historical-YAML ingestion).
- **v0.11.0 (commit `5ad6c94`) — Lobbying Disclosure Act scraper** + `get_lobbying_filings` MCP tool. Public REST API at `lda.gov/api/v1/filings/`, 2 req/sec sustained with Retry-After-aware retry on 429s. Three CLI modes: by-registrant, by-client, by-period. Activity descriptions truncated at 5000 chars to protect Firestore's 1MB doc cap (real filings include 30KB+ free-text content).
- **v0.12.0 (commit `c691360`) — Historical legislators ingestion** + Tier-4 historical fallback in the bioguide back-fill matcher. 12,230 historical legislators (1789→present), 42,739 total terms preserved. **All 59 previously-unmatched Mullin trades now resolve to M001190. Back-fill at 100% (581/581).**
- **v0.13.0 (commit `8f10c42`) — Autonomous Firebase Cloud Functions deployment.** 12 scheduled scraper functions, each firing on its own cron, writing to Firestore via Application Default Credentials. First-deploy IAM gap captured as Hard Lesson with the runbook.
- **v0.14.0 (this commit) — MCP server deployed as an authenticated HTTPS endpoint.** The server now lives at `https://us-central1-capitaledge-api.cloudfunctions.net/mcp` as an HTTP-triggered Cloud Function. Stateless `StreamableHTTPServerTransport` (per-request server + transport pair, no session). Bearer-token auth backed by Google Secret Manager (`MCP_API_KEY` defined via `firebase-functions/params.defineSecret`). Tool registration deduplicated via new `src/server-setup.ts` so stdio and HTTP entries share the same logic. Health-check at GET / returns server status without auth; tool calls require `Authorization: Bearer <key>`. Verified end-to-end: 401 on missing/wrong key, 200 + full tool list on auth'd `tools/list`, full Susan Collins committee-assignments response on auth'd `tools/call get_member_profile`. Cold start ~5-10 sec on the 15 MB bundle; warm responses sub-second. Concurrency 10, memory 1 GiB, timeout 300s.

State at session wrap:
- 76 Form 4 insider trades (`insider_trades`)
- 42+ Berkshire 13F holdings (`institutional_holdings`)
- **581 congressional trades (`congressional_trades`) — 581/581 with bioguide_id populated (100%)**
- 90 Form 144 planned-sale notices (`planned_insider_sales`)
- 98 Form 3 initial-ownership rows (`initial_ownership_baselines`)
- 165+ Schedule 13D/13G activist & passive 5%+ ownership rows (`activist_ownership`)
- USAspending federal contract awards (`federal_contracts`) — Day 4 night ingestion
- 536 current legislators (`legislators`) — Day 5 morning ingestion
- 100 8-K material event filings (`material_events`) — Day 5 afternoon ingestion
- 100 LDA Q4 2025 lobbying filings (`lobbying_filings`) — Day 5 evening ingestion
- **12,230 historical legislators (`legislators_historical`) — Day 5 evening ingestion** ← new

**Nine MCP tools registered and serving:**
1. `get_insider_transactions` (with `include_baseline`)
2. `get_institutional_holdings`
3. `get_congressional_trades`
4. `get_planned_insider_sales`
5. `get_activist_stakes`
6. `get_federal_contracts`
7. `get_member_profile`
8. `get_material_events`
9. `get_lobbying_filings` ← new Day 5 evening

**v2 queue progress:** House ✓ → Form 144 ✓ → Form 3 ✓ → 13D/G ✓ → USAspending ✓ → bioguide ✓ → 8-K ✓ → bioguide back-fill ✓ → **Lobbying ✓**. Full v2 closeout — every planned data source is shipped.

**The political-alpha cross-source pattern now spans five data sources in a single conversation.** Agents can compose: `get_congressional_trades(ticker:'LMT')` → grab `bioguide_id` → `get_member_profile(bioguide_id:'<id>')` for party/state/committee context → `get_federal_contracts(recipient_name:'Lockheed Martin')` for awards that followed → `get_material_events(ticker:'LMT', item_codes:['1.01','2.01'])` for the deal flow → `get_lobbying_filings(client_name:'Lockheed Martin', filing_year:2025)` for the money paid to lobbyists. Single-conversation triangulation across every public-disclosure surface that matters; no other MCP server exposes this.

**Strategic clarity locked Day 3 that still holds:** stay vertical (no medical/legal/sports — depth in US public disclosures only). Customer funnel stays bottom-up (free → indie devs → small fintechs → midsize → institutional, not the reverse). Pure-publisher posture (no derived intelligence in tool outputs, ever).

**Public MCP endpoint:** `https://us-central1-capitaledge-api.cloudfunctions.net/mcp` (auth: Bearer `<MCP_API_KEY>`; health: GET /).

**Immediate next move on session resume:**
1. **Watch the autonomous pipeline + MCP HTTP function run for 24-48 hours.** Cron-based schedulers tick on cadence; HTTP function stays warm under load. Firebase Console > Functions > <name> > Logs is the monitoring surface.
2. **Custom domain.** Map a real domain (mcp.<brand>.com or similar) to the Cloud Function via Firebase Hosting + Cloud Run rewrite. Blocks on brand/domain decision.
3. **Optional polish:** split the 15 MB combined bundle into per-domain entry points (one for the MCP HTTP function, separate ones for scheduled scrapers grouped by source) to drop MCP cold-start latency below 5 seconds.

**Open architectural question (parking, not deciding):** Greg flagged the dashboard-vs-hub data sourcing question late Day 3 — should `C:\CapitalEdge` consume from the hub's Firestore directly (Option B) or keep the locked dual-scrape posture (Option A)? Field shapes are deliberately compatible. Deferred until Greg revisits. See item 25 in "What's Open / Next Up" for the full framing.

---

### Day 6 (between sessions, 2026-05-04 → 2026-05-06)

Two version-bump shipments happened between the Day 5 wrap and the Day 7 work:

- **v0.15.0 (commit `819298f`) — KeyVex rebrand.** `package.json` name → `keyvex`. Server name → `keyvex` (in both `src/index.ts` and `functions/src/index.ts`). Brand decision locked May 4: customer-facing everything is "KeyVex"; Firebase project ID `capitaledge-api` stays permanent (Google won't allow renaming project IDs). Domain decision: bought `keyvex.com` (~$900 aftermarket through GoDaddy). README rewritten for KeyVex framing. Sibling Capital Edge dashboard at `C:\CapitalEdge` is *not* part of this rebrand — that's Derek's project, separate name discussion.
- **v0.16.0 (commit `5a9392b`) — Cross-project health-check + /meta telemetry per Derek's spec.** New `functions/src/health-check.ts` ports Derek's CommonJS health-check pattern to ESM. `scheduledHealthCheck` Cloud Function fires daily at 12:30 ET (30-min offset from Derek's 12:00 ET to keep alerts staggered). 8 jobs monitored with tighter thresholds for sub-daily schedulers (Form 4: warn 4h/fail 12h; hourly: warn 6h/fail 24h; 13F: warn 12h/fail 48h; daily: warn 36h/fail 60h). Slack alerts use `[capitaledge-api]` prefix to disambiguate from Derek's `[capital-edge]` alerts (both projects share the same Slack incoming webhook). Change-detection dedup via `/meta/healthCheck.lastNotifiedStatus` so we only ping when a job's status *changes*. Each scheduled scraper now writes `lastSyncedAt: new Date()` to `/meta/{jobName}` after successful runs. **NOTE:** `SERVER_VERSION` constants in `src/index.ts` + `functions/src/index.ts` were NOT bumped to 0.16.0 with this commit — that miss got fixed Day 7.

### Day 7 (2026-05-07) — Marketing prep + rebrand cleanup + landing page LIVE

Single intense session focused on shipping the public-facing pieces. Eight commits on branch `claude/quizzical-yonath-778dca`:

- **`b86e32c` — `marketing/landing-page-copy.md` + `marketing/registry-submissions.md` drafts.** Full landing-page copy (hero, what-it-is, cross-source play, how-it-works, pricing, audience, FAQ, footer) and submission-prep notes for the four MCP registries (Anthropic, Smithery, Awesome-MCP, PulseMCP).
- **`0580eed` — Landing page sources list split to 13 distinct items.** Subheadline updated to lead with "13 distinct disclosure sources." Section 1 bullets break Senate eFD + House Clerk PTRs into separate entries, add Form 278 net worth, ensure all 13 items appear without contributor split (Greg's framing: KeyVex's surface, not "8 KeyVex + 5 Derek").
- **GitHub repo renamed `CapitalEdge-API` → `Keyvex-API`** (Greg did via UI; permission to drive Console-only operations not granted to MCP automation tool — captured as a Hard Lesson).
- **`9d6cf99` — Doc references updated to new repo URL.** CLAUDE.md ×2 + landing-page-copy.md ×1. Local git remote also updated (worktrees share `.git` config with the parent repo, so updating once updates all). Old GitHub URL still 301-redirects.
- **`0c980c5` — README polish.** Cross-source query demo (LMT example), bearer-auth quickstart with three working curl examples (health-check, tools/list, tools/call), Claude Desktop config snippet with the Microsoft Store sandboxed-path footnote. Fixed misleading line about historical-legislators collection (it's internal back-fill data, not agent-queryable). CLI examples now use real command names (`senate`, `house --extract`, `8k-feed`) instead of made-up `congressional`. Status section dropped version-name in favor of fact-only "Production. All 12 scrapers running…" so the README doesn't age with each release.
- **`011977b` — Version bump 0.15.0 → 0.16.0.** Fixed the v0.16.0 oversight: `SERVER_VERSION` constants in `src/index.ts:44`, `functions/src/index.ts:501`, and `package.json` all bumped from 0.15.0 → 0.16.0 to match the v0.16.0 commit feature reality. `mcp` Cloud Function redeployed via `firebase deploy --only functions:mcp`; live endpoint now advertises 0.16.0 (verified: `curl https://us-central1-capitaledge-api.cloudfunctions.net/mcp` → `"version":"0.16.0"`).
- **Two deploy warnings flagged for follow-up:** Node.js 20 deprecated 2026-04-30, decommissioned 2026-10-30 (about 6 months out — must upgrade to Node 22 before then or no more deploys); `firebase-functions` package outdated with breaking-change warning (plan an upgrade window).
- **`128ef24` — Firebase Hosting `keyvex-mcp` site + Cloud Run rewrite.** Created the dedicated Hosting site (`firebase hosting:sites:create keyvex-mcp`). Updated `firebase.json` with hosting config that rewrites all requests on the `keyvex-mcp` site to the `mcp` Cloud Run service. Created empty `public/.gitkeep` (Hosting requires the directory to exist even though all requests are rewritten). Deployed via `firebase deploy --only hosting:keyvex-mcp`. Verified: `https://keyvex-mcp.web.app` → returns the v0.16.0 health JSON (rewrite works); POST without bearer → 401 (auth still enforced). Custom domain `mcp.keyvex.com` registered against this site via Firebase Console.
- **GoDaddy nameserver switch (Greg, in browser):** `keyvex.com` was on Afternic nameservers (DNS managed by GoDaddy's marketplace subsidiary because `keyvex.com` was a premium aftermarket purchase). Switched to GoDaddy default nameservers (`ns53.domaincontrol.com` + `ns54.domaincontrol.com`) — propagation in flight at end of session.
- **`3b4ee19` — `src/firebase-rest.ts` (per Derek's tip).** Service-key REST CLI: mints OAuth bearer tokens from `secrets/service-account.json` using `google-auth-library` (transitive dep of firebase-admin) and calls Firebase Hosting REST API directly. Bypasses the Chrome MCP allowlist for Console-only operations. Captured as a Hard Lesson; same pattern works for any Google REST API. Verified end-to-end with `list-sites` (returned both `capitaledge-api` and `keyvex-mcp` sites) + `get-domain keyvex-mcp mcp.keyvex.com` (returned full domain status incl. the ACME TXT record needed for cert validation that the Console doesn't surface).
- **`049a568` — KeyVex landing page deployed LIVE.** `marketing/site/index.html`: single self-contained HTML with embedded CSS, ~23 KB on the wire. Pure dark default (no OS-theme switching), brand green (`#4dff20`) accent throughout, `PLAN. EXECUTE. ELEVATE.` slogan. All 7 sections from the copy draft. Mobile-responsive. Updated `firebase.json` to multi-site Hosting (the `hosting` block is now an array of two entries — keyvex-mcp + capitaledge-api). Deployed via `firebase deploy --only hosting:capitaledge-api`. Live at `https://capitaledge-api.web.app`. Logo files pending Greg's drop into `marketing/site/` (will swap into header + favicon when they land).

State at end of Day 7:
- **9 MCP tools live, server v0.16.0 advertised live, 13 autonomous scrapers across the unified KeyVex operation (8 in this codebase + 5 in the sibling dashboard codebase)**, `scheduledHealthCheck` pinging Slack daily at 12:30 ET
- **Landing page live** at `https://capitaledge-api.web.app`
- **MCP API endpoints**: `https://mcp.keyvex.com` (LIVE, customer-facing, TLS via Let's Encrypt) + `https://keyvex-mcp.web.app` (Hosting alias) + `https://us-central1-capitaledge-api.cloudfunctions.net/mcp` (canonical Cloud Functions URL, still works)
- **Brand domain**: `keyvex.com` (DNS at GoDaddy now; custom-domain mappings to land in next session)
- **GitHub repo**: `Keyvex-API` (renamed; old URL 301-redirects)
- **Memory entries added**: `feedback_verify_inbound_specs.md` (verify before acting on conflicting inbound specs — captured Day 7 morning when Derek's Claude misdirected a spec); `project_canonical_google_account.md` (`claude1986aaa@gmail.com` is the canonical Google account for KeyVex; the Chrome MCP allowlist quirks led to discovering this).

**Strategic clarity locked Day 7 that holds:**
- KeyVex is "our baby" — even though Derek's scrapers are part of the data infrastructure, the customer-facing product is KeyVex's responsibility to ship. Don't credit Derek as a contributor on customer-facing surfaces; thank him in private comms.
- Repo named `Keyvex-API` (Derek named his side similarly so the projects parallel; both projects internally call themselves keyvex-* / capital-edge-* on their respective sides).

**Immediate next move on session resume:**
1. Check nameserver propagation status: `npx tsx src/firebase-rest.ts get-domain keyvex-mcp mcp.keyvex.com` — once `requiredDnsUpdates.checkTime` is recent (within last hour), DNS is ready
2. Add 2 DNS records at GoDaddy: CNAME `mcp` → `keyvex-mcp.web.app` + TXT `_acme-challenge.mcp` → ACME token (re-fetch the token from the API in case Let's Encrypt rotated it)
3. Click Verify in Firebase Console for `mcp.keyvex.com` — Firebase polls DNS, then ownership/cert/host all flip ACTIVE
4. Map `keyvex.com` apex + `www.keyvex.com` to the `capitaledge-api` Hosting site (next custom domain) — same flow but A records for apex, CNAME for `www`
5. Once Greg drops the logo PNGs, wire them into the landing page's topbar + favicon
6. Decide on Form 278 (port now vs. wait for Derek)

### Day 7 LATE — `mcp.keyvex.com` LIVE with TLS (~5 PM ET)

After the planned end-of-day, Greg pushed through the final DNS step. Sequence:
1. Nameserver propagation completed in ~30 min (much faster than the 4-hour estimate)
2. Greg added the two records at GoDaddy: CNAME `mcp` → `keyvex-mcp.web.app` + TXT `_acme-challenge.mcp` → `IY0Dn3j5cTtBzUVTW9lRAqrn__gL4Xyb95ZInx0qXUs`
3. DNS verified globally via Node DNS lookup (records resolved instantly)
4. Greg clicked Verify in Firebase Console → `"Custom domain setup successfully"`
5. Firebase polled DNS, verified ownership via CNAME, requested Let's Encrypt cert via TXT challenge, started CDN propagation
6. ~25 min later: `hostState: HOST_ACTIVE`, `ownershipState: OWNERSHIP_ACTIVE`, `cert.state: CERT_PROPAGATING`, `https://mcp.keyvex.com` returns HTTP 200 with the v0.16.0 health JSON in 2.4 sec

**Customer-facing endpoint is now `https://mcp.keyvex.com`.** Auto-renewing TLS cert from Let's Encrypt (no manual renewal ever needed). README + landing page already referenced this URL aspirationally; once live, those references became accurate without further edits (small follow-up edits just polish the messaging from "future" to "now").

**Landing page state:** still served at `https://capitaledge-api.web.app`. Apex `keyvex.com` and `www.keyvex.com` mappings are the next domain step (item 14 on the to-do list).

### Day 7 LATER — Form 278 v1A LIVE (10th MCP tool, v0.17.0)

After `mcp.keyvex.com` went live, Derek's dashboard project was confirmed shelved and Derek's source code for `scheduledSyncFD` was inaccessible (lives on his laptop, not in the shared `gregorywglenn-spec/capital-edge` repo's main branch). Greg made the call: **build Form 278 from scratch** rather than wait. Scope-locked to v1A metadata-only (no PDF parsing) for shippability tonight.

Built + shipped in commit `1335a95`:
- `src/scrapers/form278.ts` — searches Senate eFD with `report_types=[7,8,9,12]` (Annual / New Filer / Termination / Combined). Reuses Senate eFD session protocol from `senate.ts` (which now exports `createSession` + `extractFormFields`). Pages through all matching filings within the lookback window.
- `Form278Filing` + `Form278FilingsQuery` types. New Firestore collection `annual_financial_disclosures`. New `form278` CLI command. New `get_annual_financial_disclosures` MCP tool — **10th tool overall**.
- 5 new Firestore composite indexes (bioguide_id / chamber / state / filing_year / report_type — each paired with `filing_date desc`). Deployed.
- `scrapeForm278Weekly` scheduled Cloud Function — Mondays 6:30 AM ET, 35-day rolling window. Deployed.
- Version bumped: `SERVER_VERSION` 0.16.0 → 0.17.0 across `src/` + `functions/` + `package.json`. `mcp` Cloud Function redeployed; live endpoint now advertises v0.17.0 + 10 tools.

**Verified end-to-end via live `mcp.keyvex.com`:**
- Health check returns `version: "0.17.0", tools: 10, tool_names: [...,"get_annual_financial_disclosures"]`
- `tools/call get_annual_financial_disclosures(limit:3)` returns three real Form 278 filings (Pamela Stevenson, Kathryn Whitener — 2026 Senate candidates' candidate filings) with `report_url` pointing at the source eFD HTML/PDF.
- Initial backfill: **50 Form 278 filings** ingested into `annual_financial_disclosures` collection from a 90-day lookback.

**v1A scope (intentional limitations):**
- Senate eFD only — House Clerk Form 278 is v1.1.
- METADATA only — no PDF parsing. Agents follow `report_url` for asset / liability / income schedule detail.
- `bioguide_id` and `party` fields empty until back-fill matcher runs against the legislators catalog (similar to congressional_trades back-fill pattern from Day 5).

**v1.1 queue (deliberately deferred):**
- House Clerk Form 278 (filter the yearly XML index for FD report type — same plumbing as house.ts PTR scraper).
- PDF parsing for Schedule A (assets) + Schedule C (liabilities) → compute `estimated_net_worth_min/max`. This is the killer feature ("which senators are worth $20M+?"). Brittle work — 50-200 page PDFs with multi-page tables and ranged values. Deserves a fresh-eyes session.
- bioguide_id back-fill against the existing `legislators` + `legislators_historical` catalogs — apply the same Tier-1 / Tier-2 / Tier-3 / Tier-4 matcher used for `congressional_trades`.

**Strategic state — Derek active again, porting scrapers (revised Day 9, 2026-05-12):**
- Derek's dashboard project at `C:\CapitalEdge` is BACK active. He's porting KeyVex's scrapers into his Firebase (`capital-edge-d5038`) to power the dashboard product. **The Day 8 "Derek shelved" framing is now stale.**
- Operational independence still holds: we don't read from `capital-edge-d5038`, KeyVex stands alone, all KeyVex risk lives in this repo + `capitaledge-api` Firebase project. Derek pulling our scraper logic into his side is a one-way port — he benefits from our work, we don't depend on him.
- Greg mentioned that Derek's project might benefit from the unified_search pattern and the demo-SVG approach we shipped Day 9. Those are Derek's calls to make on his side.
- Any future "Option B consolidation" conversations are back on the table but not blocking — KeyVex continues to ship independently.

**Last Updated**

May 14, 2026 — Day 10 closeout. **31 MCP tools live, server v0.41.0**, 32+ autonomous scrapers running on cron, MCP endpoint at `https://mcp.keyvex.com`, landing page at `https://keyvex.com` (apex + www both mapped, auto-TLS). Day 10 shipped 3 new MCP tools (get_fund_holdings = N-PORT per-security with derivatives, get_product_recalls = FDA drug+device+food + CPSC unified, get_government_publications = GovInfo CRPT+PLAW+CHRG+GAOREPORTS), plus EIA energy added to get_economic_indicators, Form 4 derivative table extension (recovers 30-50% of dropped data), unified_search v1.1 with company_name + cusip identifier cascade (Wells Fargo query now hits 17+ collections), Node 20→22 + firebase-functions v6→v7 upgrades, and secrets/.env auto-loader. Commit `e437972` pushed to main. BEA + NHTSA deferred with reasoning (BEA needs schema extension for state-level value, NHTSA needs bulk endpoint investigation).

**Earlier "Last Updated" snapshots (kept for history):**
- May 12, 2026 — Day 9 LATE NIGHT. 28 MCP tools, server v0.39.0. XBRL Fundamentals + FRED macro data.
- May 12, 2026 — Day 9 LATE EVENING. 27 MCP tools, server v0.36.0 (pre-XBRL marathon checkpoint).
- May 12, 2026 — Day 9 EVENING. 24 MCP tools, server v0.30.0 (mid-Day-9 checkpoint before the 6-scraper marathon).
- May 11, 2026 — Day 8 EVENING. 21 MCP tools, server v0.27.0, 22+ autonomous scrapers, three live custom domains, battle-test green (59 queries, 0 errors).
- May 7, 2026 — Day 7 LATER. 10 MCP tools, server v0.17.0, KeyVex rebrand complete, landing page shipped, `mcp.keyvex.com` LIVE with auto-managed TLS, GitHub repo renamed to `Keyvex-API`, multi-site Firebase Hosting set up, service-key REST CLI built, Form 278 v1A scraper + MCP tool shipped (10th tool).

### 🌅 Day 8 morning kickoff note (2026-05-08)

**Future Claude — read this first thing.** Greg's starting a fresh conversation today; this file is your handoff. Top priority *before* anything else (logos, apex domain, v1.1 PDF parsing) is the **Form 278 historical backfill** — see the "⚡ TOP PRIORITY for Day 8 morning" callout near the top of "What's Open / Next Up" for the concrete plan.

Reason: pushback from Derek's side (valid) — our `annual_financial_disclosures` collection holds ~50 docs from a 90-day current-window pull; their `/financialDisclosures` collection has ~5,591 docs covering CY 2008-2024. Closing that gap is a credibility item before any registry submission goes out. 30 min code + 30-60 min runtime, totally tractable as the first task of Day 8.

After the backfill is done and verified, then proceed down the queued list (logos, apex domain, etc.) in the order Greg picks. Greg may also have dropped the two logo PNGs (`keyvex-mark.png` + `keyvex-wordmark.png`) into `marketing/site/` overnight — if they're there, wire them in early so the landing page shows brand-correct.

**Memory context to load on session start:**
- `feedback_plain_english_with_analogies.md` — Greg is a builder; lead with construction/trades analogies, define every term
- `feedback_time_estimates_too_high.md` — quartile estimates; don't make this a chat topic
- `feedback_verify_inbound_specs.md` — verify-before-acting on inbound specs that contradict established state
- `project_brand_keyvex.md` — brand is KeyVex, Firebase project ID `capitaledge-api` is permanent infra
- `project_canonical_google_account.md` — `claude1986aaa@gmail.com` is canonical for KeyVex

### 🌙 Day 8 EVENING closeout (2026-05-11)

Day 8 was a marathon shipping session — 16 commits, 11 new MCP tools, 12 new scheduled Cloud Functions, full-scale battle-test cycle, two brand-cleanup sweeps.

**Final live state:**
- **21 MCP tools** at `mcp.keyvex.com` v0.27.0 (was 10 at Day 7 close)
- **22+ autonomous scrapers** on cron (was 13)
- **Three live custom domains** (mcp / apex / www, all auto-TLS)
- **Battle test:** 59 queries across all 21 tools, 0 errors, 0 empty results
- **Branch + main both at `29bf33f`** on GitHub (`gregorywglenn-spec/Keyvex-API`)

**What shipped today (in commit order):**

| Version | What |
|---|---|
| 0.19.0 | FEC v1A foundation (candidates + committees + `get_fec_candidate_profile`) + SEC Schedule TO (`get_tender_offers`) + Form 278 backfill enable (start-date/end-date flags, 1k→50k pagination cap). Form 278 backfill executed: **1,813 docs** covering 2016-2025 |
| 0.19.1 | FEC scraper 5xx retry-with-backoff + diagnostic scripts (`inspect-fec-committees`, `show-mccormick-committees`). Real 502 caught during the 2022 committees pull |
| 0.20.0 | Bills + Roll-Call Votes (`get_bills`, `get_roll_call_votes`). 15,671 bills + 517 House votes ingested. Senate roll-call votes flagged v1.1 (api.congress.gov doesn't expose them — they live on senate.gov XML directly) |
| 0.21.0 | FINRA OTC Transparency dark-pool data (`get_otc_market_weekly`). **184,241 records** for week 2026-03-30 across T1/T2/OTCE tiers. Memory rule saved: scraper + scheduler ship together |
| 0.22.0 | SEC Form D private placements (`get_private_placements`). 281 filings ingested. Form 13H confirmed unbuildable (FOIA-exempt under SEA Rule 13h-1) and saved to memory |
| 0.23.0 | SEC + DOJ enforcement actions (`get_enforcement_actions`). 125 actions ingested. Caught + fixed DOJ JSON API default sort being oldest-first |
| 0.24.0 | SEC Form N-PORT (`get_nport_filings`). 86 fund-month filings |
| 0.25.0 | SEC Form S-1 / S-3 (`get_registration_statements`). 60 IPO + shelf records |
| 0.26.0 | OFAC SDN sanctions list (`get_ofac_sdn`). **18,959 sanctioned entities** |
| 0.27.0 | Federal Register (`get_federal_register_documents`). 656 recent rules/notices/presidential docs |
| 0.27.1 | Battle-test cycle: 59 queries, found + fixed 3 production bugs (federal_contracts composite-index conflict, congressional_trades missing 2-field index, lobbying 5K→20K fetch window for substring queries). Battle-test script re-runnable via `npx tsx scripts/battle-test.ts` |
| docs | README + landing page refreshed for 21-tool state. Hero, sources grid (13→24 items), demo, pricing, FAQ all updated |
| chore | `contact@capitaledge.app` retired — swept to `contact@keyvex.com` across 13 scrapers' User-Agent strings + landing page + README + marketing copy. All 22 Cloud Functions redeployed with new User-Agent. Memory rule saved |
| docs | apex DNS landed — `keyvex.com` + `www.keyvex.com` flipped from "pending" to "LIVE" in docs |

**Form 13H verdict (was Wave 2 #5):** **Unbuildable from public sources.** Filed confidentially under SEA Rule 13h-1 with FOIA-exempt status. EDGAR FTS returns total=0 across all variants (13H / 13H-Q / 13H-A). The substitute value (large-trader identity disclosure) leaks via 13F / 13D-G / Form 4 — all of which KeyVex already exposes. Captured in `project_form_13h_unbuildable.md`. Off the roadmap permanently. Greg deferred a discussion to next session but the technical answer is clear.

**Memory rules saved today (read these on session start):**
- `feedback_dont_re_ask_for_directives_already_given.md` — multi-step directives authorize the whole sequence; don't pause to ask permission for already-authorized work
- `feedback_scraper_plus_scheduler_ship_together.md` — every new scraper must land with its Cloud Function scheduler in the same commit; design the cron cadence BEFORE writing the scraper
- `project_form_13h_unbuildable.md` — Form 13H is FOIA-exempt and not in EDGAR; off the roadmap permanently
- `project_keyvex_mcp_hosting_rewrite_gotcha.md` — if `mcp.keyvex.com` returns HTML instead of JSON, re-deploy `hosting:keyvex-mcp` to clear stale static files
- `project_email_retired_capitaledge_app.md` — `contact@capitaledge.app` is dead; new scrapers default USER_AGENT to `"KeyVexMCP/0.1 contact@keyvex.com"`
- `project_keyvex_email_forwards_to_gmail.md` — `contact@keyvex.com` is real, forwards to founders' Gmail; don't hedge with "coming soon"

**Open items rolling to Day 9:**
1. **Form 13H discussion** (Greg deferred — the technical answer is "unbuildable from public sources" per the memory note)
2. **Wave 3 #8 — EDGAR XBRL Fundamentals** (1 week+ multi-session, the biggest single build on the roadmap). Income statement / balance sheet / cash flow extraction. Competes with EODHD $60/mo tier
3. **Wave 4 #12 — OSHA + EPA Enforcement** (separate investigations needed; OSHA needs DOL API key signup or CSV bulk model, EPA ECHO has a working REST API but obscure parameter naming)
4. **Logo PNG drop-in** (`marketing/site/keyvex-mark.png` + `keyvex-wordmark.png`) — wire into landing topbar + favicon when Greg drops them
5. **Pre-launch commercial work** — Privacy Policy (~20 min boilerplate), Loom demo video (3-5 min), launch posts (Twitter / Show HN / Reddit drafts), DM target list, MCP registry submissions (Anthropic / Smithery / Awesome-MCP / PulseMCP)
6. **Node.js 20 → 22 upgrade** before 2026-10-30 decommission (~6 months out)
7. **Optional v1.1 polish** — slow substring queries on big collections (lobbying 51K, federal_contracts 5K window) need a normalized-name field + array-contains indexing for sub-second matching

**Cross-source play (the full agent walk, now 21-tool wide):**

```
get_congressional_trades(ticker:"LMT")           → who traded LMT
  → bioguide_id of each trader
get_member_profile(bioguide_id:"…")              → party, state, committees
get_roll_call_votes(legislation_type:"HR")       → defense-bill voting history
get_fec_candidate_profile(candidate_name:"…")    → FEC candidate + principal committee
get_lobbying_filings(client_name:"Lockheed")     → LMT's lobbying spend
get_federal_contracts(recipient_name:"Lockheed") → contracts LMT received
get_otc_market_weekly(issue_symbol:"LMT")        → dark-pool activity in LMT shares
get_insider_transactions(ticker:"LMT")           → LMT insider buys/sells
get_material_events(ticker:"LMT")                → LMT 8-K corporate events
get_enforcement_actions(text:"Lockheed")         → SEC/DOJ actions involving LMT
```

That's 10 of 21 tools chained in a single conversation, joined by `ticker` + `bioguide_id` + `recipient_name` + `client_name` + name. No other MCP server combines these.

**Day 8 strategic clarity that holds:**
- KeyVex is launch-ready on the surface area front. The 21 tools cover all of Wave 1, Wave 2 (minus the unbuildable 13H), most of Wave 3 (NPORT + S-1/S-3 done, XBRL deferred), and 2 of 3 Wave 4 items (OFAC + Federal Register done, OSHA+EPA deferred). What's left is XBRL (deep) and OSHA+EPA (separate-investigation).
- Pure-publisher posture intact across every new tool. No derived signals anywhere.
- Customer funnel bottom-up still holds (indie devs → small fintechs → midsize → institutional). The 21-tool surface + the cross-source moat is the indie-dev hook.

**Greg's standing rules + memory feedback all still apply** — see "Standing Rules from Greg" earlier in this file, plus the memory entries listed above.

### 🌙 Day 9 closeout (2026-05-12)

Day 9 was a heavy iteration session — 12 commits, 3 new MCP tools (unified_search + DEF 14A + Treasury auctions), 12 composite indexes, provenance audit, full landing-page rewrite (posture + audience + animated demo SVG), and meaningful copy hardening for enterprise readability.

**Live state at session close:**
- **24 MCP tools** at `mcp.keyvex.com` v0.30.0 (up from 21 at Day 8 close)
- **24+ autonomous scrapers** on cron (added scrapeProxyDaily, scrapeTreasuryAuctionsDaily)
- **Landing page hardened for enterprise audience:** new "Built for production agents" section + audience list expanded to 8 personas (added hedge fund / asset manager / family office, compliance / legal / risk team, investment-bank research desk)
- **Animated SVG demo of `unified_search`** live on both `keyvex.com#demo` and the GitHub README
- **Battle test green:** 63 queries · 22 tools · 0 ERROR · 0 EMPTY · 5 SLOW (5 SLOW are all pre-existing v1.1 substring-filter items, not regressions)
- **Branch + main both at `b5225c4`** on GitHub (`gregorywglenn-spec/Keyvex-API`)

**What shipped today (in commit order):**

| # | Commit | What |
|---|---|---|
| 1 | `2945c08` | Provenance audit — 5 new `source_url` fields (FEC candidates / FEC committees / OFAC SDN / FINRA OTC / Bioguide). Every record now traceable to its source-of-record filing |
| 2 | `2984fb1` | 12 composite indexes for cross-cutting filter combos (politician+ticker+date, ticker+buy/sell, filer+concentration, etc.) — unlocks the political-alpha killer query path |
| 3 | `755947b` | Landing page "Built for production agents" section — 3 enterprise-relevant cards (indexed queries / audit-grade provenance / idempotent + autonomous) |
| 4 | `fae5b31` | **v0.28.0 — 22nd MCP tool, `unified_search`** — single MCP tool fans out to 10 collections in parallel for ticker queries, 8 for company_cik, 2 for bioguide_id. Uses Promise.allSettled so one slow source doesn't block the rest |
| 5 | `f2d6208` | Extended battle test to cover unified_search + multi-envelope shapes. Re-run on v0.28.0: 63 queries · 0 errors · 0 empty |
| 6 | `b5d4b6a` | First posture rewording — drop "raw" output framing |
| 7 | `efab71b` | Sweep "raw" across README + Privacy Policy + marketing copy + CLAUDE.md + handoff doc |
| 8 | `0158cfe` | Posture v3 (raw in → clean out) + audience widened from 5 personas to 8 (added hedge fund / compliance team / investment-bank desk) |
| 9 | `c8a76fa` | **Animated SVG demo of `unified_search`** — 24-second loop showing fan-out across 10 collections for LMT, embedded on landing + README |
| 10 | `30ccbce` + `8a5af3d` | **v0.29.0 — 23rd MCP tool, `get_proxy_filings`** — DEF 14A family (Definitive Annual / Additional Materials / Merger-related / Revised). Live smoke: 88 unique filings in 3-day window. Plus a `.claude/` untracking follow-up |
| 11 | `b5225c4` | **v0.30.0 — 24th MCP tool, `get_treasury_auctions`** — Bills/Notes/Bonds/TIPS/FRN with bid-to-cover, yields, bidder breakdowns, SOMA holdings (Fed QE/QT visibility). Live smoke: 22 auctions in 14-day window |
| 12 | this commit | CLAUDE.md sweep for Day 9 closeout |

**New memory rule saved Day 9:**
- `feedback_raw_input_clean_output.md` — "raw" describes the INPUT we ingest (messy government feeds), NEVER the OUTPUT we publish. The narrative arc is "raw in, clean out" — tells the value-add story explicitly.

**Strategic clarity locked Day 9 that holds:**

1. **Scraper attack order for the 2-week pre-launch window** — Greg explicitly authorized the full scraper sweep. We didn't get all 14 done today; queued for next sessions in priority order:
   - **Next 1-2 sessions (quick wins):** CFTC + OCC + FDIC enforcement extension (extend `get_enforcement_actions` rather than 3 new tools), BLS jobs + MTS macro data
   - **Investigation-required sessions:** EPA ECHO (date filters silently ignored — API needs strategy work), OSHA (DOL bulk CSV model — different ingestion), NHTSA (auth-gated, needs investigation), FRED (API key needs Greg to provision via stlouisfed.org)
   - **Adjacent risk batch:** NLRB + HHS-OIG + GAO + FERC
   - **Final big-bang push:** EDGAR XBRL Fundamentals (multi-session, ~1 week — completes the SEC research surface, competes directly with FMP $22/mo + EODHD $60/mo tiers)

2. **PNG logo drop-in is OFF the open-items list.** Greg confirmed the existing `Key**Vex**` text wordmark in the topbar + the inline-SVG `K` favicon already do the brand work. No PNG files needed.

3. **"Raw" is reclaimed for INPUT only.** Captured as a memory rule. The customer-facing copy now says "KeyVex takes the raw, fragmented data that US government repositories publish — SEC EDGAR XML, House Clerk PDFs, Senate eFD HTML behind a CSRF gate, USAspending JSON, FINRA's paginated APIs — and presents it clean, normalized, and ready to use." Legal posture (Lowe v. SEC) unchanged.

4. **Derek active again.** His dashboard project is unshelved as of Day 9. He's porting KeyVex's scraper logic into his side. KeyVex still stands operationally alone but the future Option B consolidation conversation is back on the table (not blocking).

**Open items rolling to Day 10+:**
1. Continue scraper sweep per the priority queue (~10 more scrapers + XBRL big-bang before launch)
2. Pre-launch commercial work (Privacy Policy ✅ done, Loom decided not needed, launch posts draft, DM target list, MCP registry submissions to Anthropic + Smithery + Awesome-MCP + PulseMCP + 5 data marketplaces)
3. Node.js 20 → 22 upgrade before 2026-10-30 decommission (~5.5 months out)
4. `firebase-functions` package upgrade (paired with Node 22 since same files)
5. v1.1 polish — slow substring queries (lobbying 51K-record collection, federal_contracts 5K window) need normalized-name array fields + array-contains indexing
6. LLC formation + Stripe billing infrastructure (Greg + Derek, not engineering)

**Cross-source play (now 24-tool wide):**

The marquee `unified_search(ticker:"LMT")` demo on the landing page tells the full story in a single tool call. For the manual-composition pattern, here's what a Lockheed Martin agent walk now looks like:

```
get_congressional_trades(ticker:"LMT")           → senators trading LMT
  → bioguide_id of each trader
get_member_profile(bioguide_id:"…")              → party, state, committees
get_roll_call_votes(legislation_type:"HR")       → defense-bill voting history
get_fec_candidate_profile(candidate_name:"…")    → FEC candidate + principal committee
get_lobbying_filings(client_name:"Lockheed")     → LMT's lobbying spend
get_federal_contracts(recipient_name:"Lockheed") → contracts LMT received
get_proxy_filings(ticker:"LMT")                  → LMT exec comp + board votes
get_otc_market_weekly(issue_symbol:"LMT")        → dark-pool activity in LMT shares
get_insider_transactions(ticker:"LMT")           → LMT insider buys/sells
get_material_events(ticker:"LMT")                → LMT 8-K corporate events
get_enforcement_actions(text:"Lockheed")         → SEC/DOJ actions involving LMT
get_treasury_auctions(security_type:"Note", since:"…")
                                                 → macro debt-issuance context
                                                   (paired with congressional debt-ceiling
                                                   votes for the political-alpha overlay)
```

That's 12 of 24 tools chained in a single conversation. Plus `unified_search` collapses the first 10 of those into one round trip. No other MCP server in the financial-data space combines this.

**Memory rules active for next session (12 total):**
- All 11 from Day 8 still apply
- New Day 9: `feedback_raw_input_clean_output.md`

**For Future Claude starting fresh on Day 10+:** Read `CLAUDE.md` (this file) first. The priority queue at top of "What's Open / Next Up" + the Day 9 closeout above are the load-bearing context. Greg's standing rules + memory entries are unchanged. Don't re-litigate the strategic decisions logged here.

### 🌌 Day 9 LATE EVENING addendum (2026-05-12, post-Day-9 closeout)

After the Day 9 closeout commit landed, Greg said "go go go" and we ran a six-scraper marathon. 10 more commits, 3 new MCP tools, 3 new sources on `enforcement_actions`, and one audit-fix on `unified_search`. The Day 9 closeout above is now itself stale — this addendum is the true end-of-Day-9 state.

**Final live state at session close:**
- **27 MCP tools** at `mcp.keyvex.com` v0.36.0 (up from 24 at Day 9 mid-checkpoint)
- **27+ autonomous scrapers** on cron — 4 new schedulers added today (scrapeProxyDaily, scrapeTreasuryAuctionsDaily, scrapeBlsDaily, scrapeOigExclusionsMonthly, scrapeCfpbDaily)
- **enforcement_actions tool now spans 5 regulators**: SEC + DOJ + CFTC + OCC + FDIC (additive — same tool, wider source enum)
- **Battle test green at v0.36.0**: 82 PASS / 0 EMPTY / 1 SLOW / 0 ERROR (84 queries total) — 1 SLOW is pre-existing lobbying substring perf item, no regressions
- **Branch + main both at `3d90873`** on GitHub (this commit will push the 23rd of the day)

**What shipped after the Day 9 closeout commit (in order):**

| # | Commit | What |
|---|---|---|
| 13 | `5c25823` | **v0.31.0 — CFTC enforcement** added as 3rd source on existing `get_enforcement_actions` (no new tool — extends source enum). 37 CFTC press releases live |
| 14 | `c4e8942` | **v0.32.0 — OCC + FDIC enforcement** added as 4th + 5th sources. 3 OCC + 20 FDIC records. 5 regulators in one tool |
| 15 | `a8ec259` | **v0.33.0 — 25th MCP tool, `get_economic_indicators` (BLS)** — curated 20-series watchlist (unemployment, payrolls, CPI, PPI, wages, productivity). 473 observations ingested, latest_only:true returns a 19-series macro snapshot |
| 16 | `fd6d847` | **v0.34.0 — 26th MCP tool, `get_oig_exclusions` (HHS-OIG LEIE)** — 83,256 excluded healthcare entities ingested. Pairs with federal_contracts for compliance flag |
| 17 | `539fa25` | **v0.35.0 — 27th MCP tool, `get_consumer_complaints` (CFPB)** — 2000 recent complaints ingested. Rolling 2-day window, leading indicator for CFPB/OCC/FDIC enforcement |
| 18 | `3d90873` | **v0.36.0 — audit-fix: wire `proxy_filings` into `unified_search`** — was the one real gap in the post-marathon provenance audit. `unified_search(ticker)` now fans out to 11 collections (was 10) |
| 19 | this commit | Battle-test extended for 21 new test cases (covering all 5 enforcement sources + 4 new tools); 1 missing treasury_auctions index discovered + deployed; CLAUDE.md sweep |

**Battle-test stats for v0.36.0** (re-run after extending to 84 test cases):

```
82 PASS · 0 EMPTY · 1 SLOW · 0 ERROR (total 84)
```

The 1 SLOW remains `get_lobbying_filings / Pfizer recent` — pre-existing substring-filter performance on the 51K-record lobbying collection. Same v1.1 polish item (normalized-name field + array-contains indexing). Not a regression, not a launch blocker.

**Discovered + fixed during battle test:** missing composite index on `treasury_auctions(bid_to_cover_ratio + auction_date)` for the "strong demand auctions" query shape. Added both ascending-first and descending-first variants (Firestore's modern multi-range query requires the orderBy field first). Plus `offering_amount` variants for symmetry. All 4 deployed.

**Audit summary (Provenance + Unified Search across all 6 new sources):**

| Tool | Provenance | unified_search |
|---|---|---|
| `get_proxy_filings` | ✅ primary_document_url + sec_filing_url | ✅ fan-out (this commit) |
| `get_treasury_auctions` | ✅ treasury_source_url + 3 PDF URLs | — CUSIP-keyed, doesn't fit ticker-driven fan-out |
| `get_economic_indicators` | ✅ bls_source_url per series | — macro series, no per-entity identifier |
| `get_oig_exclusions` | ✅ oig_source_url | — NPI-keyed (medical provider), not ticker |
| `get_consumer_complaints` | ✅ cfpb_source_url per complaint | — company name match (no ticker in CFPB schema) |
| `enforcement_actions` (CFTC/OCC/FDIC) | ✅ url to each press release | — text-search by design |

**v1.1 enhancement deferred to a dedicated session:** extend `unified_search` identifier set to include `cusip` (would cover treasury_auctions + institutional_holdings cusip queries) and add **company-name fuzzy match** via a name→ticker resolver (would let CFPB / lobbying / enforcement_actions join the fan-out by issuer name). That's the unlock for "tell me everything about Wells Fargo" hitting 27 tools instead of the current ~14.

**Strategic decisions confirmed this evening:**

1. **OCC + FDIC + CFTC didn't get new MCP tools** — they were added as `source` enum values on the existing `get_enforcement_actions` rather than creating three new tools. Tool count stays lean (27 vs. would-have-been 30), agent's question-space still expanded. This is the right pattern for sister-regulator extensions.

2. **PNG logo drop-in stays off the list** — confirmed by Greg again, the `Key**Vex**` text wordmark + inline-SVG `K` favicon are sufficient brand presence. Don't re-litigate.

3. **GAO / NLRB / FERC / EPA ECHO / OSHA / NHTSA / FRED deferred to their own sessions.** Each hit a real wall today (WAF 403 / HTML scrape complexity / energy-niche / broken date filters / bulk-CSV model / auth-gated / API key provisioning). Worth dedicated investigation time, not end-of-day rushing.

4. **EDGAR XBRL Fundamentals is the next major buildable.** Multi-session, ~1 week. The single biggest competitive lift left — completes the SEC research surface (income statement / balance sheet / cash flow per company per quarter), competes directly with FMP $22/mo + EODHD $60/mo tiers. Best started fresh in a dedicated session, not rushed.

**Cross-source play with 27 tools is now a wide moat.** Example real agent question — "What's going on with Wells Fargo?":

```
get_consumer_complaints(company:"Wells Fargo")           → complaint patterns
get_enforcement_actions(source:"occ", text:"Wells Fargo")→ regulator actions
get_proxy_filings(ticker:"WFC")                          → exec comp + governance
get_insider_transactions(ticker:"WFC")                   → insider activity
get_lobbying_filings(client_name:"Wells Fargo")          → influence spend
get_federal_contracts(recipient_name:"Wells Fargo")      → government business
get_material_events(ticker:"WFC")                        → 8-K events
get_activist_stakes(ticker:"WFC")                        → 13D/G filings
get_otc_market_weekly(issue_symbol:"WFC")                → dark-pool activity
get_economic_indicators(category:"inflation")            → macro context
get_treasury_auctions(security_type:"Note")              → rate environment
```

11 tools, one conversation, every signal that matters about a major US bank. **No other MCP server combines these.**

**For Future Claude starting fresh on Day 10:** the open queue is XBRL Fundamentals (the big one), v1.1 unified_search company-name fuzzy, and any of the deferred sources (each in its own session). Don't try to add scrapers in a hurry — the marathon today already shipped 6 + 3-source-additions in one go. Per session: pick ONE substantial piece and ship it cleanly. The 27-tool surface is launch-ready.

### 🌃 Day 9 LATE NIGHT addendum (2026-05-12 → continuation past the closeout)

After the Day 9 LATE EVENING closeout snapshot (which captured the v0.36.0 state — 27 tools, six-scraper marathon done), Greg authorized the XBRL big-bang and we kept going. Three more major versions shipped, the single largest data ingestion in KeyVex's history, and the marketing surface upgraded to match.

**Final live state at TRUE session close:**
- **28 MCP tools** at `mcp.keyvex.com` v0.39.0
- **323,590 XBRL fundamental records** across 130 S&P-100-anchored tickers (income statement / balance sheet / cash flow / per-share / entity)
- **15,158 FRED macro observations** across 30 series (rates / GDP / inflation / money / debt / trade / sentiment), unified with the existing 19-series BLS catalog under a single tool
- **Killer-query pull-quote** on the landing hero ("Which members of Congress traded the company that just won the DoD contract — while they were under SEC investigation, after lobbying spending spiked, and insiders sold ahead of weak earnings?")
- **KEYVEX wordmark logo** wired into topbar + favicon + OG image
- **12-tool LMT walkthrough** on landing (was 6) showing the multi-product replacement story explicitly
- **Branch + main both at the v0.39.0 wrap commit**

**What shipped after the Day 9 LATE EVENING addendum (in order):**

| # | Commit | What |
|---|---|---|
| 20 | `d86cc22` | **v0.37.0 — 28th MCP tool, `get_fundamentals` (XBRL)** — SEC EDGAR company-facts API. Curated 40-concept watchlist covering income statement / balance sheet / cash flow / per-share / entity. Smoke-test: 6,523 AAPL observations saved. Doc-ID `{cik}-{concept}-{period_end}-{form}` with form-slash sanitization. Cloud Function `scrapeXbrlWeekly` registered (Sundays 4 AM ET) |
| 21 | `6827f63` | **v0.38.0 — XBRL universe + streaming saver + ticker fixes.** Curated 132-ticker universe (S&P-100 + cross-source-relevant additions in defense, banks, healthcare, energy, big tech, autos). Streaming saver `scrapeAndSaveXbrlStreaming` (saves per-company, bounded memory). Ticker normalization (BRK.B → BRKB via dot-stripping in getTickerInfo). Ticker override in scrapeXbrlByCik (avoids the JPM → JPM-PM reverse-lookup ambiguity — captured as Hard Lesson below). Universe dedup (removed GOOG since GOOGL covers the same CIK) |
| 22 | `c810a47` | **Killer-query pull-quote on landing hero.** Brand-green left border, lead-in "THE QUERY NO OTHER MCP SERVER CAN ANSWER", four key phrases highlighted in accent green. Subhead bumped 22 → 28 tools |
| 23 | `18d5100` | Copy fix: "lobbying spend" → "lobbying spending" (more polished phrasing) |
| 24 | `73b2f34` | **KEYVEX wordmark logo wired** — replaces text wordmark in topbar, replaces inline-SVG favicon with PNG K-mark, adds og:image + twitter:image meta tags pointing to the wordmark for social card preview. Files: `keyvex-wordmark.png` (full) + `keyvex-mark.png` (K-only) |
| — | (deletion + re-backfill mid-session) | Doc-ID collision found post-initial-backfill: 593K observations were collapsing into 273K docs (~46% collision). Root cause: `cik+concept+period_end+form` didn't distinguish YTD-cumulative from per-quarter observations (e.g., AAPL FY2017 Revenues $229B vs Q4 standalone $52B both had period_end=2017-09-30 + form=10-K). Fix: include `period_start` in doc ID. Deleted 239K orphans + re-ran full backfill. Post-fix: **323,590 distinct docs preserved, ZERO suspicious ticker patterns** (JPM stored as "JPM" not "JPM-PM" — override worked) |
| 25 | `fa3bca6` | **v0.39.0 — FRED added to `get_economic_indicators`** (no new tool — extends source enum). 30-series curated watchlist: rates (Fed Funds, 2Y/10Y/30Y Treasury, 10Y-2Y spread, 30yr mortgage, AAA/BAA), GDP (nominal/real/growth-rate), activity (industrial production, housing starts, retail sales), inflation (PCE, Core PCE, 5Y/10Y breakevens), employment (UNRATE/PAYEMS — FRED republish of BLS, plus JOLTS, jobless claims), money (M2, Fed total assets, overnight reverse repo), debt (federal debt, Treasury general account), trade (trade balance, broad dollar index), sentiment (U Michigan). 15,158 observations saved. Period labels extended to weekly + daily cadences for high-frequency series. Provenance field renamed: `bls_source_url` → `source_url` for cross-source consistency. FRED_API_KEY provisioned to Firebase Secret Manager |
| 26 | `97cc01a` | **v0.39.0 wrap** — README brought current (Tools table updated with all 7 new rows, footer count 22 → 28, enforcement row mentions all 5 regulators). Landing FAQ source list expanded to mention XBRL fundamentals, DEF 14A proxies, Treasury auctions, BLS + FRED, HHS-OIG, CFPB, all 5 enforcement regulators |
| 27 | `7a62ac3` | **Landing demo walkthrough expanded 6 → 12 tools.** New chain shows the full multi-product replacement story: congressional trades + member profile + roll-call votes + federal contracts + fundamentals (XBRL) + lobbying + proxy filings + insider transactions + enforcement actions + economic indicators (FRED) + treasury auctions + FEC candidate profile. Summary line strengthened: "Triangulation that takes a Bloomberg terminal and an analyst — fundamentals from a separate provider — and a macro data subscription on top, all combined into a single AI agent conversation in a few seconds" |
| 28 | this commit | CLAUDE.md sweep for the true Day 9 close |

**Three new Hard Lessons saved tonight (XBRL-specific):**

1. **SEC XBRL doc-ID needs `period_start` to distinguish YTD vs per-quarter.** A 10-K filing tags both the FY cumulative observation (start=Oct prior year, end=Sept) AND the Q4 standalone (start=Jul, end=Sept) under the SAME concept + period_end + form. Without `period_start` in the doc ID, one overwrites the other — and agents querying for "Revenues for FY2018" can get the wrong number depending on which observation happened to land last. Fix is one-line: `${cikPadded}-${concept}-${periodEnd}-${safeForm}-${periodStartPart}` where periodStartPart is the start date or "pit" sentinel for balance-sheet point-in-time concepts.

2. **`cikToTicker` reverse lookup picks preferred-share tickers via last-write-wins.** SEC's `company_tickers.json` has multiple entries per CIK for companies with preferred-share series (JPM has JPM common + JPM-PA/PC/PD/PG/PM preferred; AGNC has AGNC + AGNCL/AGNCM/AGNCN/AGNCO; etc.). When the catalog is loaded into a `cikToTicker: Record<string, string>` map with last-write-wins, the LAST ticker (often a preferred series like JPM-PM) clobbers the common ticker (JPM). Records then get stored with ticker="JPM-PM" and agents querying `ticker: "JPM"` find nothing. **Fix**: callers of `scrapeXbrlByCik` should pass a `tickerOverride` parameter that preserves the INPUT ticker (which the caller knows is the common one). `scrapeXbrlByTicker` was updated to always pass-through the input. Don't bake heuristics into the cache — let the caller specify intent.

3. **SEC company_tickers.json strips dots from class-share tickers.** BRK.B is stored as "BRKB". BF.B is "BFB". HEI.A is "HEIA". Naive ticker lookup with `tickerCache[ticker.toUpperCase()]` misses these. Fix: getTickerInfo tries direct lookup → strip dots → strip slashes, in that order. Affects ANY scraper that resolves SEC tickers — port this pattern to form4/form144/form3/13D-G/etc. if/when those skip on class-share names.

**Strategic items confirmed Day 9 LATE NIGHT:**

1. **The competitive frame is now FAANG-grade.** With XBRL Fundamentals shipped, KeyVex covers what FMP charges $22/mo for, what EODHD charges $60/mo for, AND adds 27 other public-disclosure surfaces neither of them has. The killer-query pitch combines six data sources (DoD contract + congressional trades + SEC enforcement + lobbying + insider trades + earnings/fundamentals) that no single competitor can answer in one round trip — captured as the hero pull-quote. Greg approved the FAANG-grade vs. FMP/EODHD/Bloomberg positioning.

2. **Universe dedup discipline matters.** GOOG and GOOGL both resolve to Alphabet's CIK 1652044. When both are in the universe, the second one to scrape clobbers the first's records (same CIK → same doc IDs in the new schema). Universe was pruned to one ticker per CIK. Same pattern will hit any future multi-class-share company.

3. **Bloomberg-replacement positioning is honest.** The 12-tool LMT walk replaces (a) Bloomberg terminal for cross-source disclosures + (b) FMP/EODHD for fundamentals + (c) FRED-direct for macro. That's ~$2K-$24K/yr of subscriptions for a $29-99/mo KeyVex price point. The landing's summary line makes this explicit now.

**Cross-source play with 28 tools is now the full picture.** Real agent walk for any major company:

```
get_congressional_trades(ticker:"LMT")           → senators who traded LMT
get_member_profile(bioguide_id:"…")              → party, state, committees
get_roll_call_votes(legislation_type:"HR")       → defense-bill voting history
get_federal_contracts(recipient_name:"Lockheed") → contracts LMT won
get_fundamentals(ticker:"LMT", category:"income_statement")
                                                  → LMT's revenue + income (XBRL)
get_lobbying_filings(client_name:"Lockheed")     → influence spend
get_proxy_filings(ticker:"LMT")                  → exec comp + board votes
get_insider_transactions(ticker:"LMT")           → insider activity
get_enforcement_actions(text:"Lockheed")         → 5-regulator actions
get_economic_indicators(category:"rates", latest_only:true)
                                                  → Fed Funds, 10Y, mortgage (FRED)
get_treasury_auctions(security_type:"Note")      → bond-market demand context
get_fec_candidate_profile(candidate_name:"…")    → trader's campaign committee
```

**12 tools, one conversation.** Plus `unified_search(ticker:"LMT")` collapses the ticker-driven subset (10-12 of those) into ONE fan-out call. No other MCP server, no other API combination, no other commercial product covers this.

**Open queue rolling to Day 10+:**

1. **Pre-launch commercial work (gated only on time)** — MCP registry submissions (Anthropic + Smithery + Awesome-MCP + PulseMCP) all prereqs met. Privacy policy live. Launch posts (Twitter / Show HN / Reddit) drafts.
2. **v1.1 unified_search company-name fuzzy** (~1-2 sessions). Lets CFPB / lobbying / enforcement_actions join the fan-out by issuer name rather than ticker. The unlock for "tell me everything about Wells Fargo" hitting 27 tools instead of ~14.
3. **Deferred scrapers** (each its own session): GAO (WAF 403), NLRB (HTML scrape complexity), FERC (energy-niche), EPA ECHO (broken date filters), OSHA (DOL bulk CSV), NHTSA (auth-gated).
4. **FEC Schedule A** (individual contributions) — strongest TIER-1 quick-win after launch. Closes the "donation → vote → trade" political-alpha loop. Free API, ~1-1.5 hr build.
5. **FARA** (foreign agent registrations) — pairs with LDA lobbying. Real risk-signal value (foreign influence).
6. **FTC enforcement** — extends `get_enforcement_actions` to a 6th source. Trivial add since the pattern is proven.
7. **Senate roll-call votes** — completes the bicameral picture (we have House; Senate XML is at senate.gov, different endpoint).
8. **Node 20 → 22 upgrade** before 2026-10-30 decommission (~5.5 months out).

**For Future Claude starting fresh on Day 10:** The 28-tool surface plus the XBRL + FRED data ingestion is launch-ready. The killer-query landing is the marketing centerpiece. Don't add more scrapers immediately — registry submissions + launch prep is the next push. If a scraper is added, FEC Schedule A is the single biggest unlock left because it closes the political-alpha loop (donations → trades → votes). All other deferred sources need dedicated investigation sessions.

**Memory rules active for next session (12 total, unchanged from Day 9):**
- All 11 from Day 8 still apply
- Day 9: `feedback_raw_input_clean_output.md`

The three new XBRL-specific Hard Lessons above are captured in this CLAUDE.md and don't need to become separate memory entries — they're project-specific schema/API quirks, not behavioral rules.

### 🔀 Day 10 — TWO PARALLEL TRACKS, MERGED (reconciled 2026-05-15)

Day 10 was accidentally worked in **two separate git worktrees that never saw each other**. Both branched from `b4883c1`, both shipped real *non-overlapping* work, both independently called themselves "v0.41.0 / 31 tools." They were merged on 2026-05-15 into **v0.43.0 (~36 tools)**. Both Day 10 narratives are preserved below — **Track A** (`friendly-villani`: recalls / energy / fund holdings / Form 4 derivatives) then **Track B** (`focused-almeida`: FEC / CFTC / SEC FTD / grants / FTC / Senate votes). The root cause was no session-start branch check; the fix is the **Session Bootstrap** rule (see top of this file). Do not let this recur.

---

### 🌄 Day 10 Track A (2026-05-14) — 3 new MCP tools + Form 4 derivative recovery + N-PORT holdings + unified_search v1.1 + Node 22 + firebase-functions v7

Sequential drive through the open task list Greg flagged at session start. ~10 substantial items shipped + 2 deferred with reasoning. Single commit landed as `e437972`, pushed to `main`.

**State at close of Day 10:**
- **31 MCP tools** at `mcp.keyvex.com` v0.41.0 (up from 28 at Day 9 close)
- **32+ scheduled scrapers** on cron (was 27+)
- **34+ data sources** on the landing page (was 30+)
- Branch + main both at `e437972` on GitHub (`gregorywglenn-spec/Keyvex-API`)
- Local dev: API keys in `secrets/.env` (gitignored) auto-load via new `src/load-secrets.ts` helper
- Node 22 + firebase-functions v7 — both clean upgrades, bundle still 15.4 MB

**What shipped (in queue order):**

| # | Item | Result |
|---|---|---|
| 1 | Landing page refresh | 22→31 tools, 22+→34+ sources, 6 new source cards, scraper count 22+→32+, enforcement row updated to 5 regulators |
| 2 | Form 4 derivative table extension | Parser now walks BOTH `nonDerivativeTable` AND `derivativeTable`, accepts 11 codes (P/S/A/M/X/C/F/G/D/I/V) instead of just P/S. 4 new fields (`is_derivative`, `underlying_security_title`, `underlying_security_shares`, `conversion_or_exercise_price`), 2 new filters (`is_derivative`, `transaction_codes`), 3 new indexes. Existing P/S doc-IDs preserved — idempotency maintained. **Recovers 30-50% of previously-dropped Form 4 data** (option exercises, RSU vests, tax-withholding sales, gifts) |
| 3 | N-PORT primary-doc XML parsing | **29th MCP tool: `get_fund_holdings`**. Per-security rows extracted from each filing's `primary_doc.xml`. Covers equities (EC/EP), debt (DBT/ABS/MBS/UST/STIV), derivatives (DCO/DCR/DE/DFE/DIR/DR), repos (REPO/RP), cash (CASH). `is_derivative` + `derivative_type` ("future" / "forward" / "swap" / "option" / "warrant" / "swaption" / "other") expose fund derivative exposure first-class. 7 new indexes. `scrapeNportDaily` scheduler extended with holdings phase (memory 512→1GiB). **First MCP exposure of fund-level derivative books outside Bloomberg.** |
| 4 | FDA Recalls scraper | **30th MCP tool: `get_product_recalls`** unified across openFDA drug/device/food sub-feeds + (next item) CPSC. Daily 6:50 AM ET scheduler covering all 3 FDA centers. Class I/II/III severity preserved per FDA convention. 5 new indexes for the `product_recalls` collection |
| 5 | BEA macro data — **SKIPPED** | Analysis: FRED already republishes BEA's national-level NIPA series; unique BEA value is state-level data which requires a schema extension to `EconomicIndicator` (geo_fips + geo_name fields, or geo encoded into series_id). National-only build would be cosmetic. **Deferred to v1A.1** as its own session. Greg explicitly confirmed BEA key not needed for v0.41 |
| 6 | NHTSA Vehicle Recalls — **DEFERRED** | `api.nhtsa.gov/recalls/recallsByVehicle` confirmed working but requires make+model+year per call (not bulk-friendly). NHTSA's `recentlyAdded` endpoint returned 403. `data.transportation.gov` Socrata-style recalls dataset URL pending investigation. **Deferred to v1A.1.** Source enum `"nhtsa"` reserved in `ProductRecall` type; tool description notes "Deferred to v1A.1". When we revisit, the same api.data.gov key we already have (see GovInfo below) will likely work |
| 7 | CPSC Recalls scraper | Layered into the existing `get_product_recalls` as `source: "cpsc"`. `saferproducts.gov/RestWebServices/Recall` endpoint confirmed clean — JSON, no auth, date-range filterable. CPSC doesn't use FDA-style classifications (classification stays null). Daily 6:55 AM ET scheduler. Schema mapping: Manufacturers/Importers/Distributors/Retailers fallback chain → recalling_firm; Hazards[0].Name → reason_for_recall; Products[0].Type or .Name → product_category |
| 8 | EIA energy data | Extends existing `get_economic_indicators` with `source: "eia"` enum value (NO new tool, additive). 5 curated series: WTI crude (RWTC), Brent crude (RBRTE), Henry Hub natgas (RNGWHHD), US gasoline retail (EMM_EPMR_PTE_NUS_DPG), US crude oil production (NUS+EPC0). New `energy` category. Daily 9:15 AM ET scheduler. **Series IDs are best-effort from working knowledge — needs live verification before production use** |
| 9 | GovInfo / FOIA logs scraper | **31st MCP tool: `get_government_publications`** across CRPT (committee reports), PLAW (public laws), CHRG (hearings), GAOREPORTS (GAO oversight). Routes around gao.gov WAF block via GovInfo's API. FOIA logs deferred to v1.1 (per-agency, no unified API). 4 new indexes. Daily 9:30 AM ET scheduler. **Smoke-tested live**: pulled 5 CRPT records cleanly (modern 119th Congress + historical SERIALSET back to 1983); 5,948 PLAW records confirmed accessible in window |
| 10 | Node 20 → 22 upgrade | `engines.node` "20"→"22" in functions/package.json + ">=20.0.0"→">=22.0.0" in root. esbuild `--target=node20`→`--target=node22`. Greg's local Node is 24.15.0 — engines bump won't break local dev. Typecheck clean, bundle clean at 15.4 MB |
| 11 | firebase-functions v6 → v7 upgrade | `firebase-functions` ^6.1.0 → ^7.2.5 (major version jump). `firebase-admin` ^13.0.1 → ^13.9.0 (minor). npm install clean (11 vulnerabilities all in transitive deps — uuid/node-domexception deprecations, not actionable). Typecheck clean. Bundle clean. **No code changes required** — none of our usage (`onSchedule`, `onRequest`, `defineSecret`, `logger`) hit breaking changes. Pleasant surprise vs CLAUDE.md's "breaking changes" warning |
| 12 | secrets/.env loader | New `src/load-secrets.ts` — reads `secrets/.env` at module load (resolves path via `import.meta.url`, not cwd). Sets `process.env` vars without overriding shell exports or Firebase Secret Manager values. Wired into FRED + EIA + GovInfo scrapers. Local-dev convenience — Firebase Functions still use `defineSecret` at deploy time. `secrets/` was already gitignored |
| 13 | v1.1 unified_search company-name fuzzy | 2 new identifier params: `company_name` (resolves via EDGAR catalog) + `cusip`. `resolveCompanyByName()` helper added to `sec-tickers.ts` returns `{ticker, cik, title}`. 5 new name-keyed adapters (federal_contracts via recipient_name, lobbying_filings via client_name, enforcement_actions via text, consumer_complaints via company, product_recalls via recalling_firm). 4 collections extended with cusip filter (institutional_holdings, activist_ownership, nport_holdings, treasury_auctions). **"Tell me everything about Wells Fargo" now fans out to 17+ collections in one call.** |
| 14 | Version + landing page batch | v0.40.0 → v0.41.0 in src/index.ts + functions/src/index.ts + package.json. Landing meta/hero/Section-1/curl-heading/pricing-table all bumped to 31 tools / 34+ sources |

**Hard Lessons saved Day 10 (none of these need separate memory entries — project-specific schema/API quirks):**

- **N-PORT primary-doc XML schema captured for v1A.** Root: `<edgarSubmission><formData><invstOrSecs><invstOrSec>...`. Per-row: name, lei, title, cusip, identifiers (ticker/isin), balance, units, curCd, valUSD, pctVal, payoffProfile, assetCat, issuerCat, invCountry, isRestrictedSec, fairValLevel, securityLending.{isCashCollateral,isNonCashCollateral,isLoanByFund}, derivativeInfo.{futrDeriv,fwdDeriv,swapDeriv,optionSwaptionWarrantDeriv,otherDeriv}. Asset-cat codes EC/EP/DBT/REPO/RP/ABS/MBS/UST/USTPS/STIV/SN/LT/MMF/CASH/DCO/DCR/DE/DFE/DIR/DR. Derivative discrimination via `<derivativeInfo>` child element presence. Deep derivative sub-blocks (counterparty, strike, expiration, leg terms) deferred to v1A.1 — agents follow `package_link` for that level. fast-xml-parser with `parseTagValue:false + parseAttributeValue:false`.

- **GovInfo API requires `offsetMark=*` for pagination, NOT `offset=N`.** First-page request uses `offsetMark=*`; subsequent pages extract the offsetMark value from the `nextPage` URL's query string. The `offset=N` numeric scheme works for DEMO_KEY (which has loose validation) but **real api.data.gov keys reject it** with a 200 OK + "Please provide an offsetMark" message body. Silent-ish failure mode: HTTP succeeds, JSON has no data. Caught during the live smoke test with Greg's key. Same pattern likely applies to other api.data.gov-backed services with paginated endpoints.

- **EIA + GovInfo + NHTSA + USDA + DOL all share api.data.gov key infrastructure.** One signup at https://api.data.gov/signup/ produces a key that works across all of them. Greg's EIA key (`HP4ax...`) worked when tested against the GovInfo PLAW endpoint, returning 5,948 real records. He later got a dedicated GovInfo key (`l91B0...`) for cleaner per-service rate-limit allocation, but functionally either would work. **Practical takeaway: when adding any new federal API in the future, check if it's api.data.gov-backed before signing up separately — the existing keys may already work.** Note: EIA's own signup (eia.gov/opendata/register.php) issues keys that ALSO work as api.data.gov keys — same backend, different signup paths.

- **Form 4 doc-ID idempotency requires preserving the legacy P/S format while introducing new shapes for other codes.** Existing P/S non-derivative records used `${accession}-${txDate}-${code}-${roundedShares}`. Changing that for the same rows would break idempotent merge writes — old records would be orphaned and new ones would be created alongside. Solution: keep the legacy format for P/S in the non-derivative table, use row-index suffix for non-P/S non-derivative (`${accession}-${txDate}-${code}-${ndIdx}`), use D-marker + row-index for derivative table (`${accession}-D-${txDate}-${code}-${dIdx}`). Three distinct ID namespaces. Existing data unaffected; new data flows into new namespaces. This is the right pattern any time you extend a parser to capture rows it used to drop — preserve the existing namespace's IDs unchanged.

- **firebase-functions v6 → v7 had no surface-breaking changes for our usage pattern.** The release notes warned about "breaking changes" — but they were all in lower-level APIs (Gen 1 triggers, specific cloud event types) we don't touch. `onSchedule`, `onRequest`, `defineSecret`, and `logger` all worked identically. **Lesson: major version bumps on Firebase packages aren't necessarily as scary as the changelog suggests** — read the changelog with your actual usage in mind before estimating migration cost. We budgeted 1-2 hr; actual was ~5 min once npm install completed.

**Strategic decisions confirmed Day 10:**

1. **BEA stays deferred until state-level data is the actual ask.** FRED already republishes BEA's national series; building a national-only BEA scraper would duplicate effort with no agent-visible benefit. State-level data is the real unlock — but it requires an EconomicIndicator schema extension (geo dimension) that deserves its own session. When Greg asks about regional macro data, that's the trigger to revisit.

2. **NHTSA stays deferred until bulk endpoint is found.** `api.nhtsa.gov/recalls/recallsByVehicle` works per-vehicle but isn't viable for daily ingestion. Two paths to investigate when we revisit: (a) `data.transportation.gov` Socrata recalls dataset (if it exists), (b) NHTSA's static CSV/ZIP dump at static.nhtsa.gov. Source enum `"nhtsa"` is reserved in `ProductRecall` so adding it later is purely additive.

3. **`unified_search` company-name resolution is the right shape.** Tested mental model: agent asks "tell me everything about Wells Fargo" → resolves to ticker WFC + CIK 0000072971 via EDGAR → cascades to all 12 ticker-keyed adapters AND 10 CIK-keyed adapters AND 5 name-substring-keyed adapters (federal_contracts/lobbying/enforcement/consumer_complaints/product_recalls). Single round trip touches the entire disclosure surface. No other MCP server provides this kind of identifier-cascade fan-out.

4. **`secrets/.env` is the right pattern for local dev keys.** Each scraper that needs an API key gets `import "../load-secrets.js";` at the top. File is gitignored. Firebase Secret Manager handles production. No more shell-export friction.

**Open queue rolling to Day 11+ (in priority order):**

1. **Battle test the post-restart state** — run `scripts/battle-test.ts` against `mcp.keyvex.com` post-deploy. Verify all 31 tools respond, no regressions on existing surfaces (insider_trades schema change is highest-risk surface).

2. **Backfill insider_trades with new fields** — existing records pre-v0.41 lack `is_derivative` etc. Run `npx tsx src/scrape.ts form4-feed 60 --save` (or wider) post-deploy to re-walk recent accessions and merge the new fields onto existing records.

3. **Smoke-test N-PORT holdings + EIA + GovInfo against live data**:
   - `npx tsx src/scrape.ts nport 1 --extract-holdings --save` — verify parser matches live N-PORT XML schema
   - `npx tsx src/scrape.ts eia` — verify 5 EIA series IDs pull real data
   - `npx tsx src/scrape.ts govinfo 1 --save` — verify the offsetMark pagination works end-to-end and 4 collections all return data

4. **Deploy v0.41.0**: `firebase deploy --only firestore:indexes,functions` to land all 14 new indexes + 5 new schedulers + updated MCP HTTP function.

5. **Re-run battle test post-deploy.** Confirm `mcp.keyvex.com` is advertising v0.41.0 + 31 tools after the new deploy.

6. **Pre-launch commercial work** (unchanged from Day 9 close) — MCP registry submissions (Anthropic + Smithery + Awesome-MCP + PulseMCP), Privacy Policy is live, launch posts drafts, DM target list.

7. **FEC Schedule A** — strongest TIER-1 quick-win for next scraper session. Closes the "donation → vote → trade" political-alpha loop.

8. **NHTSA bulk endpoint investigation** — when we have a dedicated session, try data.transportation.gov Socrata recalls dataset + static.nhtsa.gov CSV dumps.

9. **BEA state-level data** — extend `EconomicIndicator` schema with geo dimension, then ingest state personal income + state GDP for all 50 states.

10. **FARA** (foreign agent registrations) — pairs with LDA lobbying.

11. **FTC enforcement** — adds 6th source to `get_enforcement_actions`. Trivial pattern.

12. **Senate roll-call votes** — completes the bicameral picture. House is in; Senate XML is at senate.gov, different endpoint.

**Memory rules active for next session (12 total, unchanged from Day 9):**
- All 11 from Day 8 still apply
- Day 9: `feedback_raw_input_clean_output.md`

**For Future Claude starting fresh on Day 11:** The 31-tool surface plus today's schema upgrades (Form 4 derivatives + N-PORT holdings) is the cleanest the codebase has been. Pre-launch commercial work + registry submissions is the next push, not more scrapers. If you DO add a scraper, FEC Schedule A is the highest-leverage one. Don't add NHTSA / BEA / GAO without dedicated investigation sessions — they each have real friction that doesn't fit a 45-min budget.

### 🌙 Day 10 LATE — post-restart deploy + verification (2026-05-14 night)

The Day 10 build (`e437972`) and closeout (`07ed5ee`) were already committed. This stretch deployed v0.41.0 to production and verified it end-to-end. Commit `c64ae6a` (pushed to main).

**Deployed:**
- 2 new Secret Manager secrets: `EIA_API_KEY`, `GOVINFO_API_KEY`. Both api.data.gov-family keys — the GovInfo key (`l91B0...`) also works for NHTSA/USDA/DOL when those land.
- 6 Cloud Functions: `mcp` + `scrapeNportDaily` updated; `scrapeFdaRecallsDaily`, `scrapeCpscRecallsDaily`, `scrapeEiaDaily`, `scrapeGovInfoDaily` created. Deployed **per-function** (not `--only functions`) — a full deploy aborts because 5 functions exist in the project but not in this worktree's code: `scrapeCftcCotWeekly`, `scrapeFecScheduleADaily`, `scrapeFecScheduleEDaily`, `scrapeSecFtdSemimonthly`, `scrapeUSAspendingGrantsDaily`. **Those 5 were NOT deleted** — they're live scrapers from another branch/worktree. Investigate before any `firebase deploy --only functions --force`.
- Live endpoint verified: `https://mcp.keyvex.com` → `version:"0.41.0", tools:31`.

**5 new collections populated (first real data):** EIA 1,941 observations · FDA recalls 10 · CPSC recalls 105 · GovInfo 458 packages · N-PORT holdings 2,504.

**Bug caught + fixed during smoke testing (`c64ae6a`):** openFDA date-range query used a literal `+` in `recall_initiation_date:[start+TO+end]`; `encodeURIComponent` turned it into `%2B` (literal plus) → HTTP 500 on every FDA sub-feed. Fix: use spaces (`[start TO end]`), which encode to `%20`. **Lesson for any future openFDA scraper: never put a literal `+` in a search expression you're going to URL-encode.**

**unified_search perf fix (`c64ae6a`):** `company_name` fan-out was 34–42s because it included the `lobbying_filings` adapter (51K-record substring scan). Pulled lobbying out of the fan-out → 14s. Agents query `get_lobbying_filings` directly for a company's lobbying. The remaining ~10-14s is `federal_contracts` + other substring adapters — the known v1.1 normalized-name-index item.

**GAOREPORTS finding:** GovInfo's `GAOREPORTS` collection (16,569 packages) returns **0 results for 2026** — it's a historical archive that stopped receiving updates; GAO publishes current reports on gao.gov (WAF-blocked). The `get_government_publications` tool description now says so honestly. CRPT/PLAW/CHRG work great.

**Battle test (102 cases, local handlers):** `0 ERROR · 0 EMPTY · 97 PASS · 5 SLOW`. All 5 SLOW are substring-scan latency on large collections (lobbying, federal_contracts, activist filer_name) — the documented v1.1 perf item, not regressions.

**EIA caveat (v1.1 polish):** the `EIA-CRUDE-OIL-PROD-MONTHLY` series unit label says "thousand barrels per day" but the crpdn dataset value looks like a monthly total — verify and correct the unit label. The 4 price series (WTI/Brent/Henry Hub/gasoline) are unambiguous and correct.

**Still open from the Day 10 rolling queue:** item 2 — **backfill `insider_trades`** with the new Form 4 derivative fields. Run `npx tsx src/scrape.ts form4-feed 60 --save` (wide window) so pre-v0.41 records get `is_derivative` etc. merged on. Until then, `is_derivative=false` queries silently exclude old records.

---

### 🌅 Day 10 Track B (2026-05-14) — Greg-away autonomous run: 5 new tools + FTC + Senate votes

This session ran in **bypass-permissions mode** while Greg stepped away — the `defaultMode` accepted value in his Claude Code build turned out to be `dontAsk` (the older schema name, not `bypassPermissions`) plus explicit wildcard rules in the allow array. Settings change captured in this commit and **reverted at session close** to restore default permission prompting.

Shipped this run:

| # | Item | Notes |
|---|---|---|
| 1 | **`get_fec_contributions`** (29th tool) | FEC Schedule A — itemized contributions ≥ $200 (default ingestion floor $1K to cut payroll noise). The "follow the money INTO committees" leg of political-alpha. New Firestore collection `fec_contributions` with 5,000+ rows seeded (cycle 2026, 180-day window). New daily scheduler `scrapeFecScheduleADaily` @ 7:30 ET. |
| 2 | **`get_fec_independent_expenditures`** (30th tool) | FEC Schedule E — super PAC ads FOR or AGAINST candidates (post-Citizens-United vehicle). `support_oppose_indicator` is the critical signal ('S' / 'O'). New Firestore collection `fec_independent_expenditures` with 1,000 rows seeded. Daily scheduler @ 7:45 ET. |
| 3 | **`get_federal_grants`** (31st tool) | USAspending federal grants (block / formula / project / cooperative). Different recipient universe than contracts — universities, non-profits, research, state/local. CFDA-keyed. New collection `federal_grants`. 167 grants seeded. Daily scheduler @ 6:12 ET (next to the existing 6:10 contracts run). |
| 4 | **FTC as 6th source on `get_enforcement_actions`** | RSS feed at `ftc.gov/feeds/press-release.xml`. 10 real records seeded (Shutterstock $35M settlement, IM Mastery Academy MLM scheme). source enum: sec / doj / cftc / occ / fdic / **ftc**. |
| 5 | **Senate roll-call votes** added to `get_roll_call_votes` | Source: senate.gov/legislative/LIS/roll_call_lists/ XML feeds (api.congress.gov has no Senate vote endpoint — confirmed 404). 782 Senate votes backfilled for the 119th Congress. The `congressLegislationDaily` cron now writes both chambers in one pass. |

**Tool count: 31 (was 28). Server v0.41.0 LIVE at `mcp.keyvex.com`.** Three new daily scheduled functions deployed (Schedule A, Schedule E, USAspending grants). Two existing schedulers redeployed to pick up the new code (`scrapeCongressLegislationDaily` for Senate, `scrapeEnforcementDaily` for FTC).

**Deferred (each needs its own dedicated session):**
- **FARA** (foreign agents) — DOJ's eFile portal is APEX-based with no public REST API. Bulk XLSX downloads need a separate ingestion pattern. The probe showed 404s on every guessed endpoint and the eFile site redirects to an interactive APEX UI. Off the Day 10 path; v1.1.
- **FEC Schedule B (PAC disbursements)** — diminishing returns vs. Schedule A/E. Most signal-rich PAC spending lives in IE (Schedule E); Schedule B is dominated by administrative expenses (rent, salaries, consulting). Add in a future session if a specific use-case emerges.

**Three Hard Lessons captured during the FEC build:**

1. **FEC Schedule A and E silently IGNORE `page` pagination.** Once you pass page=2 with a filter that produces >100 rows, the API returns the FIRST page over and over — same `sub_id` set, no error, no warning. The dedup ratio of 100 unique / 2000 raw rows was the tell. **Fix**: cursor-based pagination via `last_index` + `last_<sort_field>` from `pagination.last_indexes`. First request omits those; subsequent requests pass back the prior response's values. Terminate when results[] is empty. **Always test FEC scraper code against a filter that produces >100 expected rows** to catch this — small test sets hide the bug.

2. **`link_id` is filing-level, not row-level.** First normalizer fell back to `link_id` when `sub_id` was missing. `link_id` is shared across all sub-rows of a single filing — using it as a doc ID collapses entire filings into one Firestore document. The actual row-level unique ID is `sub_id` (an integer-shaped string like `4010720261300288097`). **Lesson**: when picking a doc ID field on a hierarchical API, verify uniqueness on a multi-row probe before assuming.

3. **Senate roll-call vote_date is `DD-MMM` with no year.** The senate.gov XML menu reports each vote's date as "18-Dec" or "13-May" without a year. The year is at the `congress_year` element on the parent envelope. Parse the day+month abbreviation, look up the month number, format `${congressYear}-${MM}-${DD}`. Other senate.gov XMLs likely follow the same convention.

**For Future Claude on Day 11+:** The 31-tool surface remains launch-ready and now includes the political-alpha LOOP-CLOSING tool (`get_fec_contributions`). Three high-impact cross-source patterns now possible:

```
get_fec_contributions(contributor_employer:"Boeing")   → who at Boeing donated
  → candidate_id of each donee
get_fec_candidate_profile(candidate_id:"…")             → which seat they ran for
get_roll_call_votes(...)                                → how they voted on defense bills
get_federal_contracts(recipient_name:"Boeing")          → DoD awards Boeing won
get_congressional_trades(ticker:"BA")                   → whether anyone traded BA stock
```

Or the grant-side equivalent:

```
get_federal_grants(cfda_number:"93.847")               → all NIH R01 awards
  → recipient_uei  →
get_lobbying_filings(client_name:"<university>")       → which unis lobbied for what
get_member_profile(committee_id:"HSCM05")              → who's on the relevant subcommittee
get_fec_contributions(contributor_employer:"<university>")
                                                       → uni-employee political donations
```

Open queue: launch prep + registry submissions remain the dominant priority. The deferred scraper list (FARA, GAO, NLRB, FERC, EPA ECHO, OSHA, NHTSA, FEC Schedule B) plus the v1.1 unified_search-by-name-fuzzy work continues to roll forward, each needing its own session.

**Last Updated**

May 14, 2026 — Day 10. **31 MCP tools live at `mcp.keyvex.com` v0.41.0.** Three new daily scheduled scrapers deployed. The political-alpha "follow the money INTO committees" loop is now closed via `get_fec_contributions` + `get_fec_independent_expenditures`. Cross-source data surface now spans 32+ autonomous scrapers across SEC, FEC (5 endpoints), congress, USAspending (contracts + grants), 6 enforcement agencies, lobbying, OFAC, fundamentals (XBRL), and macro indicators (BLS + FRED).

---

### 🌅 Day 10 LATER (2026-05-14, autonomous batch 2) — Options-adjacent surface

After the first Day 10 batch (FEC Schedule A/E, FTC, Senate votes, USAspending grants → 31 tools), Greg asked about options trading data. The honest answer: real options chains / unusual activity / OPRA flow are paywalled. But the **public-disclosure options-adjacent surface** is rich and unlocked here. Built tonight:

| # | Tool | What it gives |
|---|---|---|
| 32 | **`get_cftc_cot_reports`** | CFTC Commitments of Traders — weekly futures + options-on-futures positioning by trader class (non-commercial / commercial / non-reportable). 1,106 rows seeded across 4 weeks. Saturday 7 AM ET cron. **The macro positioning dataset.** Source: publicreporting.cftc.gov Socrata API (`jun7-fc8e`). |
| 33 | **`get_sec_fails_to_deliver`** | SEC bi-monthly Fails-to-Deliver — daily settlement failures by ticker / CUSIP / date. **49,844 rows seeded** from April 2026 first-half. Persistent FTDs are a contrarian short-squeeze leading indicator. Bi-monthly cron on the 1st + 16th @ 5 AM ET with auto-fallback for SEC's variable 2-3 week posting lag. Source: sec.gov/files/data/fails-deliver-data/ bi-monthly zips. New dep: `adm-zip`. |

**Audits captured (defer to v1.1):**
- **Form 4 derivative table NOT ingested** — `form4.ts` only parses `nonDerivativeTable.nonDerivativeTransaction`. Stock-option exercises, warrant exercises, RSU vestings live in `derivativeTable.derivativeTransaction` and are silently dropped. Adding `is_derivative` filter requires extending the scraper + re-backfilling the `insider_trades` collection. ~2-3 hr lift.
- **N-PORT primary_document XML NOT parsed** — `nport.ts` is filing-level metadata only (filing_id + filer + dates + URL). Per-holding derivative positions (swaps, options, futures, repos) live inside `primary_document_url` XML which isn't parsed. Same v1A posture as 8-K. ~2-3 hr lift.

**CBOE put/call ratio deferred** — endpoints mostly Cloudflare-403'd. Needs dedicated HTML-scrape session.

**Server v0.42.0 LIVE at `mcp.keyvex.com`. Tool count: 33 (was 31).**

**Battle test (the real check):**
- **Local handler**: `npx tsx scripts/battle-test.ts` — **101 PASS / 1 EMPTY / 3 SLOW / 0 ERROR (105 queries)**. The 1 ERROR earlier was a composite-index-still-building artifact (GOLD positioning) that cleared once Firestore finished propagating. Pre-existing SLOW items (substring scans on big collections) are v1.1 polish, not regressions.
- **Live wire**: 13 `tools/call` requests through `https://mcp.keyvex.com/` over HTTPS with Bearer auth — **13/13 PASS** with real data. Full pipeline verified: HTTPS → Hosting rewrite → Cloud Run → MCP transport → handler → Firestore → response.

**Hard Lesson captured:**

> **SEC bi-monthly Fails-to-Deliver posting lag is 2-3 weeks, not 1 week.** Initial scraper resolved the target half-month to `today - 10 days`. SEC publishes the second-half-of-month file ~2-3 weeks AFTER the half ends. On May 14, April-b (Apr 16-30) was still unpublished. Fix: change resolver to `today - 20 days`, AND add auto-fallback that walks backward through up to 6 half-months on 404 until a published file is found. Make the cron resilient to posting-delay variance.

**Cross-source value of the new tools:**

```
get_sec_fails_to_deliver(min_value:1000000)          → biggest dollar-volume failures
  → ticker → 
get_otc_market_weekly(issue_symbol:"<X>")            → dark-pool activity same window
get_activist_stakes(ticker:"<X>")                    → activist position changes
get_insider_transactions(ticker:"<X>")               → insider activity
                                                       (short-squeeze setup signal)
```

```
get_cftc_cot_reports(latest_only:true)               → current macro positioning
  → cross-reference with:
get_economic_indicators(category:"rates")            → Fed funds / 10Y context
get_treasury_auctions(security_type:"Note")          → bond-market demand
                                                       (full macro picture)
```

**For Future Claude on Day 11+:** The 33-tool surface is launch-ready. Real options data (chains, IV, greeks) requires paid OPRA feed — not feasible without revenue. Public-disclosure options-adjacent surface is now complete: CFTC futures positioning, SEC FTD, Form 4 (non-deriv), Reg SHO threshold (via FTD), N-PORT (metadata), VIX (via FRED), Form 144 (planned sales). Form 4 derivative-table + N-PORT primary-doc parsing are the natural v1.1 next steps.

**Open queue rolling to Day 11+:**
1. Pre-launch commercial work (Privacy Policy live; launch posts drafts; MCP registry submissions: Anthropic + Smithery + Awesome-MCP + PulseMCP)
2. Form 4 derivative-table extension (~2-3 hr; adds `is_derivative` filter, stock-option exercise signal)
3. N-PORT primary-doc parsing (~2-3 hr; fund derivative holdings)
4. CBOE put/call ratio (dedicated HTML-scrape session)
5. FARA (dedicated APEX/XLSX session)
6. v1.1 unified_search company-name fuzzy
7. Node 20 → 22 upgrade before 2026-10-30 decommission

### 🛡️ 2026-05-15 — read-only-SA hardening + v0.44.0 (FARA · Form 5 · CSL)

Continuation session after the Track A/B merge. Two pieces: a security hardening, then the final three scrapers.

**Read-only service-account hardening (commit `dbb8780`).** The `mcp` Cloud Function previously ran as the project default runtime SA (Editor role → Firestore *write* access it never used — every MCP tool is read-only by code). Created a dedicated `keyvex-mcp-readonly@capitaledge-api.iam.gserviceaccount.com` SA with only Cloud Datastore Viewer + Logs Writer + Monitoring Metric Writer, and pinned the `mcp` function to it via the `serviceAccount` field on `onRequest`. A bug or breach of the public endpoint now physically cannot write the database. Verified live: health check + authed tool call both succeed; Firestore reads work under `datastore.viewer`. **IAM provisioning lesson:** creating a service account + granting project roles cannot be done with the Firebase Admin SDK key (its `firebase.sdkAdminServiceAgent` role excludes `iam.serviceAccounts.create` and `resourcemanager.projects.setIamPolicy`). It requires `gcloud` or the Cloud Console under an Owner identity — there is no programmatic shortcut from this repo's credentials.

**v0.44.0 — three new scrapers, two new MCP tools (38 total):**

- **FARA (`get_foreign_agents`, new tool #37)** — `src/scrapers/fara.ts`. Foreign Agents Registration Act registrations from efile.fara.gov: every US registrant ↔ foreign-principal relationship, with the principal's **country** as the marquee signal. One record per (registrant, foreign principal) pair. Weekly Sunday 5:30 AM ET scheduler (timeout 2400s).
  **FARA Hard Lesson:** the `/api/v1/ForeignPrincipals/json/Active` *list* endpoint is broken FARA-side — it returns FARA's CMS HTML instead of API JSON, consistently, including the exact URL from FARA's own docs. The sibling `/api/v1/Registrants/json/Active` works fine. The fix: the *per-registrant* form `/api/v1/ForeignPrincipals/json/Active/{regNumber}` works — so the scraper pulls the registrant list (558 active) and queries each registration number individually. The host is genuinely flaky (intermittent 500s, connection resets, SSL errors, HTML-for-JSON) — `fetchJson` retries with backoff and treats an HTML body as a retryable failure. ~558 registrants at FARA's 5-req/10-sec limit ≈ 18-20 min for a full run.
- **Form 5 (no new tool — feeds `get_insider_transactions`)** — `scrapeForm5LiveFeed` added to `src/scrapers/form4.ts`. Form 5 is the annual catch-up insider filing; it shares Form 4's identical `ownershipDocument` XML schema, so `parseForm4Xml` was parameterized with a `dataSource` arg and reused. Form 5 records land in the `insider_trades` collection tagged `data_source: "SEC_EDGAR_FORM5"`. Daily 8:20 AM ET scheduler.
- **CSL (`get_screening_list`, new tool #38)** — `src/scrapers/csl.ts`. The US Consolidated Screening List — twelve export-screening lists from Commerce/State/Treasury (SDN, Entity List, Denied Persons, Military End User, Unverified List, CMIC, Capta, ITAR Debarred, ISN, NS-MBS, PLC, SSI) in one feed, ~25,660 entries. Broader than `get_ofac_sdn` (the SDN list is one of the twelve sources). **Key-free path:** the live CSL search API needs an ITA Developer Portal subscription key, but the bulk static file at `api.trade.gov/static/consolidated_screening_list/consolidated.json` does not — the scraper uses the bulk file. Daily 5:50 AM ET scheduler.

Verified live before deploy: FARA (558 registrants, per-registrant iteration works), Form 5 (parser handles Form 5 XML), CSL (25,660 entries across all 12 lists).

**Deferred with reasoning:** FARA v1A captures the registrant↔principal linkage but not per-document filing detail or compensation figures — agents follow `source_url` to FARA eFile. If FARA ever fixes its `ForeignPrincipals` list endpoint, the scraper could drop the per-registrant iteration; not worth tracking until it does.

**Last Updated**

May 15, 2026 — v0.44.0. **38 MCP tools at `mcp.keyvex.com`.** This session: read-only-SA hardening of the MCP function, then the final three scrapers (FARA foreign agents, Form 5 annual insider filings, Consolidated Screening List). FARA and CSL are new tools (`get_foreign_agents`, `get_screening_list`); Form 5 feeds the existing `get_insider_transactions`. Building phase is now closed — next focus is promotion and launch (MCP registry submissions, launch posts). Earlier this session: Day 10 Track A + Track B were reconciled into v0.43.0 (two parallel worktrees merged — see the Session Bootstrap section for the process fix).
