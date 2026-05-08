/**
 * Bioguide / congressional member catalog ingestion.
 *
 * Source: github.com/unitedstates/congress-legislators (public domain,
 * community-maintained, daily updates). Three YAML files joined into one
 * Legislator record per current member:
 *   - legislators-current.yaml — name, bio, terms array (chronological)
 *   - committees-current.yaml — committee codes → names, types, subcommittees
 *   - committee-membership-current.yaml — committee code → array of members
 *     with bioguide id + party + rank + optional title
 *
 * Subcommittee codes are formed by appending the subcommittee's thomas_id
 * to the parent committee's thomas_id (e.g., HSAG + 15 = HSAG15).
 *
 * Output: one Legislator record per current member, with all committee
 * + subcommittee assignments flattened into committee_assignments[].
 *
 * No rate limiting needed — we fetch 3 files once per ingestion run.
 * Idempotent: keyed by bioguide_id, re-running overwrites cleanly.
 *
 * Estimated v1 ingestion time: ~5 seconds for the YAML downloads + parse.
 * No HTTP discovery loop, no schema surprises (well-documented YAML).
 */

import yaml from "js-yaml";
import type {
  CommitteeAssignment,
  CrossReferenceIds,
  CurrentTermContact,
  HistoricalTerm,
  Legislator,
  LegislatorHistorical,
  SocialHandles,
} from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "CapitalEdgeMCP/0.1 contact@capitaledge.app",
  BASE_URL:
    "https://raw.githubusercontent.com/unitedstates/congress-legislators/main",
  PHOTO_BASE_URL: "https://theunitedstates.io/images/congress/original",
};

// ─── Source YAML types (loose; we'll narrow as we map) ─────────────────────

interface YamlIdBlock {
  bioguide?: string;
  thomas?: string;
  lis?: string;
  govtrack?: number;
  opensecrets?: string;
  votesmart?: number;
  /** FEC IDs are an array — members with multiple campaigns over their career
   *  accumulate multiple IDs. */
  fec?: string[];
  cspan?: number;
  wikipedia?: string;
  ballotpedia?: string;
  icpsr?: number;
  wikidata?: string;
}

interface YamlNameBlock {
  first?: string;
  last?: string;
  middle?: string;
  nickname?: string;
  official_full?: string;
}

interface YamlBioBlock {
  birthday?: string;
  gender?: string;
}

interface YamlSocialBlock {
  twitter?: string;
  twitter_id?: number;
  facebook?: string;
  youtube?: string;
  youtube_id?: string;
  instagram?: string;
  instagram_id?: string;
}

interface YamlTerm {
  type?: string; // "sen" | "rep"
  start?: string;
  end?: string;
  state?: string;
  district?: number | string;
  party?: string;
  class?: number;
  /** Per-term contact + office fields. Only populated on the most-recent
   *  term-block(s); historical terms typically lack these. */
  office?: string;
  address?: string;
  phone?: string;
  fax?: string;
  url?: string;
  contact_form?: string;
  state_rank?: string;
  rss_url?: string;
}

interface YamlLegislator {
  id?: YamlIdBlock;
  name?: YamlNameBlock;
  bio?: YamlBioBlock;
  social?: YamlSocialBlock;
  terms?: YamlTerm[];
}

interface YamlSubcommittee {
  name?: string;
  thomas_id?: string;
}

interface YamlCommittee {
  type?: string; // "house" | "senate" | "joint"
  name?: string;
  thomas_id?: string;
  subcommittees?: YamlSubcommittee[];
}

interface YamlMembershipEntry {
  name?: string;
  party?: string; // "majority" | "minority"
  rank?: number;
  title?: string;
  bioguide?: string;
}

type YamlMembership = Record<string, YamlMembershipEntry[]>;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchYaml<T>(filename: string): Promise<T> {
  const url = `${CONFIG.BASE_URL}/${filename}`;
  const res = await fetch(url, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`GitHub raw ${res.status} ${res.statusText} — ${url}`);
  }
  const text = await res.text();
  return yaml.load(text) as T;
}

/**
 * Build a lookup table from committee_id → {name, type, parent_committee_id}.
 * Captures both full committees (HSAG) and subcommittees (HSAG15).
 */
function buildCommitteeIndex(
  committees: YamlCommittee[],
): Record<string, { name: string; type: string; parent_id: string | null }> {
  const index: Record<
    string,
    { name: string; type: string; parent_id: string | null }
  > = {};
  for (const c of committees) {
    const tid = c.thomas_id;
    if (!tid) continue;
    const type = c.type ?? "";
    index[tid] = {
      name: c.name ?? tid,
      type,
      parent_id: null,
    };
    for (const sub of c.subcommittees ?? []) {
      const subTid = sub.thomas_id;
      if (!subTid) continue;
      const fullCode = `${tid}${subTid}`;
      index[fullCode] = {
        name: sub.name ?? fullCode,
        type, // subcommittees inherit parent's chamber
        parent_id: tid,
      };
    }
  }
  return index;
}

