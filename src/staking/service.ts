import { decodeEventLog, getAddress } from "viem";
import { stakeRewardSummaries, type StakeRewardSummary } from "../rewards/stakeRewards.js";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { chainReader } from "../lib/chain.js";
import { STAKE_SOURCE, stakeCreatedEventAbi } from "../abi/stakingEvent.js";
import { Stake, type StakeDocument } from "../models/Stake.js";
import { User } from "../models/User.js";

/** Only the receipt reads are needed here; declared locally so the swap module is untouched. */
export interface StakingReceiptReader {
  receiptOf(txHash: string): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    logs: readonly { address: string; topics: readonly string[]; data: string; logIndex: number }[];
  } | null>;
  headBlock(): Promise<bigint>;
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
}

export interface StakeResponse {
  stakeId: string;
  poolId: number;
  principalACF: string;
  source: "DIRECT" | "BOND" | "DAO";
  poolDailyROIAtCreation: string;
  stakeTimestamp: string;
  unlockTimestamp: string;
  active: boolean;
  withdrawnAt: string | null;
  txHash: string;
  blockNumber: number;
  /**
   * This stake's own reward, from Phase 1's immutable rows.
   *
   * Per-stake and Self-only: it never contains Team reward, which is user-level, nor DAO Member
   * Revenue, which is a separate direct payment. Null before the reward engine has settled any
   * epoch for this deployment, which is different from a settled zero.
   */
  rewards: StakeRewardSummary | null;
}

const toResponse = (s: StakeDocument, rewards: StakeRewardSummary | null = null): StakeResponse => ({
  stakeId: s.stakeId,
  poolId: s.poolId,
  principalACF: s.principalACF,
  source: s.source as StakeResponse["source"],
  poolDailyROIAtCreation: s.poolDailyROIAtCreation,
  stakeTimestamp: s.stakeTimestamp.toISOString(),
  unlockTimestamp: s.unlockTimestamp.toISOString(),
  active: s.active,
  withdrawnAt: s.withdrawnAt ? s.withdrawnAt.toISOString() : null,
  txHash: s.txHash,
  blockNumber: s.blockNumber,
  rewards,
});

/** A hydrated Stake document. */
type StakeRow = NonNullable<Awaited<ReturnType<typeof Stake.findOne>>>;

export interface DecodedStake {
  eventId: string;
  chainId: number;
  stakingContractAddress: string;
  stakeId: string;
  userId: string;
  externalEOA: string;
  poolId: number;
  principalACF: string;
  source: "DIRECT" | "BOND" | "DAO";
  poolDailyROIAtCreation: string;
  stakeTimestamp: Date;
  unlockTimestamp: Date;
  txHash: string;
  blockNumber: number;
  logIndex: number;
}

/**
 * Idempotently stores a Stake already decoded and verified from a receipt.
 *
 * Shared by direct staking and bond purchase so the mapping exists once. Each caller is
 * responsible for verifying the source itself — this helper deliberately does NOT judge it,
 * and /staking/sync still accepts DIRECT only.
 */
export async function upsertStake(decoded: DecodedStake): Promise<StakeRow> {
  const existing = await Stake.findOne({ eventId: decoded.eventId });
  if (existing) return existing;

  const created = await Stake.findOneAndUpdate(
    { eventId: decoded.eventId },
    { $setOnInsert: { ...decoded, active: true } },
    { upsert: true, new: true },
  );
  return created!;
}


const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Records a DIRECT stake from its transaction hash.
 *
 * The hash is the only input accepted. Principal, pool, stake id, source and owner are all
 * decoded from the receipt the backend fetches itself, and the log's `user` must be this
 * account's own address — a hash for someone else's stake, another contract, or a Bond/DAO
 * position cannot create a row here.
 */
