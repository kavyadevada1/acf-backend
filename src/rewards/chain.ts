import { getAddress } from "viem";
import { config } from "../config.js";
import { publicClient } from "../lib/chain.js";
import { stakingPoolAbi, stakingRewardAbi } from "../abi/daoEvent.js";
import { acfSwapPriceAbi } from "../abi/swapEvent.js";

/**
 * Chain reads for the reward engine.
 *
 * Every per-stake read goes through multicall: ACFStaking exposes no batch getter, so a serial
 * loop would be one RPC round trip per stake and would make a large epoch take hours.
 *
 * REWARD-CRITICAL READS ARE PINNED TO A BLOCK. An epoch settles a window that has already
 * closed, so "what is true now" is the wrong question — a withdrawal, an admin ROI change or a
 * price move after the boundary must not alter a settled epoch. Callers pass the epoch's
 * snapshot block and get the state as it was at that instant. Omitting the block means latest,
 * which only stake DISCOVERY wants.
 */

/** Pins a read to one historical block. Omitted or undefined means latest. */
export interface BlockPin {
  blockNumber?: bigint;
}

export interface ChainStake {
  stakeId: bigint;
  user: string;
  principal: bigint;
  poolId: bigint;
  stakeTimestamp: bigint;
  unlockTimestamp: bigint;
  active: boolean;
  source: 0 | 1 | 2;
}

export interface ChainPool {
  poolId: number;
  lockDuration: number;
  currentDailyRewardRate: bigint;
  active: boolean;
}

export interface BlockRef {
  blockNumber: bigint;
  blockTimestamp: number;
}

export interface RewardChainReader {
  nextStakeId(): Promise<bigint>;
  getStakes(ids: bigint[], pin?: BlockPin): Promise<(ChainStake | null)[]>;
  getPools(pin?: BlockPin): Promise<ChainPool[]>;
  priceSnapshot(pin?: BlockPin): Promise<{ priceE18: bigint; blockNumber: number; blockTimestamp: number }>;
  /** Highest block whose timestamp is <= `timestampSeconds`. */
  blockAtOrBefore(timestampSeconds: number): Promise<BlockRef>;
  /** Earliest block in (afterBlock, atOrBeforeBlock] where the stake reads inactive. */
  findWithdrawalBlock(stakeId: bigint, afterBlock: bigint, atOrBeforeBlock: bigint): Promise<BlockRef>;
}

const STAKING = () => getAddress(config.acfStakingAddress);

/** Block timestamps are immutable, so caching them within a run is always safe. */
const blockTimestampCache = new Map<string, number>();

async function timestampOf(blockNumber: bigint): Promise<number> {
  const key = blockNumber.toString();
  const hit = blockTimestampCache.get(key);
  if (hit !== undefined) return hit;
  const block = await publicClient.getBlock({ blockNumber });
  const seconds = Number(block.timestamp);
  blockTimestampCache.set(key, seconds);
  return seconds;
}

async function activeAt(stakeId: bigint, blockNumber: bigint): Promise<boolean | null> {
  try {
    const s = await publicClient.readContract({
      address: STAKING(), abi: stakingPoolAbi, functionName: "getStake", args: [stakeId], blockNumber,
    });
    return (s as unknown as { active: boolean }).active;
  } catch {
    // The stake did not exist at that block, or the read failed. The caller decides.
    return null;
  }
}

