import { getAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { Stake } from "../models/Stake.js";
import { StakeReconciliationState } from "../models/StakeReconciliationState.js";
import { User } from "../models/User.js";
import { rewardChainReader, type RewardChainReader } from "./chain.js";

const SOURCE = ["DIRECT", "BOND", "DAO"] as const;

/** Why a discovery walk stopped before reaching its target. */
export type DiscoveryStopReason = "UNREADABLE_STAKE" | "UNMAPPED_BENEFICIARY";

export interface DiscoveryResult {
  discovered: number;
  unmapped: string[];
  /**
   * True ONLY when the walk reached targetNextStakeId.
   *
   * Deliberately separate from `unmapped.length === 0`: those are different facts, and
   * conflating them is what let a half-finished walk settle an epoch.
   */
  completed: boolean;
  /** The discovery target captured once at the start of this run. */
  targetNextStakeId: string;
  stoppedAtStakeId: string | null;
  reason: DiscoveryStopReason | null;
}

/**
 * Discovery stopped before covering every stake the contract says exists.
 *
 * ACFStaking allocates ids with `nextStakeId++` from 1, never deletes a position, and reverts
 * any read at or above nextStakeId. So every id below the captured target MUST be readable —
 * a failure is an RPC problem, never a legitimate absence. Settling an epoch anyway would pay
 * nothing to every stake past the failure and, because a CALCULATED epoch never re-runs, the
 * underpayment would be permanent and silent.
 */
export class DiscoveryIncompleteError extends Error {
  readonly code = "DISCOVERY_INCOMPLETE";
  constructor(result: DiscoveryResult) {
    super(
      `Stake discovery stopped at ${result.stoppedAtStakeId} of target ` +
        `${result.targetNextStakeId} (${result.reason}). Refusing to settle an epoch that would ` +
        "omit every stake from there on.",
    );
    this.name = "DiscoveryIncompleteError";
  }
}

/** A stake exists on chain but its beneficiary wallet maps to no application user. */
export class UnmappedStakeError extends Error {
  readonly code = "UNMAPPED_STAKE";
  readonly stakeIds: string[];
  constructor(stakeIds: string[]) {
    super(
      `${stakeIds.length} on-chain stake(s) have no application user for their beneficiary ` +
        `wallet: ${stakeIds.slice(0, 10).join(", ")}. Refusing to settle an epoch that would ` +
        "silently omit their reward liability.",
    );
    this.name = "UnmappedStakeError";
    this.stakeIds = stakeIds;
  }
}

const key = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
});

/**
 * Discovers stakes the browser never synced.
 *
 * Walks the contract's own sequential ids from a persisted high-water mark, so reward
 * correctness never depends on anyone having visited /staking/sync, /bond/sync or /dao/sync.
 * Complete by construction: it reads contract storage, not events.
 */