export async function recordStake(
  userId: string,
  rawTxHash: unknown,
  reader: StakingReceiptReader = chainReader,
): Promise<StakeResponse> {
  if (typeof rawTxHash !== "string" || !TX_HASH.test(rawTxHash.trim())) {
    throw new HttpError(400, "INVALID_TX_HASH", "A 32-byte transaction hash is required.");
  }
  const txHash = rawTxHash.trim().toLowerCase();

  const user = await User.findOne({ userId });
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "User no longer exists.");
  // `externalEOA` is required and immutable on every user, so an absent value is a corrupt
  // record rather than a state the caller can resolve by onboarding.
  if (!user.externalEOA) {
    throw new HttpError(500, "INTERNAL_ERROR", "This account has no address on record.");
  }
  const userAddress = user.externalEOA.toLowerCase();

  let receipt;
  let head: bigint;
  try {
    [receipt, head] = await Promise.all([reader.receiptOf(txHash), reader.headBlock()]);
  } catch {
    throw new HttpError(503, "CHAIN_UNAVAILABLE", "Could not reach the network. Try again.");
  }

  if (!receipt) throw new HttpError(404, "TX_NOT_FOUND", "That transaction is not on chain yet.");
  if (receipt.status !== "success") {
    throw new HttpError(409, "TX_REVERTED", "That transaction did not succeed.");
  }

  // A mined transaction counts as one confirmation.
  const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
  if (confirmations < BigInt(config.swapConfirmations)) {
    throw new HttpError(425, "NOT_CONFIRMED", "The transaction needs more confirmations.");
  }

  const stakingAddress = getAddress(config.acfStakingAddress).toLowerCase();

  for (const log of receipt.logs) {
    // 1. Only logs emitted by the canonical staking contract are considered.
    if (log.address !== stakingAddress) continue;

    let decoded;
    try {
      decoded = decodeEventLog({
        abi: stakeCreatedEventAbi,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== "StakeCreated") continue;

    const a = decoded.args as unknown as {
      user: string; stakeId: bigint; poolId: bigint; principal: bigint;
      poolDailyROIAtCreation: bigint; stakeTimestamp: bigint; unlockTimestamp: bigint; source: number;
    };

    // 2. The position must belong to THIS account.
    if (a.user.toLowerCase() !== userAddress) continue;

    // 3. This endpoint is the DIRECT user path only; Bond and DAO ingest separately later.
    const source = STAKE_SOURCE[a.source as 0 | 1 | 2];
    if (source !== "DIRECT") {
      throw new HttpError(
        422,
        "NOT_DIRECT_STAKE",
        "That position was not created by direct staking.",
      );
    }

    const eventId = `${config.chainId}:${txHash}:${log.logIndex}`;
    const existing = await Stake.findOne({ eventId });
    if (existing) return toResponse(existing); // idempotent

    const created = await Stake.findOneAndUpdate(
      { eventId },
      {
        $setOnInsert: {
          eventId,
          chainId: config.chainId,
          stakingContractAddress: stakingAddress,
          stakeId: a.stakeId.toString(),
          userId,
          externalEOA: userAddress,
          poolId: Number(a.poolId),
          principalACF: a.principal.toString(),
          source,
          poolDailyROIAtCreation: a.poolDailyROIAtCreation.toString(),
          stakeTimestamp: new Date(Number(a.stakeTimestamp) * 1000),
          unlockTimestamp: new Date(Number(a.unlockTimestamp) * 1000),
          active: true,
          txHash,
          blockNumber: Number(receipt.blockNumber),
          logIndex: log.logIndex,
        },
      },
      { upsert: true, new: true },
    );
    return toResponse(created!);
  }

  throw new HttpError(
    422,
    "NO_STAKE_FOR_WALLET",
    "That transaction contains no stake belonging to this account.",
  );
}

export interface StakeTotals {
  /** Principal in positions that have not been withdrawn. Matured positions are included. */
  activePrincipalACF: string;
  withdrawnPrincipalACF: string;
  activeCount: number;
  totalCount: number;
  /** Σ per-stake lifetime Self reward. Null until an epoch has settled. */
  lifetimeEarnedStakingRewardACF?: string | null;
  /** Σ per-stake unclaimed Self reward. Null until an epoch has settled. */
  earnedUnclaimedStakingRewardACF?: string | null;
}

export async function listStakes(
  userId: string,
): Promise<{ stakes: StakeResponse[]; totals: StakeTotals }> {
  const rows = await Stake.find({ userId }).sort({ stakeTimestamp: -1 });

  // One bounded call for every stake, rather than a query per card.
  const rewards = await stakeRewardSummaries(userId, rows.map((s) => s.stakeId));

  let active = 0n, withdrawn = 0n, activeCount = 0;
  let lifetimeEarned = 0n, earnedUnclaimed = 0n;
  for (const s of rows) {
    if (s.active) { active += BigInt(s.principalACF); activeCount++; }
    else withdrawn += BigInt(s.principalACF);
    const r = rewards.get(s.stakeId);
    if (r) {
      lifetimeEarned += BigInt(r.lifetimeEarnedACF);
      earnedUnclaimed += BigInt(r.earnedUnclaimedACF);
    }
  }

  // The totals are Self staking reward across this user's stakes only — NOT the account-level
  // reward summary, which also contains Team. Null while no epoch has settled, so the UI shows
  // "unavailable" rather than a zero that would read as "you have earned nothing".
  const settledAny = [...rewards.values()].some((r) => r.settledEpochCount > 0);
  return {
    stakes: rows.map((s) => toResponse(s, rewards.get(s.stakeId) ?? null)),
    totals: {
      activePrincipalACF: active.toString(),
      withdrawnPrincipalACF: withdrawn.toString(),
      activeCount,
      totalCount: rows.length,
      lifetimeEarnedStakingRewardACF: settledAny ? lifetimeEarned.toString() : null,
      earnedUnclaimedStakingRewardACF: settledAny ? earnedUnclaimed.toString() : null,
    },
  };
}
