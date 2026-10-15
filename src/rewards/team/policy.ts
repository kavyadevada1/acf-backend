/**
 * Team Reward policy: Level rates, the rank table, and the formulas.
 *
 * Pure and dependency-free, so every rule is testable without a database, an RPC endpoint or
 * a referral tree.
 *
 * Team = Level + Rank + Global. None of it compounds — only Phase 1 staking rewards do.
 */

/** Shared with Phase 1 and the contracts. 1e6 = 100%, 100_000 = 10%. */
export const RATE_DENOMINATOR = 1_000_000n;

/** USDT base units. One whole dollar. */
export const USD = 1_000_000n;

const ACF_SCALE = 10n ** 18n;
const PRICE_SCALE = 10n ** 18n;
/** acfWei(1e18) x priceE18(1e18) / 1e30 = USD6(1e6). */
const ACF_TO_USD6 = (ACF_SCALE * PRICE_SCALE) / USD;

/**
 * ACF base units to USDT base units at the epoch price.
 *
 * One conversion serves rank qualification, the rank cap and every audit figure, so there is
 * a single place for the 18-vs-6 decimal relationship to be right. Floors.
 */
export function acfToUsd6(acfWei: bigint, priceE18: bigint): bigint {
  if (acfWei <= 0n || priceE18 <= 0n) return 0n;
  return (acfWei * priceE18) / ACF_TO_USD6;
}

/** USDT base units back to ACF base units at the epoch price. Floors. */
export function usd6ToAcf(usd6: bigint, priceE18: bigint): bigint {
  if (usd6 <= 0n) return 0n;
  if (priceE18 <= 0n) throw new Error("Cannot convert USD to ACF at a zero price.");
  return (usd6 * ACF_TO_USD6) / priceE18;
}

// ── Level ────────────────────────────────────────────────────────────────────

/** L1..L7 on denominator 1e6: 10%, 8%, 6%, 4%, 4%, 1%, 1%. Total 34%. */
export const LEVEL_RATES: readonly bigint[] = [
  100_000n, 80_000n, 60_000n, 40_000n, 40_000n, 10_000n, 10_000n,
];

export const LEVEL_MAX_DEPTH = LEVEL_RATES.length;

/**
 * The three direct-qualification rules this protocol has used, in historical order.
 *
 * ACTIVE_STAKE   a direct counted once they held an active stake.
 * ONBOARDED      a direct counted once they had created an application wallet on chain.
 * REGISTERED_EOA a direct counts from their first successful registration. No wallet to create,
 *                no stake required: the address that authenticated IS the protocol identity.
 *
 * The first two are historical. Their semantics are preserved here and in the pure tests because
 * rank snapshots record which rule settled them, but neither can be COMPUTED by this build any
 * more: both were derived from smart-wallet facts that the application no longer holds. An epoch
 * that resolves to one of them therefore fails closed rather than settling on absent evidence.
 */
export type DirectRule = "ACTIVE_STAKE" | "ONBOARDED" | "REGISTERED_EOA";

/**
 * First epoch settled under the onboarded-direct rule.
 *
 * A direct counted for Level unlock and for the Rank direct requirement once that user had
 * completed onboarding by creating their application wallet — established from the chain, as-of the
 * epoch's snapshot. No stake was required.
 *
 * Epochs before this one keep the semantics they were actually settled under: Level unlock on
 * every registered direct, Rank on directs holding active stake.
 */
export const ONBOARDED_DIRECT_RULE_START_EPOCH = 41462;

/**
 * Which direct rule an epoch settles under.
 *
 * `registeredEoaStartEpoch` is passed in rather than read from configuration, so this module
 * stays pure and the cutover is visible at every call site. Derived from the epoch id and the
 * cutover alone — never the clock, never the latest settled epoch — so an epoch replayed later
 * resolves to the rule it was settled under.
 */
export function directRuleForEpoch(epochId: number, registeredEoaStartEpoch: number): DirectRule {
  if (epochId >= registeredEoaStartEpoch) return "REGISTERED_EOA";
  if (epochId >= ONBOARDED_DIRECT_RULE_START_EPOCH) return "ONBOARDED";
  return "ACTIVE_STAKE";
}

