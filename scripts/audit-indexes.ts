/**
 * For each query function in firestore.ts, enumerate:
 *   - collection name
 *   - default sort field
 *   - equality filter dimensions
 *   - inequality filter dimensions
 *   - which composite indexes for (filter x default_sort) exist
 *   - which are MISSING (i.e., will 404 if an agent queries that combo)
 */
import { readFile } from "node:fs/promises";

type FirestoreIndexField = {
  fieldPath: string;
  order?: "ASCENDING" | "DESCENDING";
  arrayConfig?: "CONTAINS";
};
type FirestoreIndex = {
  collectionGroup: string;
  queryScope: string;
  fields: FirestoreIndexField[];
};

const COLLECTION_PROFILE: Record<
  string,
  {
    queryFn: string;
    defaultSort: string;
    equality: string[];
    inequality: string[];
    arrayContains?: string[];
  }
> = {
  insider_trades: {
    queryFn: "queryInsiderTransactions",
    defaultSort: "disclosure_date",
    equality: ["ticker", "company_cik", "transaction_type", "is_derivative"],
    inequality: ["since", "until", "min_value"],
  },
  institutional_holdings: {
    queryFn: "queryInstitutionalHoldings",
    defaultSort: "market_value",
    equality: ["ticker", "cusip", "fund_cik", "quarter", "position_change"],
    inequality: ["min_value"],
  },
  congressional_trades: {
    queryFn: "queryCongressionalTrades",
    defaultSort: "disclosure_date",
    equality: ["ticker", "chamber", "bioguide_id", "owner", "transaction_type"],
    inequality: ["since", "until", "amount_min"],
  },
  planned_insider_sales: {
    queryFn: "queryForm144Filings",
    defaultSort: "filing_date",
    equality: ["ticker", "company_cik"],
    inequality: ["since", "until", "min_value"],
  },
  initial_ownership_baselines: {
    queryFn: "queryForm3Holdings",
    defaultSort: "filing_date",
    equality: ["ticker", "company_cik", "is_derivative"],
    inequality: ["since", "until"],
  },
  activist_ownership: {
    queryFn: "queryActivistOwnership",
    defaultSort: "filing_date",
    equality: ["ticker", "company_cik", "cusip", "filer_cik", "filing_type", "is_activist"],
    inequality: ["since", "until", "min_percent_of_class"],
  },
  federal_contracts: {
    queryFn: "queryFederalContractAwards",
    defaultSort: "last_modified_date",
    equality: ["recipient_uei", "awarding_agency", "naics_code", "psc_code"],
    inequality: ["since", "until", "min_amount"],
  },
  federal_grants: {
    queryFn: "queryFederalGrants",
    defaultSort: "last_modified_date",
    equality: ["recipient_uei", "awarding_agency", "cfda_number"],
    inequality: ["since", "until", "min_amount"],
  },
  cftc_cot_reports: {
    queryFn: "queryCftcCotReports",
    defaultSort: "report_date",
    equality: ["cftc_contract_market_code", "commodity_name"],
    inequality: ["since", "until"],
  },
  sec_fails_to_deliver: {
    queryFn: "querySecFailsToDeliver",
    defaultSort: "settlement_date",
    equality: ["ticker", "cusip"],
    inequality: ["since", "until"],
  },
  lobbying_filings: {
    queryFn: "queryLobbyingFilings",
    defaultSort: "dt_posted",
    equality: ["filing_year", "filing_period"],
    inequality: ["since", "until", "min_income"],
    arrayContains: ["general_issue_codes"],
  },
  material_events: {
    queryFn: "queryMaterialEvents",
    defaultSort: "filing_date",
    equality: ["ticker", "company_cik", "is_amendment"],
    inequality: ["since", "until"],
    arrayContains: ["item_codes"],
  },
  proxy_filings: {
    queryFn: "queryProxyFilings",
    defaultSort: "filing_date",
    equality: ["ticker", "company_cik", "form_type"],
    inequality: ["since", "until"],
  },
  xbrl_fundamentals: {
    queryFn: "queryXbrlFundamentals",
    defaultSort: "period_end",
    equality: ["ticker", "cik", "concept", "form", "category", "fiscal_period"],
    inequality: ["since", "until", "fiscal_year"],
  },
  consumer_complaints: {
    queryFn: "queryConsumerComplaints",
    defaultSort: "date_received",
    equality: ["company", "product", "state", "consumer_consent_provided"],
    inequality: ["since", "until"],
  },
  oig_exclusions: {
    queryFn: "queryOigExclusions",
    defaultSort: "exclusion_date",
    equality: ["specialty", "exclusion_type", "state"],
    inequality: ["since", "until"],
  },
  treasury_auctions: {
    queryFn: "queryTreasuryAuctions",
    defaultSort: "auction_date",
    equality: ["cusip", "security_type", "reopening"],
    inequality: ["since", "until", "min_offering_amount", "min_bid_to_cover"],
  },
  annual_financial_disclosures: {
    queryFn: "queryForm278Filings",
    defaultSort: "filing_date",
    equality: ["bioguide_id", "chamber", "state", "filing_year", "report_type"],
    inequality: ["since", "until"],
  },
  ofac_sdn: {
    queryFn: "queryOfacSdn",
    defaultSort: "ent_num",
    equality: ["sdn_type", "program"],
    inequality: [],
  },
  nport_filings: {
    queryFn: "queryNportFilings",
    defaultSort: "file_date",
    equality: ["filer_cik", "series_id", "class_id"],
    inequality: ["since", "until"],
  },
  nport_holdings: {
    queryFn: "queryNportHoldings",
    defaultSort: "value_usd",
    equality: ["filer_cik", "series_id", "class_id", "ticker", "cusip", "asset_cat", "is_derivative"],
    inequality: ["min_value"],
  },
  product_recalls: {
    queryFn: "queryProductRecalls",
    defaultSort: "recall_initiation_date",
    equality: ["source", "classification", "status", "recalling_firm"],
    inequality: ["since", "until"],
  },
  gov_documents: {
    queryFn: "queryGovDocuments",
    defaultSort: "date_issued",
    equality: ["collection_code", "congress"],
    inequality: ["since", "until"],
  },
  foreign_agents: {
    queryFn: "queryForeignAgents",
    defaultSort: "registration_date",
    equality: ["country", "registrant_state", "is_active"],
    inequality: ["since", "until"],
  },
  private_placements: {
    queryFn: "queryPrivatePlacements",
    defaultSort: "file_date",
    equality: ["issuer_cik", "issuer_state", "is_amendment"],
    inequality: ["since", "until", "min_amount_sold"],
  },
  bills: {
    queryFn: "queryBills",
    defaultSort: "latest_action_date",
    equality: ["congress", "bill_number", "legislation_type", "policy_area"],
    inequality: ["since", "until", "introduced_since", "introduced_until"],
  },
  roll_call_votes: {
    queryFn: "queryRollCallVotes",
    defaultSort: "start_date",
    equality: ["chamber", "congress", "session"],
    inequality: ["since", "until"],
  },
  fec_candidates: {
    queryFn: "queryFecCandidates",
    defaultSort: "last_file_date",
    equality: ["candidate_id", "party", "election_state", "incumbent_challenge"],
    inequality: ["since", "until"],
  },
  fec_committees: {
    queryFn: "queryFecCommittees",
    defaultSort: "last_file_date",
    equality: ["committee_id", "committee_type", "designation"],
    inequality: ["since", "until"],
  },
  fec_contributions: {
    queryFn: "queryFecContributions",
    defaultSort: "contribution_receipt_date",
    equality: ["recipient_committee_id", "candidate_id", "entity_type", "contributor_state", "two_year_transaction_period"],
    inequality: ["since", "until", "min_amount"],
  },
  fec_independent_expenditures: {
    queryFn: "queryFecIndependentExpenditures",
    defaultSort: "expenditure_date",
    equality: ["candidate_id", "committee_id", "support_oppose_indicator", "candidate_office_state", "two_year_transaction_period"],
    inequality: ["since", "until", "min_amount"],
  },
};