export async function discoverStakes(
  reader: RewardChainReader = rewardChainReader,
): Promise<DiscoveryResult> {
  const k = key();
  const state =
    (await StakeReconciliationState.findOne(k)) ??
    (await StakeReconciliationState.findOneAndUpdate(
      k, { $setOnInsert: { ...k, nextStakeIdProcessed: "1" } }, { upsert: true, new: true },
    ))!;

  // Captured ONCE. A stake created while the walk runs falls outside this target and is left
  // for the next pass, which is financially safe: discovery only runs after the chain head has
  // passed snapshotAt, so any such stake has stakeTimestamp > snapshotAt and cannot be
  // reward-eligible for this epoch.
  const nextId = await reader.nextStakeId();
  let cursor = BigInt(state.nextStakeIdProcessed);
  if (cursor < 1n) cursor = 1n;

  let discovered = 0;
  const unmapped: string[] = [];

  while (cursor < nextId) {
    const batch: bigint[] = [];
    for (let i = 0; i < config.rewardMulticallBatchSize && cursor + BigInt(i) < nextId; i++) {
      batch.push(cursor + BigInt(i));
    }
    const stakes = await reader.getStakes(batch);

    for (const [index, chain] of stakes.entries()) {
      const id = batch[index]!;
      // An unreadable id stops the walk WITHOUT advancing past it: skipping would lose that
      // stake permanently, since the cursor never goes back. Every id below the target is
      // guaranteed readable by the contract, so this is a transient fault, not an absence.
      if (!chain) return finish(k, id, discovered, unmapped, nextId, id, "UNREADABLE_STAKE");

      const owner = await User.findOne({ externalEOA: chain.user });
      if (!owner) {
        // Stop WITHOUT advancing past this id. Recording it and walking on would move the
        // high-water mark beyond a stake that was never persisted, so once the user existed
        // the stake would never be discovered again and its reward would be lost silently.
        unmapped.push(id.toString());
        return finish(k, id, discovered, unmapped, nextId, id, "UNMAPPED_BENEFICIARY");
      }
      const existing = await Stake.findOne({ ...k, stakeId: id.toString() });
      if (!existing) {
        await Stake.create({
          eventId: `${config.chainId}:reconciled:${k.stakingContractAddress}:${id}`,
          ...k,
          stakeId: id.toString(),
          userId: owner.userId,
          externalEOA: chain.user,
          poolId: Number(chain.poolId),
          principalACF: chain.principal.toString(),
          source: SOURCE[chain.source],
          // Not emitted by the getter; a later /staking/sync fills in the real value.
          poolDailyROIAtCreation: "0",
          stakeTimestamp: new Date(Number(chain.stakeTimestamp) * 1000),
          unlockTimestamp: new Date(Number(chain.unlockTimestamp) * 1000),
          active: chain.active,
          txHash: `0x${"0".repeat(64)}`,
          blockNumber: 0,
          logIndex: -1,
        }).catch((cause: { code?: number }) => {
          if (cause?.code !== 11000) throw cause;   // a concurrent writer won; fine
        });
        discovered += 1;
      }
    }
    cursor += BigInt(batch.length);
  }

  return finish(k, cursor, discovered, unmapped, nextId, null, null);
}

async function finish(
  k: ReturnType<typeof key>,
  cursor: bigint,
  discovered: number,
  unmapped: string[],
  targetNextStakeId: bigint,
  stoppedAtStakeId: bigint | null,
  reason: DiscoveryStopReason | null,
): Promise<DiscoveryResult> {
  await StakeReconciliationState.updateOne(k, {
    $set: {
      nextStakeIdProcessed: cursor.toString(),
      lastReconciledAt: new Date(),
      lastDiscoveredCount: discovered,
    },
  });
  return {
    discovered,
    unmapped,
    completed: stoppedAtStakeId === null,
    targetNextStakeId: targetNextStakeId.toString(),
    stoppedAtStakeId: stoppedAtStakeId === null ? null : stoppedAtStakeId.toString(),
    reason,
  };
}

/**
 * Recovers the block a stake's principal was actually withdrawn in, and stores it immutably.
 *
 * This is AUDIT AND PHASE-2 data, not a Phase 1 reward input: Phase 1 decides eligibility from
 * a read pinned to the epoch's snapshot block, which is authoritative on its own. So a recovery
 * failure is logged loudly and retried next run rather than failing the epoch — withholding
 * everyone's rewards over a missing audit breadcrumb would be the worse trade.
 *
 * Phase 2 will depend on this field and must fail loudly when it is null.
 */
async function recoverWithdrawalBlock(
  k: ReturnType<typeof key>,
  stakeId: string,
  reader: RewardChainReader,
): Promise<boolean> {
  const row = await Stake.findOne({ ...k, stakeId });
  if (!row) return false;
  if (row.withdrawnBlockNumber !== null && row.withdrawnBlockNumber !== undefined) return true;

  try {
    // Lower bracket: the stake was provably active when it was created. Derived from chain
    // time, never from withdrawnAt, which is only a detection breadcrumb.
    const created = await reader.blockAtOrBefore(Math.floor(row.stakeTimestamp.getTime() / 1000));
    const head = await reader.blockAtOrBefore(Math.floor(Date.now() / 1000) - 1);
    const found = await reader.findWithdrawalBlock(BigInt(stakeId), created.blockNumber, head.blockNumber);

    await Stake.updateOne({ ...k, stakeId }, {
      $set: {
        withdrawnBlockNumber: Number(found.blockNumber),
        withdrawnBlockTimestamp: found.blockTimestamp,
      },
    });
    logger.info("recovered on-chain withdrawal block", {
      stakeId, blockNumber: Number(found.blockNumber), blockTimestamp: found.blockTimestamp,
    });
    return true;
  } catch (cause) {
    logger.error("could not recover on-chain withdrawal block; will retry next run", {
      stakeId, error: (cause as Error).message,
    });
    return false;
  }
}