/**
 * Which staking Self rewards propagate into Level and Rank.
 *
 * REGULAR_ONLY: DIRECT and BOND only. A DAO position's staking reward stayed with its owner.
 * ALL_SOURCES: DIRECT, BOND and DAO alike, through the unchanged Level and Rank formulas.
 */
export const TEAM_PROPAGATION_REGULAR_ONLY = "REGULAR_ONLY";
export const TEAM_PROPAGATION_ALL_SOURCES = "ALL_SOURCES";

export type TeamPropagationRule =
  | typeof TEAM_PROPAGATION_REGULAR_ONLY
  | typeof TEAM_PROPAGATION_ALL_SOURCES;

/**
 * First epoch in which DAO staking reward propagates to Level and Rank.
 *
 * 41463 begins at 2026-10-05 12:00:00 UTC. Epochs 41459 to 41462 settled while a DAO position's
 * staking reward was its owner's alone, and they keep that meaning: two of their settlement
 * checkpoints are finalized on chain with a claim against them, so a replay must reproduce what
 * was published rather than what today's rule would say.
 *
 * This changes only WHICH staking rewards feed Level and Rank. It does not touch Global, which
 * is computed from principal; nor SystemRevenue, which reads Self reward from a different
 * collection; nor DAO Member Revenue, which is a separate payout entirely.
 */
export const DAO_TEAM_PROPAGATION_START_EPOCH = 41463;

/**
 * The propagation rule for an epoch.
 *
 * Derived from the epoch id and nothing else — never the clock, never the latest settled epoch.
 * An epoch replayed years from now must settle under the rule it was settled under.
 */
export function teamPropagationRuleForEpoch(epochId: number): TeamPropagationRule {
  return epochId >= DAO_TEAM_PROPAGATION_START_EPOCH
    ? TEAM_PROPAGATION_ALL_SOURCES
    : TEAM_PROPAGATION_REGULAR_ONLY;
}

/**
 * Levels a leader has unlocked, from their own qualifying direct count.
 *
 * Takes a count, not a policy: the caller decides which count the epoch's rule supplies. Under
 * REGISTERED_EOA that is the directs who had registered by the snapshot. There is NO stake
 * condition. Going from 3 to 4 unlocks four levels at once; there is no 5/6/7 tier.
 */
export function unlockedLevels(directCount: number): number {
  if (directCount <= 0) return 0;
  if (directCount >= 4) return LEVEL_MAX_DEPTH;
  return directCount;
}

/** One ancestor's Level credit from one downline user's epoch staking reward. Floors. */
export function levelReward(sourceRegularSelfACF: bigint, relativeLevel: number): bigint {
  if (sourceRegularSelfACF <= 0n) return 0n;
  const rate = LEVEL_RATES[relativeLevel - 1];
  if (rate === undefined) return 0n;               // relative L8+ earns nothing
  return (sourceRegularSelfACF * rate) / RATE_DENOMINATOR;
}

export const levelRate = (relativeLevel: number): bigint =>
  LEVEL_RATES[relativeLevel - 1] ?? 0n;

// ── Rank ─────────────────────────────────────────────────────────────────────

export interface RankTier {
  n: number;
  name: string;
  selfUSD6: bigint;
  /** Null for ranks 7-12: the Team requirement is INHERITED down the chain to Master's $1.2M. */
  teamUSD6: bigint | null;
  /** The tier's direct THRESHOLD, compared against the epoch's qualifying count. */
  requiredDirects: number;
  rateE6: bigint;
  /**
   * The TWELVE-HOUR cap, already halved from the published daily figure.
   * Nova's published daily cap is $10; this is $5. Halving again pays everyone half.
   */
  epochCapUSD6: bigint;
  /** Null for ranks 1-6. Otherwise the rank that must already be satisfied. */
  requiresRank: number | null;
}

