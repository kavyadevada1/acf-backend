import { getAddress } from "viem";
import { config } from "../config.js";
import { RewardEpoch } from "../models/RewardEpoch.js";
import { StakeRewardEntry } from "../models/StakeRewardEntry.js";
import { claimedSelfACFForStake } from "../settlement/claims.js";
import { epochReward } from "./policy.js";

/**
 * Per-stake reward figures, projected from Phase 1's immutable rows.
 *
 * WHY THIS IS NOT /rewards/summary
 * --------------------------------
 * `/rewards/summary` is account-level and mixes Self with Team. A staking card asks a different
 * question — what has THIS position earned — and answering it with the account total would
 * attribute Team reward, and every other stake's reward, to one card.
 *
 * Nothing is recalculated here. `rewardACF` per epoch is what Phase 1 settled, and the claimed
 * portion comes from the same `claimedSelfACFForStake` the compound base uses, so a card can
 * never disagree with the engine about what is still outstanding.
 *
 * Only epochs whose RewardEpoch is settled are counted; a half-written epoch's rows exist but
 * are not yet truth.
 */

export interface StakeRewardSummary {
  /** Every settled epoch's reward for this stake, summed. Only ever grows. */
  lifetimeEarnedACF: string;
  /** Lifetime earned minus what a confirmed claim has already paid out for this stake. */
  earnedUnclaimedACF: string;
  /** What a confirmed on-chain claim has paid out for this stake. */
  claimedACF: string;
  /** The most recent settled epoch's reward, or null when the stake has never earned. */
  latestEpochRewardACF: string | null;
  latestEpochId: number | null;
  /**
   * The DAILY rate Phase 1 applied in that epoch, on RATE_DENOMINATOR.
   *
   * Daily, not per-epoch: `epochReward` divides by 2 * RATE_DENOMINATOR, so a 12-hour epoch
   * pays half of this.
   */
  latestRateE6: string | null;
  /** Principal plus unclaimed reward, as the next epoch would compound it. */
  compoundBaseACF: string | null;
  /**
   * One day at the latest applied rate on the latest compound base — two 12-hour epochs.
   *
   * An estimate from values the protocol actually used, not a forecast: the rate is a pool
   * parameter that may change, and the stake may be withdrawn. Null when the stake has no
   * settled epoch, so the UI hides the field rather than showing a guess.
   */
  estimatedDailyACF: string | null;
  /** Why the stake is not currently earning, when it is not. */
  ineligibleReason: string | null;
  settledEpochCount: number;
}

const key = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
});

/**
 * Builds per-stake summaries for every stake of one user, in two queries rather than per stake.
 *
 * Returned as a Map so the caller can attach each summary to its own stake without a second
 * pass. A stake with no settled epoch yet gets zeros and null rates, which is honest: it has
 * genuinely earned nothing, as distinct from the reward engine not having run.
 */
export async function stakeRewardSummaries(
  userId: string,
  stakeIds: string[],
): Promise<Map<string, StakeRewardSummary>> {
  const out = new Map<string, StakeRewardSummary>();
  if (stakeIds.length === 0) return out;

  const k = key();
  // Settled epochs only. Fetched once and intersected in memory, so this is two queries total
  // regardless of how many stakes or epochs the user has.
  const settled = await RewardEpoch.find(
    { ...k, status: { $in: ["CALCULATED", "FINALIZED"] } },
    { epochId: 1 },
  ).lean();
  const settledIds = new Set(settled.map((e) => e.epochId));

  const entries = await StakeRewardEntry.find(
    { ...k, userId, stakeId: { $in: stakeIds } },
    {
      stakeId: 1, epochId: 1, rewardACF: 1, principalACF: 1, compoundBaseACF: 1,
      rateApplied: 1, rewardEligible: 1, ineligibleReason: 1,
    },
  ).lean();

  const byStake = new Map<string, typeof entries>();
  for (const e of entries) {
    if (!settledIds.has(e.epochId)) continue;
    const list = byStake.get(e.stakeId) ?? [];
    list.push(e);
    byStake.set(e.stakeId, list);
  }

  for (const stakeId of stakeIds) {
    const rows = (byStake.get(stakeId) ?? []).sort((a, b) => a.epochId - b.epochId);
    if (rows.length === 0) {
      out.set(stakeId, {
        lifetimeEarnedACF: "0",
        earnedUnclaimedACF: "0",
        claimedACF: "0",
        latestEpochRewardACF: null,
        latestEpochId: null,
        latestRateE6: null,
        compoundBaseACF: null,
        estimatedDailyACF: null,
        ineligibleReason: null,
        settledEpochCount: 0,
      });
      continue;
    }

    const lifetime = rows.reduce((sum, r) => sum + BigInt(r.rewardACF), 0n);
    const latest = rows.at(-1)!;
    // The same helper Phase 1 uses for the compound base, so the two cannot disagree. The
    // `beforeEpochId` is one past the latest settled epoch, i.e. everything settled so far.
    const claimed = await claimedSelfACFForStake(k, userId, stakeId, latest.epochId + 1);
    const unclaimed = lifetime > claimed ? lifetime - claimed : 0n;

    const rate = BigInt(latest.rateApplied);
    const base = BigInt(latest.principalACF) + unclaimed;
    // Two 12-hour epochs at the rate last applied, computed with Phase 1's own helper rather
    // than a second formula — `rateApplied` is the DAILY rate and epochReward halves it, so
    // multiplying the daily rate by two epochs directly would double the figure.
    // Gated on eligibility as well as a non-zero rate. Phase 1 already stores rate 0 for an
    // ineligible stake, but a withdrawn position must never show a daily figure even if some
    // future row carried a rate — it is not earning.
    const daily = !latest.rewardEligible || rate === 0n
      ? null
      : (epochReward(base, rate) * 2n).toString();

    out.set(stakeId, {
      lifetimeEarnedACF: lifetime.toString(),
      earnedUnclaimedACF: unclaimed.toString(),
      claimedACF: claimed.toString(),
      latestEpochRewardACF: latest.rewardACF,
      latestEpochId: latest.epochId,
      latestRateE6: latest.rateApplied,
      compoundBaseACF: base.toString(),
      estimatedDailyACF: daily,
      ineligibleReason: latest.rewardEligible ? null : (latest.ineligibleReason ?? null),
      settledEpochCount: rows.length,
    });
  }
  return out;
}