/**
 * Fills in withdrawal metadata for stakes retired before this recovery path existed.
 *
 * Bounded per run so a large historical backlog cannot stall an epoch; whatever is left is
 * picked up next time. Idempotent — a row with the metadata already set is skipped.
 */
export async function backfillWithdrawalBlocks(
  reader: RewardChainReader = rewardChainReader,
  limit: number = config.rewardStakePageSize,
): Promise<{ attempted: number; recovered: number }> {
  const k = key();
  const pending = await Stake.find({
    ...k, active: false,
    $or: [{ withdrawnBlockNumber: null }, { withdrawnBlockNumber: { $exists: false } }],
  }).sort({ stakeId: 1 }).limit(limit);

  let recovered = 0;
  for (const row of pending) {
    if (await recoverWithdrawalBlock(k, row.stakeId, reader)) recovered += 1;
  }
  return { attempted: pending.length, recovered };
}

/**
 * Re-reads CURRENT chain state for every stake still believed active, and retires the withdrawn.
 *
 * This maintains `Stake.active` as the latest known state, for the UI and operations. It is
 * deliberately NOT the financial truth for a historical epoch: reward eligibility comes from a
 * read pinned to that epoch's snapshot block (see epoch.ts), because a withdrawal after the
 * boundary must not invalidate a window the position was active throughout.
 *
 * Withdrawal is terminal in ACFStaking — `active = false` appears once, in withdraw(), with no
 * inverse — so a stake proven inactive is never re-read again.
 */
export async function reconcileActiveStakes(
  reader: RewardChainReader = rewardChainReader,
): Promise<{ checked: number; retired: number }> {
  const k = key();
  let checked = 0;
  let retired = 0;
  // Keyset pagination, not skip/limit. This loop sets active=false as it goes, so rows leave
  // the filter mid-scan and any offset computed from page sizes drifts. Paging on the last
  // stakeId seen is immune to that: it never re-reads a stake and never skips one.
  let lastStakeId = "";

  for (;;) {
    const page = await Stake.find({
      ...k,
      active: true,
      ...(lastStakeId ? { stakeId: { $gt: lastStakeId } } : {}),
    })
      .sort({ stakeId: 1 })
      .limit(config.rewardStakePageSize);
    if (page.length === 0) break;
    lastStakeId = page.at(-1)!.stakeId;

    for (let i = 0; i < page.length; i += config.rewardMulticallBatchSize) {
      const slice = page.slice(i, i + config.rewardMulticallBatchSize);
      const chain = await reader.getStakes(slice.map((s) => BigInt(s.stakeId)));

      const nowInactive: string[] = [];
      for (const [index, c] of chain.entries()) {
        checked += 1;
        // An unreadable stake is NOT assumed withdrawn; the epoch fails instead.
        if (!c) {
          throw new Error(
            `Stake ${slice[index]!.stakeId} could not be read from chain. Refusing to settle an ` +
              "epoch on unverified stake state.",
          );
        }
        if (!c.active) nowInactive.push(slice[index]!.stakeId);
      }

      if (nowInactive.length > 0) {
        await Stake.updateMany(
          { ...k, stakeId: { $in: nowInactive } },
          { $set: { active: false, withdrawnAt: new Date() } },
        );
        retired += nowInactive.length;
        // withdrawnAt above is only when we NOTICED. Recover when it actually happened.
        for (const stakeId of nowInactive) {
          await recoverWithdrawalBlock(k, stakeId, reader);
        }
      }
    }

    if (page.length < config.rewardStakePageSize) break;
  }

  return { checked, retired };
}
