// Scoring core for Token Launch Radar (radar-2).
//
// One sealed DefiLlama snapshot goes in and one ranked board comes out. The board holds
// every slug on the snapshot's watchlist (a floor, never a ceiling) plus every other
// pre-token protocol the house exclusion rule keeps: no token on record, not a wrapped,
// staked or bridged product of a token that already trades, not an exchange, not a
// versioned pool. On this snapshot that is 198 rows: 40 watchlist, 20 more at or above the
// floor, 138 early rows below it. A protocol counts as pre-token when its record carries
// no token at all: no market cap, no CoinGecko id, no symbol. Protocols whose tokens
// already trade are kept apart and shown with the market's own values, never mixed into
// the ranked board.
//
// The implied value comes only from the snapshot's own figures, through a peer multiple:
//
//   peerMultiple(category) = median(mcap_usd / tvl_usd) over the live-token protocols in
//     the same category (needs at least 3 peers), blended toward the global median when
//     the category has fewer peers, clamped to [0.05, 1.00]. Medians are computed from
//     this snapshot at run time, never from a hand-kept list of names.
//   launchDiscount = 0.50   (a token launches below its mature peers' multiple)
//   growthMult     = 1 + clamp(change_7d, -60, 120) / 100 * 0.50
//   maturityMult   = 0.60 + min(age_days, 1095) / 1095 * 0.40   (age unknown: 365 days)
//   chainMult      = 1 + min(chains - 1, 8) * 0.02            (reach across chains)
//   implied        = max(1, round(tvl_usd * peerMultiple * launchDiscount
//                                  * growthMult * maturityMult * chainMult))
//
// No protocol name is ever special-cased: the same function scores every row.

/** One protocol entry in the snapshot: exactly the ten fields the sealed input carries. */
export interface ProtoRec {
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

/** The whole snapshot document. */
export interface SnapDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: ProtoRec[];
  watchlist: string[];
}

/** The model's tunable constants, as the dashboard states them and the sandbox may change them. */
export interface ModelCfg {
  launch_discount: number;
  peer_floor: number;
  peer_cap: number;
  peer_min_count: number;
  peer_blend_weight: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_max_steps: number;
}