export const RANK_TIERS: readonly RankTier[] = [
  { n: 1,  name: "Nova",     selfUSD6:    100n * USD, teamUSD6:     5_000n * USD, requiredDirects: 2,  rateE6:   100_000n, epochCapUSD6:      5n * USD, requiresRank: null },
  { n: 2,  name: "Vertex",   selfUSD6:    300n * USD, teamUSD6:    15_000n * USD, requiredDirects: 3,  rateE6:   200_000n, epochCapUSD6:     15n * USD, requiresRank: null },
  { n: 3,  name: "Crown",    selfUSD6:    900n * USD, teamUSD6:    45_000n * USD, requiredDirects: 4,  rateE6:   300_000n, epochCapUSD6:     45n * USD, requiresRank: null },
  { n: 4,  name: "Royal",    selfUSD6:  2_000n * USD, teamUSD6:   135_000n * USD, requiredDirects: 5,  rateE6:   400_000n, epochCapUSD6:    125n * USD, requiresRank: null },
  { n: 5,  name: "Legend",   selfUSD6:  5_000n * USD, teamUSD6:   400_000n * USD, requiredDirects: 6,  rateE6:   500_000n, epochCapUSD6:    375n * USD, requiresRank: null },
  { n: 6,  name: "Master",   selfUSD6:  7_500n * USD, teamUSD6: 1_200_000n * USD, requiredDirects: 7,  rateE6:   600_000n, epochCapUSD6:  1_000n * USD, requiresRank: null },
  { n: 7,  name: "Quantum",  selfUSD6: 10_000n * USD, teamUSD6: null,             requiredDirects: 8,  rateE6:   700_000n, epochCapUSD6:  2_500n * USD, requiresRank: 6 },
  { n: 8,  name: "Prestige", selfUSD6: 12_500n * USD, teamUSD6: null,             requiredDirects: 9,  rateE6:   800_000n, epochCapUSD6:  5_000n * USD, requiresRank: 7 },
  { n: 9,  name: "Monarch",  selfUSD6: 15_000n * USD, teamUSD6: null,             requiredDirects: 10, rateE6:   900_000n, epochCapUSD6: 10_000n * USD, requiresRank: 8 },
  { n: 10, name: "Empire",   selfUSD6: 17_500n * USD, teamUSD6: null,             requiredDirects: 10, rateE6: 1_000_000n, epochCapUSD6: 20_000n * USD, requiresRank: 9 },
  { n: 11, name: "Supreme",  selfUSD6: 20_000n * USD, teamUSD6: null,             requiredDirects: 10, rateE6: 1_100_000n, epochCapUSD6: 40_000n * USD, requiresRank: 10 },
  { n: 12, name: "EternalX", selfUSD6: 20_000n * USD, teamUSD6: null,             requiredDirects: 10, rateE6: 1_200_000n, epochCapUSD6: 75_000n * USD, requiresRank: 11 },
];

/** Ranks 1-6 depend only on the leader's own numbers. */
export const BASE_TIERS = RANK_TIERS.filter((t) => t.requiresRank === null);
/** Ranks 7-12 additionally depend on OTHER users' ranks in the downline. */
export const HIGH_TIERS = RANK_TIERS.filter((t) => t.requiresRank !== null);

/** Each of ranks 7-12 needs at least this many downline users at the required rank or higher. */
export const REQUIRED_QUALIFIERS = 2;

/** The thresholds a qualifier count is ever tested against: Master(6) .. Supreme(11). */
export const QUALIFIER_THRESHOLDS: readonly number[] =
  HIGH_TIERS.map((t) => t.requiresRank!);

export const rankTier = (rank: number): RankTier | null =>
  RANK_TIERS.find((t) => t.n === rank) ?? null;

/** 0 for unranked — never implicitly Nova. */
export const rankRateE6 = (rank: number): bigint => rankTier(rank)?.rateE6 ?? 0n;
export const rankCapUSD6 = (rank: number): bigint => rankTier(rank)?.epochCapUSD6 ?? 0n;
export const rankName = (rank: number): string | null => rankTier(rank)?.name ?? null;

export interface RankInputs {
  selfStakeUSD6: bigint;
  teamStakeUSD6: bigint;
  /**
   * The direct count this epoch's rule qualifies on.
   *
   * Under REGISTERED_EOA this is registeredDirects: directs who had registered as of the
   * snapshot, with no stake condition. Under the earlier rules it was directs who had onboarded,
   * or directs holding active stake. Named for its role rather than any one source, so no
   * reading can be mistaken for another.
   */
  qualifyingDirects: number;
  /** How many strict descendants hold rank >= threshold, capped at REQUIRED_QUALIFIERS. */
  qualifiersAtOrAbove: ReadonlyMap<number, number>;
}

