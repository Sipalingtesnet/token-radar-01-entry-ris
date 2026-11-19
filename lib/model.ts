// ---------------------------------------------------------------------------
// Token Radar — model, part 1: snapshot in, ranked pre-token board out.
//
// This module is the token radar's model: one sealed DefiLlama snapshot goes
// in, one ranked board of pre-token protocols comes out. An "implied value"
// is this entry's own claim about what a launch would be worth if the
// protocol's record stayed exactly as it is in the snapshot — it is never a
// promise, and nothing here forecasts the future.
//
// Node 22, standard library only, no imports. Parts 2 and 3 (screening,
// ranking, payload assembly) are appended in later sessions; this file is
// syntactically complete on its own.
// ---------------------------------------------------------------------------

/** One protocol record as captured in the sealed snapshot. */
export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot: raw arrays plus a slug index for lookups. */
export interface Snapshot {
  asOf: string;
  floorUsd: number;
  protocols: Protocol[];
  watchlist: string[];
  bySlug: Map<string, Protocol>;
}

/** A minimal ranked board row (the full payload rows live in RadarPayload). */
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

/**
 * Shape of the final radar payload. Declared here; filled by a later part.
 * Every numeric factor on a row is exposed so the ranking is auditable.
 */
export interface RadarPayload {
  asOf: string;
  floorUsd: number;
  counts: { protocols: number; candidates: number; watchlist: number };
  model: {
    summary: string;
    categoryMultiples: { category: string; multiple: number; samples: number }[];
  };
  rows: {
    slug: string;
    name: string;
    category: string | null;
    chains: string[];
    tvl_usd: number;
    change_7d: number | null;
    age_days: number | null;
    listed_at: string | null;
    watchlist: boolean;
    rank: number;
    implied_value_usd: number;
    multiple: number;
    growth_factor: number;
    maturity_factor: number;
    breadth_factor: number;
    farm_steps: string[];
  }[];
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported).
// ---------------------------------------------------------------------------

/** Constrain v to the inclusive range [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Median of a sorted copy: middle value, mean of two middles, 0 if empty. */
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Whole days between two YYYY-MM-DD dates, computed in UTC.
 * Returns null when listedAt is null or unparseable.
 */
