import { PERCENTAGE_DENOMINATOR } from "../dao/policy.js";

/**
 * DAO Member Revenue arithmetic. Pure, integer-only, no I/O.
 *
 * THE ECONOMIC DEFINITION
 * -----------------------
 * System revenue for DAO purposes is ONLY Self-type staking reward generated in the epoch:
 * DIRECT + BOND + DAO. Level, Rank, Global, DAO member revenue and marketing are excluded —
 * paying a share of a reward out of another reward would compound the protocol against itself.
 *
 * It measures reward GENERATED, so claiming changes nothing: a completed epoch's revenue is
 * fixed the moment Phase 1 settles it.
 *
 * WHY THE USD ROUND-TRIP IS PRESERVED
 * -----------------------------------
 * The product defines revenue in USD and weights members by recorded USDT, so the USD figures
 * are what the UI and the audit trail must show. Algebraically the price cancels
 * (ACF -> USD -> 5% -> ACF is just ACF x 5%), but the two conversions are kept explicit because
 * the member weight is genuinely in USD and marketing takes its own 2% from the same
 * SystemRevenueUSD. Both directions use the SAME frozen epoch price, so no price movement can
 * alter a settled epoch.
 */

/** ACF has 18 decimals, USDT 6, and priceE18 is scaled 1e18: 18 + 18 - 6 = 30. */
const USD_SCALE = 10n ** 30n;

export { PERCENTAGE_DENOMINATOR };

/** Raised when a DAO revenue invariant fails. Never caught to continue; the epoch stops. */
export class DAORevenueInvariantError extends Error {
  readonly code = "DAO_REVENUE_INVARIANT";
  constructor(message: string) {
    super(message);
    this.name = "DAORevenueInvariantError";
  }
}

export function assertInvariant(condition: boolean, message: string): void {
  if (!condition) throw new DAORevenueInvariantError(message);
}

/**
 * ACF base units -> USDT base units at the epoch price. Floors.
 *
 * Identical to the Phase 2 conversion, deliberately: a DAO member's revenue and a Rank cap must
 * price the same ACF the same way.
 */
export function acfToUsd6(acfWei: bigint, priceE18: bigint): bigint {
  assertInvariant(priceE18 > 0n, `Epoch price must be positive, got ${priceE18}.`);
  assertInvariant(acfWei >= 0n, `ACF amount cannot be negative, got ${acfWei}.`);
  return (acfWei * priceE18) / USD_SCALE;
}

/** USDT base units -> ACF base units at the epoch price. Floors. The inverse of acfToUsd6. */
export function usd6ToAcf(usd6: bigint, priceE18: bigint): bigint {
  assertInvariant(priceE18 > 0n, `Epoch price must be positive, got ${priceE18}.`);
  assertInvariant(usd6 >= 0n, `USD amount cannot be negative, got ${usd6}.`);
  return (usd6 * USD_SCALE) / priceE18;
}

/** The epoch's Self-type reward base: DIRECT + BOND + DAO. */
export function systemSelfRewardACF(regularSelfACF: bigint, daoStakeRewardACF: bigint): bigint {
  assertInvariant(regularSelfACF >= 0n, `Regular Self reward cannot be negative.`);
  assertInvariant(daoStakeRewardACF >= 0n, `DAO Self reward cannot be negative.`);
  return regularSelfACF + daoStakeRewardACF;
}

/**
 * The single shared member pool. Silver and Gold draw from this one number — there is no
 * separate pool, multiplier or bonus for Gold.
 *
 * The rate is passed in rather than hardcoded: it is resolved from the DAO's own configuration
 * history as of the epoch snapshot, so raising it tomorrow cannot repay yesterday.
 */
export function daoRevenuePoolUSD6(systemRevenueUSD6: bigint, memberRevenueRateE6: bigint): bigint {
  assertInvariant(systemRevenueUSD6 >= 0n, `System revenue cannot be negative.`);
  assertInvariant(
    memberRevenueRateE6 >= 0n && memberRevenueRateE6 <= PERCENTAGE_DENOMINATOR,
    `Member revenue rate ${memberRevenueRateE6} is outside 0..${PERCENTAGE_DENOMINATOR}.`,
  );
  return (systemRevenueUSD6 * memberRevenueRateE6) / PERCENTAGE_DENOMINATOR;
}