// An index covers {where(eq) + orderBy(sort,DESC)} when its fields list
// contains BOTH the equality fieldPath (as ASC/DESC ordered field) AND
// the sort field as DESCENDING. We don't check field-ordering subtleties
// — this is a "field-set membership" check, conservative enough for audit.
function indexCovers(
  index: FirestoreIndex,
  equalityField: string | null,
  sortField: string,
): boolean {
  const fields = index.fields;
  const hasEquality =
    equalityField === null ||
    fields.some(
      (f) =>
        f.fieldPath === equalityField &&
        (f.order === "ASCENDING" || f.order === "DESCENDING"),
    );
  const hasSort = fields.some(
    (f) => f.fieldPath === sortField && f.order === "DESCENDING",
  );
  return hasEquality && hasSort;
}

async function main() {
  const raw = await readFile("firestore.indexes.json", "utf8");
  const parsed = JSON.parse(raw) as { indexes: FirestoreIndex[] };
  const { indexes } = parsed;

  console.log(`Total composite indexes in firestore.indexes.json: ${indexes.length}\n`);

  let totalMissing = 0;
  let totalCovered = 0;
  let totalCombos = 0;
  const missingTable: { collection: string; filter: string; sort: string }[] = [];

  for (const [collection, profile] of Object.entries(COLLECTION_PROFILE)) {
    const collectionIndexes = indexes.filter(
      (i) => i.collectionGroup === collection,
    );
    const lines: string[] = [];
    lines.push("");
    lines.push("=".repeat(80));
    lines.push(`${collection}  (${profile.queryFn})`);
    lines.push(`  default_sort:  ${profile.defaultSort}  DESC`);
    lines.push(`  equality:      ${profile.equality.join(", ") || "(none)"}`);
    lines.push(`  inequality:    ${profile.inequality.join(", ") || "(none)"}`);
    if (profile.arrayContains)
      lines.push(`  array-contains: ${profile.arrayContains.join(", ")}`);
    lines.push(`  composites:    ${collectionIndexes.length}`);

    lines.push(`  Coverage for (equality_field x default_sort):`);
    for (const eq of profile.equality) {
      totalCombos++;
      const covered = collectionIndexes.some((idx) =>
        indexCovers(idx, eq, profile.defaultSort),
      );
      if (covered) {
        lines.push(`    OK     where(${eq}) + orderBy(${profile.defaultSort})`);
        totalCovered++;
      } else {
        lines.push(
          `    MISS   where(${eq}) + orderBy(${profile.defaultSort})    <-- INDEX_MISSING today`,
        );
        totalMissing++;
        missingTable.push({
          collection,
          filter: eq,
          sort: profile.defaultSort,
        });
      }
    }

    console.log(lines.join("\n"));
  }

  console.log("\n" + "=".repeat(80));
  console.log(`AUDIT SUMMARY:`);
  console.log(`  Total (equality x default_sort) combos checked: ${totalCombos}`);
  console.log(`  OK     ${totalCovered}`);
  console.log(`  MISS   ${totalMissing}`);
  console.log("");
  console.log(`These ${totalMissing} combos currently 404 with INDEX_MISSING:`);
  console.log("");
  console.log(`| collection                       | filter                        | sort                       |`);
  console.log(`|----------------------------------|-------------------------------|----------------------------|`);
  for (const m of missingTable) {
    console.log(
      `| ${m.collection.padEnd(32)} | ${m.filter.padEnd(29)} | ${m.sort.padEnd(26)} |`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
