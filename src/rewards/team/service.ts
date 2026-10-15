import { getAddress } from "viem";
import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";
import { RewardEpoch } from "../../models/RewardEpoch.js";
import { RewardPhase2Epoch } from "../../models/RewardPhase2Epoch.js";
import { runTeamRewardEpoch, type TeamEpochResult } from "./epoch.js";

const key = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
});

/**
 * Settles every Phase-1-complete epoch that Team Reward has not, oldest first.
 *
 * Team rewards do not compound, so chronological order is not a correctness requirement the
 * way it is in Phase 1. It is still enforced, and the sweep still HALTS on the first failure
 * rather than skipping ahead: a hole in the middle of a settled range is far harder to notice
 * and reason about later than a clean stopping point.
 */
export async function catchUpTeamRewardEpochs(): Promise<{
  processed: TeamEpochResult[];
  stoppedAt: number | null;
}> {
  const k = key();

  // Only epochs Phase 1 has actually settled are candidates.
  const settledPhase1 = await RewardEpoch.find(
    { ...k, status: { $in: ["CALCULATED", "FINALIZED"] } },
    { epochId: 1 },
  ).sort({ epochId: 1 }).lean();
  if (settledPhase1.length === 0) return { processed: [], stoppedAt: null };

  const candidates = settledPhase1.map((e) => e.epochId);
  const done = await RewardPhase2Epoch.find(
    { ...k, epochId: { $in: candidates }, status: "CALCULATED" },
    { epochId: 1 },
  ).lean();
  const settled = new Set(done.map((e) => e.epochId));

  const processed: TeamEpochResult[] = [];
  for (const epochId of candidates) {
    if (settled.has(epochId)) continue;
    try {
      processed.push(await runTeamRewardEpoch(epochId));
    } catch (cause) {
      logger.error("team reward epoch failed; halting catch-up", {
        epochId, error: (cause as Error).message,
      });
      return { processed, stoppedAt: epochId };
    }
  }
  return { processed, stoppedAt: null };
}
