/**
 * Reward engine policy: epoch arithmetic, eligibility and the reward formulas.
 *
 * Pure and dependency-free so every rule here is testable without a database, an RPC endpoint
 * or a 12-hour wait.
 */

/** Twelve hours. Two epochs per day, on UTC boundaries. */
export const EPOCH_SECONDS = 43_200;

/** Shared with ACFStaking and ACFDAO. 10_000 = 1%, 2_500 = 0.25%. */
export const RATE_DENOMINATOR = 1_000_000n;

/**
 * Fixed DAO policy: 1% daily.
 *
 * NOT ACFStaking.getPool(daoPoolId).currentDailyRewardRate, which is 0.5% and governs ordinary
 * stakers in the same pool. Reading that here would silently halve every DAO reward.
 */
export const DAO_DAILY_RATE = 10_000n;

/**
 * An epoch settles the twelve-hour window that JUST COMPLETED.
 *
 *   epochId      = snapshotAt / 43200
 *   snapshotAt   = epochId * 43200          always 00:00 or 12:00 UTC
 *   windowStart  = snapshotAt - 43200
 *
 * The window is [windowStart, snapshotAt): running at 12:00 settles 00:00→12:00, never
 * 12:00→24:00, which has not happened yet.
 */
export const snapshotAtOf = (epochId: number): number => epochId * EPOCH_SECONDS;
export const windowStartOf = (epochId: number): number => snapshotAtOf(epochId) - EPOCH_SECONDS;

/** The most recent epoch whose window has fully elapsed at `nowSeconds`. */
export const latestCompletedEpochId = (nowSeconds: number): number =>
  Math.floor(nowSeconds / EPOCH_SECONDS);

/** Every completed epoch in [fromEpochId, now], oldest first. Compounding demands this order. */
export function completedEpochsSince(fromEpochId: number, nowSeconds: number): number[] {
  const latest = latestCompletedEpochId(nowSeconds);
  if (latest < fromEpochId) return [];
  return Array.from({ length: latest - fromEpochId + 1 }, (_, i) => fromEpochId + i);
}

export type StakeSource = "DIRECT" | "BOND" | "DAO";

export interface EligibilityInput {
  source: StakeSource;
  /** Chain truth, re-read before every epoch. Only withdrawal makes this false. */
  active: boolean;
  /** Unix seconds. */
  stakeTimestamp: number;
}

export type IneligibleReason = "WITHDRAWN" | "TOO_YOUNG";

export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: IneligibleReason };

/**
 * Whether a stake earns at this snapshot.
 *
 *   withdrawn   never earns again, whatever the source
 *   age < 12h   never earns; age is measured to snapshotAt, not windowStart
 *   otherwise   earns
 *
 * MATURITY IS DELIBERATELY ABSENT, for every source.
 *
 * Maturity and withdrawal are different events and must not be conflated:
 *   MATURITY / UNLOCK  the principal BECOMES WITHDRAWABLE
 *   WITHDRAWAL         the principal is taken back; the stake goes inactive and stops earning
 *
 * A matured position the user has simply left staked is still staked, so it keeps earning and
 * keeps compounding at the epoch's current pool ROI. Only the user taking their principal back
 * ends it — and that arrives here as `active: false`, read from the chain, never inferred from
 * the clock passing unlockTimestamp.
 *
 * `unlockTimestamp` is still authoritative for WHETHER A WITHDRAWAL IS PERMITTED. It is simply
 * not a reward boundary.
 */
export function isRewardEligible(stake: EligibilityInput, snapshotAt: number): Eligibility {
  if (!stake.active) return { eligible: false, reason: "WITHDRAWN" };
  if (snapshotAt - stake.stakeTimestamp < EPOCH_SECONDS) {
    return { eligible: false, reason: "TOO_YOUNG" };
  }
  return { eligible: true };
}

/**
 * The amount a stake earns this epoch.
 *
 * CompoundBase = on-chain principal + staking reward earned in PRIOR CALCULATED epochs and not
 * yet claimed. Reward from this epoch joins the base next epoch, never its own.
 *
 * Integer division throughout, so the result floors. The protocol never pays more than the
 * formula, and floor is what the same expression would do in Solidity — a later on-chain
 * migration cannot therefore change anyone's balance.
 */
export function epochReward(compoundBaseACF: bigint, dailyRate: bigint): bigint {
  if (compoundBaseACF <= 0n || dailyRate <= 0n) return 0n;
  return (compoundBaseACF * dailyRate) / (2n * RATE_DENOMINATOR);
}

/** The daily rate a stake is priced at: the epoch's pool snapshot, or fixed DAO policy. */
export function rateFor(source: StakeSource, epochPoolDailyROI: bigint | undefined): bigint {
  if (source === "DAO") return DAO_DAILY_RATE;
  return epochPoolDailyROI ?? 0n;
}