export const CFG: ModelCfg = {
  launch_discount: 0.5,
  peer_floor: 0.05,
  peer_cap: 1.0,
  peer_min_count: 3,
  peer_blend_weight: 3,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.02,
  chain_max_steps: 8,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_TAG = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_N = 24;

/** One step of a farm plan: the action, what it costs, and how long it takes. */
export interface FarmAct {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRec {
  rank: number;
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
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    peer_multiple: number;
    peer_count: number;
    launch_discount: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row; the farm plan is generated in the page. */
export interface RadarRec {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  peer_multiple: number;
  peer_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRec {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarSet {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelCfg;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_peer_multiple: number;
  rows: RadarRec[];
  live: LiveRec[];
}

/** Why the snapshot is not one this model can score. */
export class SnapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapError';
  }
}

const MS_DAY = 86_400_000;

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnap(text: string): SnapDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Round to four decimals: the board and the page both read the rounded value. */
const round4dp = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function daysSince(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${asOf}T00:00:00Z`);
  const listed = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(listed)) return null;
  return Math.max(0, Math.floor((start - listed) / MS_DAY));
}

/** The median of a sorted array, or null when it is empty. */
function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The peer multiples: for every category, the median mcap/TVL of the live-token protocols in
 * it, plus the global median across all live-token protocols. Computed from the snapshot at
 * run time.
 */
export interface PeerBook {
  byCat: Map<string, { multiple: number; count: number }>;
  global: number;
}

export function peerBook(protocols: ProtoRec[]): PeerBook {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? 'Other';
    const list = byCategory.get(key);
    if (list) list.push(ratio);
    else byCategory.set(key, [ratio]);
  }
  all.sort((a, b) => a - b);
  const global = medianOf(all) ?? 0.17;
  const table = new Map<string, { multiple: number; count: number }>();
  for (const [key, ratios] of byCategory) {
    ratios.sort((a, b) => a - b);
    table.set(key, { multiple: medianOf(ratios) ?? global, count: ratios.length });
  }
  return { byCat: table, global };
}

/**
 * One category's peer multiple: the category median when it has enough peers, blended toward
 * the global median when it has few, the global median when it has none; then clamped and
 * rounded, so the board and the page read the same value.
 */
export function peerRate(category: string | null, peers: PeerBook, model: ModelCfg): { multiple: number; count: number } {
  const entry = peers.byCat.get(category ?? 'Other');
  const count = entry?.count ?? 0;
  let multiple: number;
  if (count >= model.peer_min_count) {
    multiple = entry!.multiple;
  } else if (count > 0) {
    const w = model.peer_blend_weight;
    multiple = (count * entry!.multiple + w * peers.global) / (count + w);
  } else {
    multiple = peers.global;
  }
  multiple = Math.min(model.peer_cap, Math.max(model.peer_floor, multiple));
  multiple = round4dp(multiple);
  return { multiple, count };
}

/** The multipliers and the implied value one protocol gets under `model`. */
export function scoreProto(
  protocol: ProtoRec,
  asOf: string,
  peers: PeerBook,
  model: ModelCfg,
): { implied: number; peer: number; peerN: number; growthPct: number; growth: number; maturity: number; chain: number; age: number | null } {
  const age = daysSince(asOf, protocol.listed_at);
  const { multiple, count } = peerRate(protocol.category, peers, model);
  const rawGrowth = numOr(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growth = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturity = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const chainSteps = Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_max_steps);
  const chain = 1 + chainSteps * model.chain_step;
  const implied = Math.max(
    1,
    Math.round(protocol.tvl_usd * multiple * model.launch_discount * growth * maturity * chain),
  );
  return { implied, peer: multiple, peerN: count, growthPct, growth, maturity, chain, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VER_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const WRAP_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names a wrapped product's name may begin with. */
const EXCH_LEAD = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** A whole word that marks a name as a wrapped or staked product. */
const WRAP_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
export function noToken(p: ProtoRec): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or
 * bridged product of a token that already trades, not an exchange, not a versioned pool. This
 * is the watchlist's own exclusion rule, applied to the whole pre-token universe so the early
 * radar never promotes a product whose underlying token already trades.
 */
export function canRank(p: ProtoRec): boolean {
  return (
    noToken(p) &&
    !WRAP_CATS.has(p.category ?? '') &&
    !VER_TAIL.test(p.name) &&
    !EXCH_LEAD.test(p.name) &&
    !WRAP_WORD.test(p.name)
  );
}

/** The snapshot's protocols by slug. */
function slugIndex(protocols: ProtoRec[]): Map<string, ProtoRec> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function makeBoard(snapshot: SnapDoc, model: ModelCfg = CFG): BoardRec[] {
  const index = slugIndex(snapshot.protocols);
  const peers = peerBook(snapshot.protocols);
  const watchlist = new Set(snapshot.watchlist);
  const chosen = new Map<string, ProtoRec>();
  // The watchlist is the floor: every slug it names, even one the snapshot no longer carries
  // (it cannot, but the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, at any TVL. Never a replacement
  // for a watchlist row: a chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && canRank(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = scoreProto(p, snapshot.as_of, peers, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    on_watchlist: watchlist.has(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      peer_multiple: round4dp(s.peer),
      peer_count: s.peerN,
      launch_discount: model.launch_discount,
      growth_pct: s.growthPct,
      growth_multiplier: round4dp(s.growth),
      maturity_multiplier: round4dp(s.maturity),
      chain_multiplier: round4dp(s.chain),
      age_days: s.age,
    },
    farm_steps: farmPlan(s.p, s.age).map(stepLine),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepLine(step: FarmAct): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: ProtoRec): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeSize(p: ProtoRec): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdSpan(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionLine(p: ProtoRec, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('risk curator') || c.includes('onchain capital allocator') || c.includes('curator') || c.includes('allocator')) return `Put $${capital} into one ${name} vault on ${chain} and leave the shares there for the whole term.`;
  if (c.includes('basis trading')) return `Place $${capital} of USDC in ${name}'s basis vault on ${chain} and leave the position open.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC through ${name} on ${chain} and leave the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity manager')) return `Add $${capital} of liquidity to ${name}'s main pool on ${chain} and leave the position open.`;
  if (c.includes('bridge')) return `Move $${capital} of USDC to ${chain} with ${name} and put the bridged funds to work in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset with ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Fund $${capital} of USDC as margin on ${name} and open a single small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one market position on ${name}.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('payment') || c.includes('card')) return `Spend $${capital} through ${name} on ${chain} and keep the receipts inside the app.`;
  if (c.includes('chain')) return `Bridge $${capital} to the chain ${name} runs on and use its main app at least once a week.`;
  if (c.includes('farm') || c.includes('aggregator')) return `Place $${capital} of USDC in ${name}'s top vault on ${chain} and keep the shares.`;
  if (c.includes('index')) return `Buy $${capital} of the ${name} index token on ${chain} and hold it.`;
  return `Place $${capital} of USDC with ${name} on ${chain} and leave the position open.`;
}

/** The category's weekly qualifying action, in the words a farmer can follow. */
function weeklyLine(p: ProtoRec): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('risk curator') || c.includes('allocator') || c.includes('curator')) return 'a deposit, a rebalance or a vote inside the vault';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'a supply, a borrow, a repayment or a vote';
  if (c.includes('dex') || c.includes('yield') || c.includes('farm') || c.includes('aggregator')) return 'a swap, a deposit or a vote';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return 'a trade, a deposit or a vote';
  if (c.includes('prediction')) return 'a market position or a vote';
  if (c.includes('rwa')) return 'a mint, a transfer or a vote';
  if (c.includes('payment') || c.includes('card')) return 'a spend or a transfer';
  return 'a deposit, a borrow, a swap or a vote';
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a hand-written
 * list of names.
 */
