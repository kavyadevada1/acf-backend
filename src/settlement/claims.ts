import { getAddress } from "viem";
import { config } from "../config.js";
import { CheckpointSelfComponent } from "../models/CheckpointSelfComponent.js";
import { UserClaimState } from "../models/UserClaimState.js";

/**
 * How much of a stake's staking reward a CONFIRMED claim has already covered.
 *
 * This is the interface Phase 1's compound base consumes. The architecture requires
 * CompoundBase = principal + earned UNCLAIMED staking reward, and the chain alone cannot answer
 * which rewards a claim covered — it reports one combined number per address. The answer comes
 * from the per-stake components a checkpoint published, bounded by the checkpoint the user is
 * confirmed to have claimed.
 *
 * `checkpointId <= C` is a plain numeric comparison, and that is correct because settlement ids
 * are a strictly monotonic sequence allocated as previous + 1 behind an occupancy check — so
 * numeric order IS settlement order. Joining through the checkpoint table would add a lookup
 * inside Phase 1's per-stake loop for no extra guarantee.
 *
 * Team rewards are never considered: they do not compound.
 */
export async function claimedSelfACFForStake(
  k: { chainId: number; stakingContractAddress: string },
  userId: string,
  stakeId: string,
  beforeRewardEpochId: number,
): Promise<bigint> {
  const withdrawalAddress = getAddress(config.withdrawalAddress).toLowerCase();

  const state = await UserClaimState.findOne(
    { chainId: k.chainId, withdrawalAddress, userId },
    { highestClaimedCheckpointId: 1 },
  ).lean();
  const highest = state?.highestClaimedCheckpointId ?? null;
  if (highest === null) return 0n;

  const rows = await CheckpointSelfComponent.find(
    {
      chainId: k.chainId,
      stakingContractAddress: k.stakingContractAddress,
      withdrawalAddress,
      userId,
      stakeId,
      rewardEpochId: { $lt: beforeRewardEpochId },
      checkpointId: { $lte: highest },
    },
    { rewardACF: 1 },
  ).lean();

  return rows.reduce((sum, r) => sum + BigInt(r.rewardACF), 0n);
}