/**
 * Build a lookup table from bioguide_id → CommitteeAssignment[].
 */
function buildMembershipIndex(
  membership: YamlMembership,
  committeeIndex: ReturnType<typeof buildCommitteeIndex>,
): Record<string, CommitteeAssignment[]> {
  const byMember: Record<string, CommitteeAssignment[]> = {};
  for (const [committeeCode, members] of Object.entries(membership)) {
    const cmt = committeeIndex[committeeCode];
    if (!cmt) continue; // unknown committee code — skip defensively
    for (const m of members) {
      const bg = m.bioguide;
      if (!bg) continue;
      const assignment: CommitteeAssignment = {
        committee_id: committeeCode,
        committee_name: cmt.name,
        committee_type: cmt.type,
        is_subcommittee: cmt.parent_id !== null,
        parent_committee_id: cmt.parent_id,
        party_role: m.party ?? "",
        rank: typeof m.rank === "number" ? m.rank : null,
        leadership_title: m.title ?? "",
      };
      if (!byMember[bg]) byMember[bg] = [];
      byMember[bg].push(assignment);
    }
  }
  return byMember;
}

/**
 * Pick the most-recent term from a legislator's terms array (chronological).
 * Returns the LAST entry — the YAML lists terms in chronological order, so
 * the last one is the current/most-recent term. Returns null on empty.
 */
function currentTerm(terms: YamlTerm[] | undefined): YamlTerm | null {
  if (!terms || terms.length === 0) return null;
  return terms[terms.length - 1] ?? null;
}

/**
 * Extract cross-reference IDs from the YAML id-block. Defensive against
 * partial entries (older legislators may lack some IDs); empty values
 * preferred over null/undefined to keep the response shape consistent.
 */
function extractCrossReferenceIds(idBlock: YamlIdBlock | undefined): CrossReferenceIds {
  return {
    thomas: idBlock?.thomas ?? "",
    lis: idBlock?.lis ?? "",
    govtrack: typeof idBlock?.govtrack === "number" ? idBlock.govtrack : null,
    opensecrets: idBlock?.opensecrets ?? "",
    votesmart: typeof idBlock?.votesmart === "number" ? idBlock.votesmart : null,
    fec: Array.isArray(idBlock?.fec) ? idBlock.fec : [],
    cspan: typeof idBlock?.cspan === "number" ? idBlock.cspan : null,
    wikipedia: idBlock?.wikipedia ?? "",
    ballotpedia: idBlock?.ballotpedia ?? "",
    icpsr: typeof idBlock?.icpsr === "number" ? idBlock.icpsr : null,
    wikidata: idBlock?.wikidata ?? "",
  };
}

/**
 * Extract social-media handles. Most members leave most of these empty.
 */
function extractSocial(socialBlock: YamlSocialBlock | undefined): SocialHandles {
  return {
    twitter: socialBlock?.twitter ?? "",
    twitter_id: typeof socialBlock?.twitter_id === "number" ? socialBlock.twitter_id : null,
    facebook: socialBlock?.facebook ?? "",
    youtube: socialBlock?.youtube ?? "",
    youtube_id: socialBlock?.youtube_id ?? "",
    instagram: socialBlock?.instagram ?? "",
    instagram_id: socialBlock?.instagram_id ?? "",
  };
}

/**
 * Extract DC office contact info from the current-term block.
 */
function extractContact(term: YamlTerm | null): CurrentTermContact {
  return {
    office: term?.office ?? "",
    address: term?.address ?? "",
    phone: term?.phone ?? "",
    fax: term?.fax ?? "",
    url: term?.url ?? "",
    contact_form: term?.contact_form ?? "",
    state_rank: term?.state_rank ?? "",
    rss_url: term?.rss_url ?? "",
  };
}

/**
 * Map a YAML legislator + committee assignments to our Legislator type.
 * Returns null when the entry is missing required fields (bioguide id,
 * current term — both should always be present in the current YAML, but
 * defend against schema drift).
 */
function normalizeLegislator(
  raw: YamlLegislator,
  committeeAssignments: CommitteeAssignment[],
): Legislator | null {
  const bioguide = raw.id?.bioguide;
  if (!bioguide) return null;

  const term = currentTerm(raw.terms);
  if (!term) return null;

  const chamber =
    term.type === "sen" ? "senate" : term.type === "rep" ? "house" : "";

  // district can be a number ("1") or string ("AL" for at-large). Normalize
  // to string. Senate has no district.
  let district = "";
  if (chamber === "house" && term.district !== undefined) {
    district = String(term.district);
  }

  const senateClass = chamber === "senate" && typeof term.class === "number"
    ? term.class
    : null;

  const fullName =
    raw.name?.official_full ??
    [raw.name?.first, raw.name?.middle, raw.name?.last].filter((s) => s).join(" ");

  return {
    bioguide_id: bioguide,
    full_name: fullName,
    first_name: raw.name?.first ?? "",
    last_name: raw.name?.last ?? "",
    middle_name: raw.name?.middle ?? "",
    nickname: raw.name?.nickname ?? "",
    chamber,
    state: term.state ?? "",
    state_district: district,
    party: term.party ?? "",
    senate_class: senateClass,
    current_term_start: term.start ?? "",
    current_term_end: term.end ?? "",
    terms_count: raw.terms?.length ?? 0,
    birthday: raw.bio?.birthday ?? "",
    gender: raw.bio?.gender ?? "",
    photo_url: `${CONFIG.PHOTO_BASE_URL}/${bioguide}.jpg`,
    cross_reference_ids: extractCrossReferenceIds(raw.id),
    social: extractSocial(raw.social),
    contact: extractContact(term),
    committee_assignments: committeeAssignments,
  };
}