export function farmPlan(p: ProtoRec, age: number | null): FarmAct[] {
  const chain = firstChain(p);
  const capital = stakeSize(p);
  const hold = holdSpan(age);
  const action = actionLine(p, capital, chain);
  const weekly = weeklyLine(p);
  return [
    {
      text: `Start with a fresh wallet holding only the funds you intend to farm, and store its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and roughly $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action every week, such as ${weekly}, so the wallet keeps showing activity.`,
      cost: 'around $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Keep the position in place for at least ${hold} days so the activity shows up in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before withdrawing, open the protocol's own points or rewards page and claim only through the link it publishes.`,
      cost: 'nothing to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Review the position's risk every month: the contract the protocol's own page names, the collateral ratio and the exit fee.`,
      cost: 'nothing to check',
      time: '10 minutes a month',
    },
    {
      text: `Record the wallet, the dates and every transaction in a farm log, so you can repeat the position or unwind it later.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveList(snapshot: SnapDoc): LiveRec[] {
  return snapshot.protocols
    .filter((p) => !noToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_N)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function slimRow(row: BoardRec): RadarRec {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    on_watchlist: row.on_watchlist,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    peer_multiple: row.model.peer_multiple,
    peer_count: row.model.peer_count,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildSet(snapshot: SnapDoc, model: ModelCfg = CFG): { board: BoardRec[]; radar: RadarSet } {
  const board = makeBoard(snapshot, model);
  const live = liveList(snapshot);
  const peers = peerBook(snapshot.protocols);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarSet = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_TAG,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_peer_multiple: round4dp(peers.global),
    rows: board.map(slimRow),
    live,
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardFault(board: BoardRec[], snapshot: SnapDoc): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataJs(radar: RadarSet): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