/**
 * The epoch's marketing allocation: a SEPARATE share of the same SystemRevenueUSD.
 *
 * Not taken out of the member pool and not added to it. Members draw 5% of the whole system
 * revenue and marketing draws 2% of the same figure, so the protocol owes 7% in total and the
 * member pool is never 7%.
 *
 * Identical in shape to `daoRevenuePoolUSD6` on purpose — same denominator, same floor — so the
 * two obligations cannot drift apart in rounding. The rate is passed in, resolved from the DAO's
 * own configuration history as of the epoch snapshot, so raising it tomorrow cannot repay
 * yesterday.
 */
export function daoMarketingUSD6(systemRevenueUSD6: bigint, marketingRateE6: bigint): bigint {
  assertInvariant(systemRevenueUSD6 >= 0n, `System revenue cannot be negative.`);
  assertInvariant(
    marketingRateE6 >= 0n && marketingRateE6 <= PERCENTAGE_DENOMINATOR,
    `Marketing rate ${marketingRateE6} is outside 0..${PERCENTAGE_DENOMINATOR}.`,
  );
  return (systemRevenueUSD6 * marketingRateE6) / PERCENTAGE_DENOMINATOR;
}

/**
 * One member's share of the shared pool, weighted by RECORDED active contribution USDT.
 *
 * The weight is the USDT the member actually paid, never their ACF principal revalued at any
 * price. A 5,000 USDT contribution stays a 5,000 USDT weight for as long as its linked stake is
 * active, however far ACF has moved since.
 */
export function memberRevenueUSD6(
  poolUSD6: bigint,
  memberContributionUSDT6: bigint,
  totalEligibleContributionUSDT6: bigint,
): bigint {
  assertInvariant(
    totalEligibleContributionUSDT6 > 0n,
    "Total eligible contribution must be positive to compute a share.",
  );
  assertInvariant(
    memberContributionUSDT6 >= 0n && memberContributionUSDT6 <= totalEligibleContributionUSDT6,
    `Member contribution ${memberContributionUSDT6} is outside 0..${totalEligibleContributionUSDT6}.`,
  );
  return (poolUSD6 * memberContributionUSDT6) / totalEligibleContributionUSDT6;
}

/**
 * Whether a member's combined ACTIVE recorded contribution admits them to the pool.
 *
 * Silver is the only gate. Gold is a label: it changes what the UI calls the member and nothing
 * about what they are paid.
 */
export function isEligible(activeContributionUSDT6: bigint, silverMinimumUSDT6: bigint): boolean {
  return activeContributionUSDT6 >= silverMinimumUSDT6;
}

/** The label only. Never used in any payout calculation. */
export function membershipLabel(
  activeContributionUSDT6: bigint,
  silverMinimumUSDT6: bigint,
  goldMinimumUSDT6: bigint,
): "NONE" | "SILVER" | "GOLD" {
  if (activeContributionUSDT6 >= goldMinimumUSDT6) return "GOLD";
  if (activeContributionUSDT6 >= silverMinimumUSDT6) return "SILVER";
  return "NONE";
}

/**
 * Canonical JSON for the execution manifest: keys sorted, integers as decimal strings, arrays
 * in their given order. Byte-identical for identical content, so its hash is a real checksum.
 *
 * Mirrors the Phase 3 settlement manifest so an operator reads one format, not two.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new DAORevenueInvariantError(`Refusing to serialise non-integer ${value}.`);
    }
    return `"${value}"`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, v]) => v !== undefined && key !== "_id" && key !== "__v")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Deterministic member ordering: lowercase member address, ascending.
 *
 * Lexicographic order over fixed-width hex is total and stable, which is what makes batch
 * composition reproducible across retries — the same property Phase 1's keyset pagination
 * relies on.
 */
export function compareByAddress(
  a: { externalEOA: string },
  b: { externalEOA: string },
): number {
  const left = a.externalEOA.toLowerCase();
  const right = b.externalEOA.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Which batch a member at `index` belongs to. */
export function batchIndexOf(index: number, batchSize: number): number {
  assertInvariant(batchSize > 0, `Batch size must be positive, got ${batchSize}.`);
  return Math.floor(index / batchSize);
}
