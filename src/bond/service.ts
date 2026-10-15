import { decodeEventLog, getAddress } from "viem";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { chainReader } from "../lib/chain.js";
import { bondPurchasedEventAbi } from "../abi/bondEvent.js";
import { STAKE_SOURCE, stakeCreatedEventAbi } from "../abi/stakingEvent.js";
import { upsertStake } from "../staking/service.js";
import { stakeRewardSummaries, type StakeRewardSummary } from "../rewards/stakeRewards.js";
import { BondPurchase, type BondPurchaseDocument } from "../models/BondPurchase.js";
import { Stake } from "../models/Stake.js";
import { User } from "../models/User.js";

/** Only the receipt reads are needed; declared locally so other modules stay untouched. */
export interface BondReceiptReader {
  receiptOf(txHash: string): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    logs: readonly { address: string; topics: readonly string[]; data: string; logIndex: number }[];
  } | null>;
  headBlock(): Promise<bigint>;
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
}

export interface BondPurchaseResponse {
  purchaseId: string;
  offerId: string;
  poolId: number;
  usdtPaid: string;
  discountUsed: string;
  executionPriceE18: string;
  acfStaked: string;
  linkedStakeId: string;
  txHash: string;
  blockNumber: number;
  blockTimestamp: string;
  /**
   * Linked position state, so the UI need not join client-side.
   *
   * `rewards` is that stake's own Self reward, the same summary the staking read model carries.
   * A bond's ACF is staked in full at purchase, so the linked position earns exactly like a
   * direct one — the figures were simply never joined here. Null before any epoch has settled,
   * which is different from a settled zero.
   */
  stake:
    | {
        active: boolean;
        unlockTimestamp: string;
        stakeTimestamp: string;
        rewards: StakeRewardSummary | null;
      }
    | null;
}

interface BondArgs {
  purchaseId: bigint; beneficiary: string; offerId: bigint; poolId: bigint; stakeId: bigint;
  usdtPaid: bigint; discountUsed: bigint; executionPriceE18: bigint; acfStaked: bigint;
}

