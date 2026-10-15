/**
 * DAO product policy — the single source of truth for the fixed DAO staking reward rate.
 *
 * WHY THIS IS NOT READ FROM THE CHAIN
 * -----------------------------------
 * A DAO position is staked into the canonical 750-day pool (pool 6 on Amoy), but it does NOT
 * earn that pool's rate. Pool 6's `currentDailyRewardRate` is a dynamic value inside the
 * contract's 0.5%-1.0% band and currently reads 0.5%; it governs ordinary source=DIRECT stakers.
 *
 * DAO positions earn a FIXED 1% daily regardless. That rate exists nowhere on-chain:
 * `Stake.dailyRewardRate` is permanently zero and documented as "never prices a reward", and
 * ACFDAO stores no rate at all. It is a product rule, defined here and nowhere else.
 *
 * Do NOT "fix the inconsistency" by reading Staking.getPool(daoPoolId).currentDailyRewardRate.
 * That would silently halve every DAO reward.
 */

/** Denominator shared with ACFDAO.PERCENTAGE_DENOMINATOR and ACFStaking rates. */
export const PERCENTAGE_DENOMINATOR = 1_000_000n;

/** 1% per day for every source=DAO position, fixed. 10_000 / 1e6 = 0.01. */
export const DAO_SOURCE_FIXED_DAILY_RATE = 10_000n;

/** 0.5% per 12-hour epoch — the daily rate halved, since there are two epochs per day. */
export const DAO_SOURCE_FIXED_EPOCH_RATE = DAO_SOURCE_FIXED_DAILY_RATE / 2n;

const asPercent = (raw: bigint) =>
  Number((raw * 10_000n) / PERCENTAGE_DENOMINATOR) / 100;

/** Served to the frontend so no component hardcodes "1%" or "0.5%". */
export const daoRewardPolicy = {
  /** 1 */
  daoDailyRewardPercentage: asPercent(DAO_SOURCE_FIXED_DAILY_RATE),
  /** 0.5 */
  daoEpochRewardPercentage: asPercent(DAO_SOURCE_FIXED_EPOCH_RATE),
  daoDailyRewardRateRaw: DAO_SOURCE_FIXED_DAILY_RATE.toString(),
  daoEpochRewardRateRaw: DAO_SOURCE_FIXED_EPOCH_RATE.toString(),
  percentageDenominator: PERCENTAGE_DENOMINATOR.toString(),
  epochsPerDay: 2,
} as const;