function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = re.exec(asOf);
  const b = re.exec(listedAt);
  if (a === null || b === null) return null;
  const asOfMs = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const listedMs = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.floor((asOfMs - listedMs) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Snapshot parsing.
// ---------------------------------------------------------------------------

/**
 * Parse and validate the sealed snapshot text. Throws an Error naming what
 * is wrong when the top level is not an object carrying a protocols array
 * and a watchlist array. Builds the bySlug index.
 */
export function parseSnapshot(text: string): Snapshot {
  const raw: unknown = JSON.parse(text);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("snapshot: top level must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.protocols)) {
    throw new Error("snapshot: missing or non-array 'protocols'");
  }
  if (!Array.isArray(obj.watchlist)) {
    throw new Error("snapshot: missing or non-array 'watchlist'");
  }
  const protocols = obj.protocols as Protocol[];
  const watchlist = obj.watchlist as string[];
  const bySlug = new Map<string, Protocol>();
  for (const p of protocols) {
    bySlug.set(p.slug, p);
  }
  return {
    asOf: obj.asOf as string,
    floorUsd: obj.floorUsd as number,
    protocols,
    watchlist,
    bySlug,
  };
}

// ---------------------------------------------------------------------------
// Launch-candidate screen.
// ---------------------------------------------------------------------------

// Categories that are infrastructure or exchange custody, not launch stories.
const EXCLUDED_CATEGORIES = new Set<string>([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

// Version suffixes like " V2", " v3.1", " 2.0" mark re-deployments, not launches.
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

// Derivative-token wording anywhere in the name as a whole word.
const DERIVATIVE_WORD = /\b(wrapped|staked|staking)\b/i;

// Exchange-branded products are not independent pre-token protocols.
const EXCHANGE_FIRST_WORDS = new Set<string>([
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
]);

/**
 * True only when every launch-candidate condition holds: no token identifiers,
 * an allowed category (null passes), no version suffix, no derivative-token
 * wording, and no exchange-branded first word.
 */
export function isLaunchCandidate(p: Protocol): boolean {
  if (p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (DERIVATIVE_WORD.test(p.name)) return false;
  const firstWord = p.name.trim().split(/\s+/)[0] ?? "";
  if (EXCHANGE_FIRST_WORDS.has(firstWord)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Category multiples from already-tokenised peers.
// ---------------------------------------------------------------------------

/**
 * For every protocol with a known market cap and positive TVL, the ratio
 * mcap / TVL is grouped by category (null -> "Uncategorised"). A category's
 * multiple is its own median when it has >= 3 samples, else the global median
 * of all ratios. Each multiple is clamped into [0.05, 3] so no single peer
 * group can dominate the board.
 */
export function categoryMultiples(snapshot: Snapshot): {
  multiples: Record<string, number>;
  samples: Record<string, number>;
  globalMedian: number;
} {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || !(p.tvl_usd > 0)) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    const category = p.category ?? "Uncategorised";
    const bucket = ratiosByCategory.get(category);
    if (bucket === undefined) {
      ratiosByCategory.set(category, [ratio]);
    } else {
      bucket.push(ratio);
    }
    allRatios.push(ratio);
  }
  const globalMedian = median(allRatios);
  const multiples: Record<string, number> = {};
  const samples: Record<string, number> = {};
  for (const [category, ratios] of ratiosByCategory) {
    samples[category] = ratios.length;
    const own = ratios.length >= 3 ? median(ratios) : globalMedian;
    multiples[category] = clamp(own, 0.05, 3);
  }
  return { multiples, samples, globalMedian };
}

// ---------------------------------------------------------------------------
// Implied launch value.
// ---------------------------------------------------------------------------

/**
 * This entry's own claim about what a launch would be worth if the protocol's
 * record stayed as it is — never a promise.
 *
 * base            = TVL * the category's mcap/TVL multiple
 * growthFactor    = 1 + (clamped 7d change / 100) * 1.2   (change in [-20, 50])
 * maturityFactor  = 0.75 + 0.5 * min(max(age, 0), 1460) / 1460
 *                   (unknown listing age is treated as 365 days)
 * breadthFactor   = 1 + 0.03 * min(max(chains - 1, 0), 7)
 * implied         = max(1, round(base * growth * maturity * breadth))
 */
export function impliedValue(
  p: Protocol,
  multiples: Record<string, number>,
  globalMedian: number,
  asOf: string,
): {
  implied: number;
  base: number;
  categoryMultiple: number;
  growthFactor: number;
  maturityFactor: number;
  breadthFactor: number;
  ageDays: number | null;
} {
  const categoryMultiple = multiples[p.category ?? "Uncategorised"] ?? globalMedian;
  const base = p.tvl_usd * categoryMultiple;

  const g = clamp(p.change_7d ?? 0, -20, 50);
  const growthFactor = 1 + (g / 100) * 1.2;

  const ageDays = ageInDays(asOf, p.listed_at);
  const age = ageDays ?? 365;
  const maturityFactor = 0.75 + (0.5 * Math.min(Math.max(age, 0), 1460)) / 1460;

  const breadthFactor = 1 + 0.03 * Math.min(Math.max(p.chains.length - 1, 0), 7);

  const implied = Math.max(
    1,
    Math.round(base * growthFactor * maturityFactor * breadthFactor),
  );

  return {
    implied,
    base,
    categoryMultiple,
    growthFactor,
    maturityFactor,
    breadthFactor,
    ageDays,
  };
}

// ---------------------------------------------------------------------------
// Token Radar — model, part 2: the farm-step generator.
//
// farmSteps turns one pre-token protocol record into five concrete, sized
// actions a farmer can take this week. Every string is 90–240 characters.
// A protocol that records no token is described exactly that way — never as
// "has no token". Amounts are working-fund suggestions, not advice, and the
// top of each range is reserved for very large (TVL >= $1B) protocols.
// ---------------------------------------------------------------------------

/** Category-specific middle steps (2 and 3). `top` picks the high end of each range. */
function categoryActionSteps(p: Protocol, chain: string, top: boolean): [string, string] {
  const name = p.name;
  switch (p.category) {
    case "Dexs":
    case "Aggregator":
      return [
        `Make two or three real swaps a week through ${name}'s own interface on ${chain}, about $${top ? 150 : 50}–$150 each; a few minutes per swap plus small gas.`,
        `Park a small liquidity position in a flagship ${name} pair on ${chain}, about $${top ? 400 : 150}–$400, and check it weekly; minutes to add, minutes per check.`,
      ];
    case "Lending":
      return [
        `Supply a blue-chip collateral asset to ${name} on ${chain}, about $${top ? 500 : 200}–$500, in ten minutes; keep utilisation low from the start.`,
        `Run a careful borrow-and-repay loop on ${name} at low utilisation, repaying within the week; interest costs about $2–$8 and each cycle takes minutes.`,
      ];
    case "Derivatives":
    case "Perps":
    case "Options":
      return [
        `Open small hedged trades on ${name} (${chain}), about $${top ? 300 : 100}–$300 margin, delta-neutral where possible; twenty minutes to set up.`,
        `Repeat on ${name} to a steady weekly volume, closing positions before weekends; funding costs about $2–$10 per week at this size.`,
      ];
    case "Yield":
    case "Yield Aggregator":
      return [
        `Deposit into ${name}'s flagship vault on ${chain}, about $${top ? 450 : 150}–$450, in ten minutes; note the entry fee and withdrawal rules first.`,
        `Rotate between two ${name} vaults weekly and harvest rewards; gas runs about $2–$8 per rotation, and each round takes only a few minutes.`,
      ];
    case "Gaming":
    case "NFT":
    case "NFT Marketplace":
      return [
        `Play or mint through ${name}'s official client, about $${top ? 120 : 30}–$120 of items, across a few sessions a week on ${chain}.`,
        `List or trade items around $10–$50 on ${name}'s marketplace and finish seasonal tasks, about an hour a week; note which activities the team highlights.`,
      ];
    default:
      return [
        `Use ${name}'s core action end-to-end with real funds on ${chain}, about $${top ? 300 : 100}–$300, taking fifteen minutes the first time.`,
        `Repeat weekly so your wallet builds a steady history on ${name}, varying amounts slightly; gas stays about $2–$8 at this size.`,
      ];
  }
}

/** Five concrete farm steps for a protocol that records no token. Each is 90–240 characters. */
export function farmSteps(p: Protocol, ageDays: number | null): string[] {
  const name = p.name;
  const chain = p.chains[0] ?? "its main chain";
  const second = p.chains[1] ?? null;
  // Very large protocols (a top-of-board proxy) get the top of each range.
  const top = p.tvl_usd >= 1_000_000_000;
  const veteran = ageDays !== null && ageDays > 730;

  const [action2, action3] = categoryActionSteps(p, chain, top);

  const step1 = `${name} records no token, so farm it with a fresh wallet: bridge about $200–$600 to ${chain}, keep the seed phrase offline, and allow about 15 minutes for setup.`;

  const step4 = second
    ? `Add ${second} as a second surface for ${name}: repeat one core action there and follow its official announcement channels for points or airdrop news; about 30 minutes to set up.`
    : `Explore a second product surface of ${name} beyond ${chain} and follow its official announcement channels for points or airdrop news; about 30 minutes to set up.`;

  const step5 = `Keep a simple log of your ${name} activity${veteran ? " on this long-running farm" : ""}, re-check official announcements monthly, use official links only, and never share a seed phrase or sign blind approvals.`;

  return [step1, action2, action3, step4, step5];
}

// ---------------------------------------------------------------------------
// Token Radar — model, part 3: board assembly, validation and payload.
//
// buildBoard screens the snapshot, always covers the watchlist, ranks by
// implied value (ties broken by TVL then slug), and caps the board at 320
// rows without ever dropping a watchlist entry. boardIssue is the strict
// self-check; buildPayload exposes every factor so the ranking is auditable.
// ---------------------------------------------------------------------------

/** Maximum board size before watchlist overflow protection kicks in. */
const BOARD_CAP = 320;

/** Build the ranked board: launch candidates plus every watchlist protocol. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const { multiples, globalMedian } = categoryMultiples(snapshot);
  const watchlist = new Set(snapshot.watchlist);

  const picked: { p: Protocol; implied: number; ageDays: number | null }[] = [];
  const seen = new Set<string>();
  for (const p of snapshot.protocols) {
    if (!isLaunchCandidate(p) && !watchlist.has(p.slug)) continue;
    if (seen.has(p.slug)) continue;
    seen.add(p.slug);
    const v = impliedValue(p, multiples, globalMedian, snapshot.asOf);
    picked.push({ p, implied: v.implied, ageDays: v.ageDays });
  }
  // Watchlist coverage is a hard requirement: include watchlist slugs that
  // never appeared in the protocols array iteration above, if indexed.
  for (const slug of snapshot.watchlist) {
    if (seen.has(slug)) continue;
    const p = snapshot.bySlug.get(slug);
    if (p === undefined) continue;
    seen.add(slug);
    const v = impliedValue(p, multiples, globalMedian, snapshot.asOf);
    picked.push({ p, implied: v.implied, ageDays: v.ageDays });
  }

  picked.sort((a, b) => {
    if (b.implied !== a.implied) return b.implied - a.implied;
    if (b.p.tvl_usd !== a.p.tvl_usd) return b.p.tvl_usd - a.p.tvl_usd;
    return a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0;
  });

  const kept = picked.filter(
    (entry, i) => i < BOARD_CAP || watchlist.has(entry.p.slug),
  );

  return kept.map((entry, i) => ({
    slug: entry.p.slug,
    name: entry.p.name,
    rank: i + 1,
    implied_value_usd: entry.implied,
    farm_steps: farmSteps(entry.p, entry.ageDays),
  }));
}

/**
 * Strict board self-check. Returns a description of the FIRST violation
 * found (checks run in a fixed order), or null when the board is clean.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) {
    return `row count ${board.length} outside 100..4000`;
  }
  for (const row of board) {
    if (!snapshot.bySlug.has(row.slug)) {
      return `slug ${row.slug} not present in snapshot.bySlug`;
    }
  }
  const slugs = new Set<string>();
  for (const row of board) {
    if (slugs.has(row.slug)) return `duplicate slug ${row.slug}`;
    slugs.add(row.slug);
  }
  const ranks = new Set<number>();
  for (const row of board) {
    if (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > board.length) {
      return `rank ${row.rank} outside 1..${board.length} for ${row.slug}`;
    }
    if (ranks.has(row.rank)) return `duplicate rank ${row.rank}`;
    ranks.add(row.rank);
  }
  if (ranks.size !== board.length) {
    return `ranks do not cover 1..${board.length} exactly once each`;
  }
  for (const row of board) {
    const v = row.implied_value_usd;
    if (!Number.isInteger(v) || v <= 0 || v > 100000000000000) {
      return `implied_value_usd ${v} for ${row.slug} not a positive integer <= 100000000000000`;
    }
  }
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) {
      return `implied values increase at rank ${byRank[i].rank} (${byRank[i].slug})`;
    }
  }
  if (byRank.every((row) => row.implied_value_usd === byRank[0].implied_value_usd)) {
    return "all implied values are equal";
  }
  for (const slug of snapshot.watchlist) {
    if (!slugs.has(slug)) return `watchlist slug ${slug} missing from board`;
  }
  for (const row of board) {
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `farm_steps for ${row.slug} is not an array of 3..12 strings`;
    }
    for (const step of row.farm_steps) {
      if (typeof step !== "string") {
        return `farm_steps for ${row.slug} contains a non-string`;
      }
      const len = step.trim().length;
      if (len < 20 || len > 600) {
        return `farm step for ${row.slug} has trimmed length ${len} outside 20..600`;
      }
    }
  }
  return null;
}

/** Assemble the full auditable payload from the snapshot and the ranked board. */
export function buildPayload(snapshot: Snapshot, board: BoardRow[]): RadarPayload {
  const cm = categoryMultiples(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const summary =
    "Each implied value is this board's own model claim, not a forecast or a promise: it is the protocol's TVL times the median market-cap-to-TVL multiple of the snapshot's live protocols in the same category. " +
    "That base is adjusted for the protocol's 7-day TVL growth, the length of its track record, and its chain breadth. " +
    "Every factor is exposed on each row so the ranking can be audited against the sealed snapshot.";

  const categoryMultiplesList = Object.keys(cm.multiples)
    .sort()
    .map((category) => ({
      category,
      multiple: cm.multiples[category],
      samples: cm.samples[category] ?? 0,
    }));

  const rows = board.map((row) => {
    const p = snapshot.bySlug.get(row.slug);
    if (p === undefined) {
      throw new Error(`buildPayload: slug ${row.slug} missing from snapshot.bySlug`);
    }
    const v = impliedValue(p, cm.multiples, cm.globalMedian, snapshot.asOf);
    return {
      slug: row.slug,
      name: row.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: v.ageDays,
      listed_at: p.listed_at,
      watchlist: watchlist.has(row.slug),
      rank: row.rank,
      implied_value_usd: row.implied_value_usd,
      multiple: v.categoryMultiple,
      growth_factor: v.growthFactor,
      maturity_factor: v.maturityFactor,
      breadth_factor: v.breadthFactor,
      farm_steps: row.farm_steps,
    };
  });

  return {
    asOf: snapshot.asOf,
    floorUsd: snapshot.floorUsd,
    counts: {
      protocols: snapshot.protocols.length,
      candidates: board.length,
      watchlist: snapshot.watchlist.length,
    },
    model: {
      summary,
      categoryMultiples: categoryMultiplesList,
    },
    rows,
  };
}

/** Serialize the payload as the browser bootstrap script for the radar page. */
export function dataScript(payload: RadarPayload): string {
  return "window.TOKENRADAR = " + JSON.stringify(payload) + ";\n";
}