interface StakeArgs {
  user: string; stakeId: bigint; poolId: bigint; principal: bigint;
  poolDailyROIAtCreation: bigint; stakeTimestamp: bigint; unlockTimestamp: bigint; source: number;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

async function toResponse(
  b: BondPurchaseDocument,
  rewards: StakeRewardSummary | null = null,
): Promise<BondPurchaseResponse> {
  const stake = await Stake.findOne({
    chainId: b.chainId,
    stakingContractAddress: b.stakingContractAddress,
    stakeId: b.linkedStakeId,
  });
  return {
    purchaseId: b.purchaseId,
    offerId: b.offerId,
    poolId: b.poolId,
    usdtPaid: b.usdtPaid,
    discountUsed: b.discountUsed,
    executionPriceE18: b.executionPriceE18,
    acfStaked: b.acfStaked,
    linkedStakeId: b.linkedStakeId,
    txHash: b.txHash,
    blockNumber: b.blockNumber,
    blockTimestamp: b.blockTimestamp.toISOString(),
    stake: stake
      ? {
          active: stake.active,
          unlockTimestamp: stake.unlockTimestamp.toISOString(),
          stakeTimestamp: stake.stakeTimestamp.toISOString(),
          rewards,
        }
      : null,
  };
}

/**
 * Records a Bond purchase and its linked BOND stake from one transaction hash.
 *
 * The hash is the only input. Every financial value is decoded from the receipt, and the two
 * events must agree with each other: a transaction containing an unrelated BondPurchased and
 * an unrelated StakeCreated cannot be stitched into a false position.
 */
export async function recordBondPurchase(
  userId: string,
  rawTxHash: unknown,
  reader: BondReceiptReader = chainReader,
): Promise<BondPurchaseResponse> {
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

  const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
  if (confirmations < BigInt(config.swapConfirmations)) {
    throw new HttpError(425, "NOT_CONFIRMED", "The transaction needs more confirmations.");
  }

  const bondAddress = getAddress(config.acfBondAddress).toLowerCase();
  const stakingAddress = getAddress(config.acfStakingAddress).toLowerCase();

  // ── the BondPurchased belonging to this user, from the canonical Bond contract ──
  let bond: BondArgs | null = null;
  let bondLogIndex = -1;

  for (const log of receipt.logs) {
    if (log.address !== bondAddress) continue;
    try {
      const decoded = decodeEventLog({
        abi: bondPurchasedEventAbi,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName !== "BondPurchased") continue;
      const a = decoded.args as unknown as BondArgs;
      if (a.beneficiary.toLowerCase() !== userAddress) continue;
      bond = a;
      bondLogIndex = log.logIndex;
      break;
    } catch {
      continue;
    }
  }

  if (!bond) {
    throw new HttpError(
      422,
      "NO_BOND_FOR_WALLET",
      "That transaction contains no bond purchase belonging to this account.",
    );
  }

  // ── the StakeCreated it refers to, from the canonical Staking contract ──
  let stakeLog: { logIndex: number; args: StakeArgs } | null = null;

  for (const log of receipt.logs) {
    if (log.address !== stakingAddress) continue;
    try {
      const decoded = decodeEventLog({
        abi: stakeCreatedEventAbi,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName !== "StakeCreated") continue;
      const a = decoded.args as unknown as StakeArgs;
      // Must be the exact position this purchase created.
      if (a.stakeId !== bond.stakeId) continue;
      stakeLog = { logIndex: log.logIndex, args: a };
      break;
    } catch {
      continue;
    }
  }

  if (!stakeLog) {
    throw new HttpError(422, "NO_LINKED_STAKE", "The bond's staking position could not be found.");
  }

  const s = stakeLog.args;
  const source = STAKE_SOURCE[s.source as 0 | 1 | 2];

  // Cross-event consistency: both must describe the same position for the same user.
  if (source !== "BOND") {
    throw new HttpError(422, "NOT_BOND_STAKE", "The linked position was not created by a bond.");
  }
  if (s.user.toLowerCase() !== userAddress) {
    throw new HttpError(422, "STAKE_BENEFICIARY_MISMATCH", "The linked position belongs to another account.");
  }
  if (s.poolId !== bond.poolId) {
    throw new HttpError(422, "POOL_MISMATCH", "Bond and staking events disagree on the pool.");
  }
  if (s.principal !== bond.acfStaked) {
    throw new HttpError(422, "PRINCIPAL_MISMATCH", "Bond and staking events disagree on the amount.");
  }

  const timestamp = await reader.blockTimestamp(receipt.blockNumber);
  const blockTimestamp = new Date(Number(timestamp) * 1000);

  // ── idempotent dual persistence (NOT a Mongo transaction) ──
  // Stake first: a BondPurchase pointing at a missing Stake is a dangling reference, whereas
  // a BOND Stake without its purchase row is merely incomplete and repaired by retrying.
  await upsertStake({
    eventId: `${config.chainId}:${txHash}:${stakeLog.logIndex}`,
    chainId: config.chainId,
    stakingContractAddress: stakingAddress,
    stakeId: s.stakeId.toString(),
    userId,
    externalEOA: userAddress,
    poolId: Number(s.poolId),
    principalACF: s.principal.toString(),
    source: "BOND",
    poolDailyROIAtCreation: s.poolDailyROIAtCreation.toString(),
    stakeTimestamp: new Date(Number(s.stakeTimestamp) * 1000),
    unlockTimestamp: new Date(Number(s.unlockTimestamp) * 1000),
    txHash,
    blockNumber: Number(receipt.blockNumber),
    logIndex: stakeLog.logIndex,
  });

  const eventId = `${config.chainId}:${txHash}:${bondLogIndex}`;
  const existing = await BondPurchase.findOne({ eventId });
  if (existing) return toResponse(existing, await rewardFor(userId, existing.linkedStakeId));

  const created = await BondPurchase.findOneAndUpdate(
    { eventId },
    {
      $setOnInsert: {
        eventId,
        chainId: config.chainId,
        bondContractAddress: bondAddress,
        purchaseId: bond.purchaseId.toString(),
        userId,
        externalEOA: userAddress,
        offerId: bond.offerId.toString(),
        poolId: Number(bond.poolId),
        usdtPaid: bond.usdtPaid.toString(),
        discountUsed: bond.discountUsed.toString(),
        executionPriceE18: bond.executionPriceE18.toString(),
        acfStaked: bond.acfStaked.toString(),
        stakingContractAddress: stakingAddress,
        linkedStakeId: bond.stakeId.toString(),
        txHash,
        blockNumber: Number(receipt.blockNumber),
        logIndex: bondLogIndex,
        blockTimestamp,
      },
    },
    { upsert: true, new: true },
  );

  return toResponse(created!, await rewardFor(userId, created!.linkedStakeId));
}

export interface BondTotals {
  /** A legitimate zero when there are no purchases — distinct from an unavailable reward. */
  totalUsdtPaid: string;
  totalAcfStaked: string;
  purchaseCount: number;
}

/** One linked stake's reward summary. The list path batches instead; this is for single reads. */
async function rewardFor(userId: string, stakeId: string): Promise<StakeRewardSummary | null> {
  return (await stakeRewardSummaries(userId, [stakeId])).get(stakeId) ?? null;
}

export async function listBondPurchases(
  userId: string,
): Promise<{ purchases: BondPurchaseResponse[]; totals: BondTotals }> {
  const rows = await BondPurchase.find({ userId }).sort({ blockTimestamp: -1 });

  let usdt = 0n;
  let acf = 0n;
  for (const r of rows) {
    usdt += BigInt(r.usdtPaid);
    acf += BigInt(r.acfStaked);
  }

  // One bounded call for every linked stake, rather than a query per bond.
  const rewards = await stakeRewardSummaries(userId, rows.map((r) => r.linkedStakeId));

  // Totals stay principal-only here. A bond's reward is Self staking reward on the linked
  // position, already summed by the staking read model; adding it again under a bond total
  // would double-count the same ACF in any view that shows both.
  return {
    purchases: await Promise.all(
      rows.map((r) => toResponse(r, rewards.get(r.linkedStakeId) ?? null)),
    ),
    totals: { totalUsdtPaid: usdt.toString(), totalAcfStaked: acf.toString(), purchaseCount: rows.length },
  };
}