export const rewardChainReader: RewardChainReader = {
  async nextStakeId() {
    return publicClient.readContract({
      address: STAKING(), abi: stakingRewardAbi, functionName: "nextStakeId",
    });
  },

  async getStakes(ids, pin) {
    if (ids.length === 0) return [];
    const results = await publicClient.multicall({
      contracts: ids.map((id) => ({
        address: STAKING(), abi: stakingPoolAbi, functionName: "getStake" as const, args: [id] as const,
      })),
      allowFailure: true,
      ...(pin?.blockNumber !== undefined ? { blockNumber: pin.blockNumber } : {}),
    });
    // A failed entry is NOT treated as "absent": an unknown id and an RPC hiccup must not look
    // the same, so null is returned and the caller decides whether that is fatal.
    return results.map((r) => {
      if (r.status !== "success") return null;
      const s = r.result as unknown as {
        stakeId: bigint; user: string; principal: bigint; poolId: bigint;
        stakeTimestamp: bigint; unlockTimestamp: bigint; active: boolean; source: number;
      };
      return { ...s, user: s.user.toLowerCase(), source: s.source as 0 | 1 | 2 };
    });
  },

  async getPools(pin) {
    const at = pin?.blockNumber !== undefined ? { blockNumber: pin.blockNumber } : {};
    // Read the pool COUNT at the same block: a pool created after the boundary must not appear
    // in a historical snapshot.
    const next = await publicClient.readContract({
      address: STAKING(), abi: stakingRewardAbi, functionName: "nextPoolId", ...at,
    });
    const ids = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1));
    if (ids.length === 0) return [];

    const results = await publicClient.multicall({
      contracts: ids.map((id) => ({
        address: STAKING(), abi: stakingPoolAbi, functionName: "getPool" as const, args: [id] as const,
      })),
      allowFailure: true,
      ...at,
    });

    return results.map((r, i) => {
      // One unreadable pool fails the epoch: pricing a stake against a missing rate would
      // silently pay zero rather than report a problem.
      if (r.status !== "success") {
        throw new Error(`Pool ${ids[i]} could not be read; refusing to snapshot a partial ROI set.`);
      }
      const p = r.result as unknown as {
        lockDuration: bigint; currentDailyRewardRate: bigint; active: boolean;
      };
      return {
        poolId: Number(ids[i]),
        lockDuration: Number(p.lockDuration),
        currentDailyRewardRate: p.currentDailyRewardRate,
        active: p.active,
      };
    });
  },

  async priceSnapshot(pin) {
    // Price and block are read at the SAME block. Reading the block first and the price "now"
    // would record a price against a block it was never true at.
    const blockNumber = pin?.blockNumber ?? (await publicClient.getBlock()).number!;
    const blockTimestamp = await timestampOf(blockNumber);
    const priceE18 = await publicClient.readContract({
      address: getAddress(config.acfSwapAddress), abi: acfSwapPriceAbi, functionName: "priceE18",
      blockNumber,
    });
    // Zero is never a valid price; substituting one would value an entire epoch at nothing.
    if (priceE18 <= 0n) throw new Error("Swap.priceE18() returned zero; refusing to settle an epoch.");
    return { priceE18, blockNumber: Number(blockNumber), blockTimestamp };
  },

  /**
   * Resolves an epoch boundary to a block by BINARY SEARCH over real block timestamps.
   *
   * Never estimated from an average block time: Amoy's cadence is not constant, and an estimate
   * would silently settle an epoch against the wrong state. The result is verified from both
   * sides — the chosen block is at or before the boundary, and the next one is after it — so a
   * wrong answer fails rather than being used.
   */
  async blockAtOrBefore(timestampSeconds) {
    const latest = await publicClient.getBlock();
    const latestNumber = latest.number!;
    blockTimestampCache.set(latestNumber.toString(), Number(latest.timestamp));

    // Refuse while the chain has not yet passed the boundary: the highest block at or before it
    // is not final, so a later retry would resolve a different one.
    if (Number(latest.timestamp) <= timestampSeconds) {
      throw new Error(
        `Chain head (block ${latestNumber}, timestamp ${latest.timestamp}) has not passed ` +
          `${timestampSeconds}. The epoch boundary is not yet final on chain.`,
      );
    }

    let lo = 0n;
    let hi = latestNumber;
    let answer: bigint | null = null;
    while (lo <= hi) {
      const mid = lo + (hi - lo) / 2n;
      if ((await timestampOf(mid)) <= timestampSeconds) {
        answer = mid;
        lo = mid + 1n;
      } else {
        hi = mid - 1n;
      }
    }

    if (answer === null) {
      throw new Error(
        `No block at or before timestamp ${timestampSeconds}; it precedes the chain's genesis.`,
      );
    }

    const chosen = await timestampOf(answer);
    const following = await timestampOf(answer + 1n);
    if (chosen > timestampSeconds || following <= timestampSeconds) {
      throw new Error(
        `Block resolution for ${timestampSeconds} failed validation: block ${answer} has ` +
          `timestamp ${chosen} and block ${answer + 1n} has ${following}.`,
      );
    }
    return { blockNumber: answer, blockTimestamp: chosen };
  },

  /**
   * Finds the exact block a principal withdrawal landed in.
   *
   * Sound only because ACFStaking.withdraw sets `active = false` once and nothing ever sets it
   * back — verified in the contract, where `active = true` appears nowhere outside construction.
   * That makes the predicate monotonic, so binary search is exact rather than approximate.
   */
  async findWithdrawalBlock(stakeId, afterBlock, atOrBeforeBlock) {
    const stillActive = await activeAt(stakeId, afterBlock);
    if (stillActive !== true) {
      throw new Error(
        `Stake ${stakeId} is not provably active at block ${afterBlock}, so the withdrawal ` +
          "block cannot be bracketed.",
      );
    }
    if ((await activeAt(stakeId, atOrBeforeBlock)) !== false) {
      throw new Error(
        `Stake ${stakeId} does not read inactive at block ${atOrBeforeBlock}; refusing to ` +
          "search for a withdrawal that is not bracketed.",
      );
    }

    let lo = afterBlock + 1n;
    let hi = atOrBeforeBlock;
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      const state = await activeAt(stakeId, mid);
      if (state === null) {
        throw new Error(`Stake ${stakeId} could not be read at block ${mid} during withdrawal search.`);
      }
      if (state === false) hi = mid;
      else lo = mid + 1n;
    }
    return { blockNumber: lo, blockTimestamp: await timestampOf(lo) };
  },
};
