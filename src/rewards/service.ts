import { getAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { RewardEpoch } from "../models/RewardEpoch.js";
import { runRewardEpoch, type EpochResult } from "./epoch.js";
import { completedEpochsSince } from "./policy.js";
import type { RewardChainReader } from "./chain.js";

const key = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
});

/**
 * Settles every completed epoch that has not been, oldest first.
 *
 * Strictly sequential and never parallel: epoch N's compound base includes N-1's reward, so
 * running them concurrently would let a later epoch read a base missing an earlier one's
 * reward and under-pay permanently.
 *
 * Stops at the first failure rather than skipping ahead, for the same reason.
 */
export async function catchUpRewardEpochs(
  deps: { reader?: RewardChainReader; now?: () => number } = {},
): Promise<{ processed: EpochResult[]; stoppedAt: number | null }> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const k = key();

  const candidates = completedEpochsSince(config.rewardActivationEpoch, now());
  if (candidates.length === 0) return { processed: [], stoppedAt: null };

  const done = await RewardEpoch.find(
    { ...k, epochId: { $in: candidates }, status: { $in: ["CALCULATED", "FINALIZED"] } },
    { epochId: 1 },
  ).lean();
  const settled = new Set(done.map((e) => e.epochId));

  const processed: EpochResult[] = [];
  for (const epochId of candidates) {
    if (settled.has(epochId)) continue;
    try {
      processed.push(await runRewardEpoch(epochId, deps));
    } catch (cause) {
      logger.error("reward epoch failed; halting catch-up", {
        epochId, error: (cause as Error).message,
      });
      // Deliberately does not continue: epoch N+1 would compound from an incomplete N.
      return { processed, stoppedAt: epochId };
    }
  }
  return { processed, stoppedAt: null };
}