/**
 * Highest of ranks 1-6 the leader qualifies for, or 0.
 *
 * Requirements are cumulative and monotonic, so scanning upward and keeping the last match is
 * correct. Comparisons are `>=`, so landing exactly on a threshold qualifies.
 */
export function baseRank(input: RankInputs): number {
  let best = 0;
  for (const t of BASE_TIERS) {
    if (
      input.selfStakeUSD6 >= t.selfUSD6 &&
      input.teamStakeUSD6 >= (t.teamUSD6 ?? 0n) &&
      input.qualifyingDirects >= t.requiredDirects
    ) {
      best = t.n;
    }
  }
  return best;
}

/**
 * The leader's final rank, promoting through 7-12 while each tier's conditions hold.
 *
 * The inherited Team requirement is enforced structurally rather than restated: baseRank
 * already demanded Master's $1,200,000 to return 6, and Quantum requires a current rank of 6.
 * Each later tier requires the previous one, so the whole chain carries that figure upward.
 *
 * `break` rather than `continue` — the tiers are monotonic, so the first failure ends it.
 */
export function resolveRank(input: RankInputs): number {
  let current = baseRank(input);
  for (const t of HIGH_TIERS) {
    const required = t.requiresRank!;
    if (current < required) break;
    if (input.selfStakeUSD6 < t.selfUSD6) break;
    if (input.qualifyingDirects < t.requiredDirects) break;
    if ((input.qualifiersAtOrAbove.get(required) ?? 0) < REQUIRED_QUALIFIERS) break;
    current = t.n;
  }
  return current;
}

// ── Rank reward ──────────────────────────────────────────────────────────────

/**
 * The differential rate: the leader's rate minus the best rate already present below them.
 *
 * Without it, the same downline reward would be paid many times over as it passes up a chain
 * of leaders. Summed up a chain, the differentials total exactly the top leader's rate.
 */
export function differentialRateE6(leaderRank: number, highestDownlineRank: number): bigint {
  const leader = rankRateE6(leaderRank);
  const downline = rankRateE6(highestDownlineRank);
  return leader > downline ? leader - downline : 0n;
}

export function grossRankReward(teamRewardBaseACF: bigint, effectiveRateE6: bigint): bigint {
  if (teamRewardBaseACF <= 0n || effectiveRateE6 <= 0n) return 0n;
  return (teamRewardBaseACF * effectiveRateE6) / RATE_DENOMINATOR;
}

/**
 * Applies the twelve-hour cap in USD, then converts back.
 *
 * `epochCapUSD6` is used AS GIVEN — the table already holds the halved figure. Each epoch gets
 * its own full cap: no rolling window, no shared UTC-day bucket, no carry-over.
 */
export function applyRankCap(
  grossACF: bigint,
  epochCapUSD6: bigint,
  priceE18: bigint,
): { payableACF: bigint; capped: boolean; grossUSD6: bigint } {
  const grossUSD6 = acfToUsd6(grossACF, priceE18);
  if (grossUSD6 <= epochCapUSD6) return { payableACF: grossACF, capped: false, grossUSD6 };
  return { payableACF: usd6ToAcf(epochCapUSD6, priceE18), capped: true, grossUSD6 };
}

// ── Global ───────────────────────────────────────────────────────────────────

/**
 * Global Contribution, in ACF base units.
 *
 * The architecture states this in USD as
 *   (selfUSD x l1USD x rank) / networkUSD, then / P
 * but every USD term is (wei x P / 1e18), so the numerator carries P-squared, the denominator
 * carries P, and the final division by P removes the last one. The price CANCELS, leaving
 *   ACF = self x l1 x rank / network
 * which is implemented directly: one division instead of four, so no intermediate truncation
 * and no price dependence in the payout at all.
 *
 * The denominator is guarded BEFORE dividing — a quiet epoch returns 0 rather than throwing.
 * There is deliberately no cap; small denominators producing large payouts is an accepted
 * property of the approved economics.
 */
export function globalReward(
  selfStakeACF: bigint,
  l1StakeACF: bigint,
  rankNumber: number,
  networkContributionACF: bigint,
): bigint {
  if (rankNumber <= 0) return 0n;
  if (networkContributionACF <= 0n) return 0n;
  if (selfStakeACF <= 0n || l1StakeACF <= 0n) return 0n;
  return (selfStakeACF * l1StakeACF * BigInt(rankNumber)) / networkContributionACF;
}