// ─── Public scraper ─────────────────────────────────────────────────────────

/**
 * Pull all current legislators + committees + memberships, join, and
 * return one Legislator per current House/Senate member with their
 * committee assignments populated.
 *
 * Single round trip (3 parallel fetches). No pagination.
 */
export async function scrapeBioguideCatalog(): Promise<Legislator[]> {
  console.error("[bioguide] Fetching 3 YAML files in parallel...");

  const [legislators, committees, membership] = await Promise.all([
    fetchYaml<YamlLegislator[]>("legislators-current.yaml"),
    fetchYaml<YamlCommittee[]>("committees-current.yaml"),
    fetchYaml<YamlMembership>("committee-membership-current.yaml"),
  ]);

  console.error(
    `[bioguide] Loaded ${legislators.length} legislators, ${committees.length} committees, ${Object.keys(membership).length} membership groups.`,
  );

  const committeeIndex = buildCommitteeIndex(committees);
  const memberIndex = buildMembershipIndex(membership, committeeIndex);

  const out: Legislator[] = [];
  for (const raw of legislators) {
    const bioguide = raw.id?.bioguide ?? "";
    const assignments = memberIndex[bioguide] ?? [];
    const norm = normalizeLegislator(raw, assignments);
    if (norm) out.push(norm);
  }

  console.error(
    `[bioguide] Normalized ${out.length} current members. Average ${(
      out.reduce((sum, l) => sum + l.committee_assignments.length, 0) /
      Math.max(out.length, 1)
    ).toFixed(1)} committee assignments per member.`,
  );

  return out;
}

// ─── Historical legislators (legislators-historical.yaml, ~12K entries) ──

/**
 * Map a YAML term block to our HistoricalTerm shape. Returns null when
 * essential fields (start/end dates) are missing — defensive against
 * very old or partial entries in the upstream catalog.
 */
function normalizeTerm(t: YamlTerm): HistoricalTerm | null {
  if (!t.start || !t.end) return null;
  const chamber =
    t.type === "sen" ? "senate" : t.type === "rep" ? "house" : "";
  if (!chamber) return null;
  let district = "";
  if (chamber === "house" && t.district !== undefined) {
    district = String(t.district);
  }
  const senateClass =
    chamber === "senate" && typeof t.class === "number" ? t.class : null;
  return {
    chamber,
    start: t.start,
    end: t.end,
    state: t.state ?? "",
    state_district: district,
    party: t.party ?? "",
    senate_class: senateClass,
  };
}

function normalizeLegislatorHistorical(
  raw: YamlLegislator,
): LegislatorHistorical | null {
  const bioguide = raw.id?.bioguide;
  if (!bioguide) return null;

  const terms = (raw.terms ?? [])
    .map(normalizeTerm)
    .filter((t): t is HistoricalTerm => t !== null);
  if (terms.length === 0) return null;

  const fullName =
    raw.name?.official_full ??
    [raw.name?.first, raw.name?.middle, raw.name?.last].filter((s) => s).join(" ");

  return {
    bioguide_id: bioguide,
    full_name: fullName,
    first_name: raw.name?.first ?? "",
    last_name: raw.name?.last ?? "",
    middle_name: raw.name?.middle ?? "",
    nickname: raw.name?.nickname ?? "",
    birthday: raw.bio?.birthday ?? "",
    gender: raw.bio?.gender ?? "",
    terms,
  };
}

/**
 * Pull every legislator who has ever served Congress (1789→present).
 * One round trip; no committee join (committees are current-only).
 *
 * The file is ~9 MB (~12K entries); js-yaml parses it in 3-5 seconds.
 */
export async function scrapeBioguideHistorical(): Promise<LegislatorHistorical[]> {
  console.error("[bioguide-historical] Fetching legislators-historical.yaml (~9 MB)...");
  const legislators = await fetchYaml<YamlLegislator[]>(
    "legislators-historical.yaml",
  );
  console.error(
    `[bioguide-historical] Parsed ${legislators.length} historical entries; normalizing...`,
  );
  const out: LegislatorHistorical[] = [];
  for (const raw of legislators) {
    const norm = normalizeLegislatorHistorical(raw);
    if (norm) out.push(norm);
  }
  console.error(
    `[bioguide-historical] Normalized ${out.length} legislators (${out.reduce((sum, l) => sum + l.terms.length, 0)} total terms).`,
  );
  return out;
}
