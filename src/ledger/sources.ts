import { EPOCH_SECONDS } from "../rewards/policy.js";
import { Swap } from "../models/Swap.js";
import { BondPurchase } from "../models/BondPurchase.js";
import { Stake } from "../models/Stake.js";
import { StakeRewardEntry } from "../models/StakeRewardEntry.js";
import { TeamRewardEntry } from "../models/TeamRewardEntry.js";
import { RewardClaim } from "../models/RewardClaim.js";
import { DAORevenuePayment } from "../models/DAORevenuePayment.js";
import type { LedgerKind, LedgerRow } from "./types.js";

/**
 * Reading each record the protocol writes as a ledger row.
 *
 * One function per collection, each answering the same question: what moved, which way, in which
 * unit, and what proves it. Keeping them separate means a source's quirks — a Date here, unix
 * seconds there, three reward amounts on one document — stay local to that source.
 */

/** Both shapes appear across the models; everything downstream works in unix seconds. */
const toSeconds = (value: Date | number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? Math.floor(value.getTime() / 1000) : value;
};

/** A reward's cycle END is when it became real, which is the epoch's own boundary. */
const epochBoundary = (epochId: number): number => epochId * EPOCH_SECONDS;

export interface SourceQuery {
  userId: string;
  /** Rows at or before this instant. Undefined for the first page. */
  atOrBefore?: number;
  /** Generous: several rows can share a timestamp and the merge trims the excess. */
  limit: number;
}

type Loader = (query: SourceQuery) => Promise<LedgerRow[]>;

/** Mongo filter for "at or before", omitted entirely on the first page. */
const window = (field: string, atOrBefore: number | undefined, asDate: boolean) =>
  atOrBefore === undefined
    ? {}
    : { [field]: { $lte: asDate ? new Date(atOrBefore * 1000) : atOrBefore } };

const swaps: Loader = async ({ userId, atOrBefore, limit }) => {
  const rows = await Swap.find(
    { userId, ...window("blockTimestamp", atOrBefore, true) },
    { eventId: 1, direction: 1, acfAmount: 1, grossUSDT: 1, sellFeeUSDT: 1, netUSDT: 1,
      blockTimestamp: 1, blockNumber: 1, txHash: 1 },
  ).sort({ blockTimestamp: -1 }).limit(limit).lean();

  return rows.map((r) => {
    const buy = r.direction === "BUY";
    return {
      rowId: `swap:${r.eventId}`,
      occurredAt: toSeconds(r.blockTimestamp as Date)!,
      kind: (buy ? "SWAP_BUY" : "SWAP_SELL") as LedgerKind,
      // A buy brings ACF in; a sell sends ACF out and brings USDT back.
      direction: buy ? ("IN" as const) : ("OUT" as const),
      primary: { amount: String(r.acfAmount), unit: "ACF" as const },
      counter: {
        amount: String(buy ? r.grossUSDT : r.netUSDT),
        unit: "USDT" as const,
      },
      // Only a sell is charged; a buy's grossUSDT is what was paid in full.
      fee: buy ? null : { amount: String(r.sellFeeUSDT), unit: "USDT" as const },
      txHash: r.txHash as string,
      blockNumber: r.blockNumber as number,
      epochId: null,
      detail: { side: r.direction as string },
      breakdown: null,
    };
  });
};

const bonds: Loader = async ({ userId, atOrBefore, limit }) => {
  const rows = await BondPurchase.find(
    { userId, ...window("blockTimestamp", atOrBefore, true) },
    { purchaseId: 1, offerId: 1, poolId: 1, usdtPaid: 1, acfStaked: 1, discountUsed: 1,
      linkedStakeId: 1, blockTimestamp: 1, blockNumber: 1, txHash: 1 },
  ).sort({ blockTimestamp: -1 }).limit(limit).lean();

  return rows.map((r) => ({
    rowId: `bond:${r.purchaseId}`,
    occurredAt: toSeconds(r.blockTimestamp as Date)!,
    kind: "BOND_PURCHASE" as LedgerKind,
    // USDT leaves, and the ACF it buys is staked rather than delivered.
    direction: "OUT" as const,
    primary: { amount: String(r.usdtPaid), unit: "USDT" as const },
    counter: { amount: String(r.acfStaked), unit: "ACF" as const },
    fee: null,
    txHash: r.txHash as string,
    blockNumber: r.blockNumber as number,
    epochId: null,
    detail: {
      offerId: Number(r.offerId),
      poolId: Number(r.poolId),
      discountE6: String(r.discountUsed),
      stakeId: (r.linkedStakeId as string | null) ?? null,
    },
    breakdown: null,
  }));
};

const stakesOpened: Loader = async ({ userId, atOrBefore, limit }) => {
  const rows = await Stake.find(
    { userId, ...window("stakeTimestamp", atOrBefore, true) },
    { stakeId: 1, poolId: 1, principalACF: 1, source: 1, stakeTimestamp: 1, unlockTimestamp: 1,
      blockNumber: 1, txHash: 1, poolDailyROIAtCreation: 1 },
  ).sort({ stakeTimestamp: -1 }).limit(limit).lean();

  return rows.map((r) => ({
    rowId: `stake:${r.stakeId}`,
    occurredAt: toSeconds(r.stakeTimestamp as Date)!,
    kind: "STAKE_OPENED" as LedgerKind,
    // Locked, not spent: the principal is still the member's.
    direction: "MOVE" as const,
    primary: { amount: String(r.principalACF), unit: "ACF" as const },
    counter: null,
    fee: null,
    txHash: r.txHash as string,
    blockNumber: r.blockNumber as number,
    epochId: null,
    detail: {
      stakeId: String(r.stakeId),
      poolId: Number(r.poolId),
      source: r.source as string,
      dailyRateE6: String(r.poolDailyROIAtCreation),
      unlockAt: toSeconds(r.unlockTimestamp as Date),
    },
    breakdown: null,
  }));
};

const stakesClosed: Loader = async ({ userId, atOrBefore, limit }) => {
  const rows = await Stake.find(
    {
      userId,
      withdrawnBlockTimestamp: { $ne: null },
      ...(atOrBefore === undefined
        ? {}
        : { withdrawnBlockTimestamp: { $ne: null, $lte: atOrBefore } }),
    },
    { stakeId: 1, poolId: 1, principalACF: 1, source: 1, withdrawnBlockTimestamp: 1,
      withdrawnBlockNumber: 1, withdrawTxHash: 1 },
  ).sort({ withdrawnBlockTimestamp: -1 }).limit(limit).lean();

  return rows.map((r) => ({
    rowId: `unstake:${r.stakeId}`,
    occurredAt: r.withdrawnBlockTimestamp as number,
    kind: "STAKE_CLOSED" as LedgerKind,
    direction: "MOVE" as const,
    primary: { amount: String(r.principalACF), unit: "ACF" as const },
    counter: null,
    fee: null,
    txHash: (r.withdrawTxHash as string | null) ?? null,
    blockNumber: (r.withdrawnBlockNumber as number | null) ?? null,
    epochId: null,
    detail: { stakeId: String(r.stakeId), poolId: Number(r.poolId), source: r.source as string },
    breakdown: null,
  }));
};

const selfRewards: Loader = async ({ userId, atOrBefore, limit }) => {
  // Grouped in the query, not after it.
  //
  // Self reward is written per stake per cycle, so a member with five stakes produces five
  // entries at one instant. Fetching a flat page and grouping afterwards would split a cycle
  // across a page boundary and show a partial total — a wrong figure that looks exact. Grouping
  // first makes the page a page OF CYCLES, and every cycle it returns is whole.
  const groups = await StakeRewardEntry.aggregate<{
    _id: number;
    snapshotAt: number;
    entries: {
      stakeId: string; rewardACF: string; source: string; poolId: number;
      rateApplied: string; rewardEligible: boolean; ineligibleReason: string | null;
    }[];
  }>([
    {
      $match: {
        userId,
        rewardACF: { $ne: "0" },
        ...(atOrBefore === undefined ? {} : { snapshotAt: { $lte: atOrBefore } }),
      },
    },
    {
      $group: {
        _id: "$epochId",
        snapshotAt: { $first: "$snapshotAt" },
        entries: {
          $push: {
            stakeId: "$stakeId", rewardACF: "$rewardACF", source: "$source", poolId: "$poolId",
            rateApplied: "$rateApplied", rewardEligible: "$rewardEligible",
            ineligibleReason: "$ineligibleReason",
          },
        },
      },
    },
    { $sort: { snapshotAt: -1, _id: -1 } },
    { $limit: limit },
  ]);

  return groups.map((group): LedgerRow => {
    // Summed as bigint. These are 18-decimal base units and a double would lose the dust that
    // makes up most of the parts.
    const total = group.entries.reduce((sum, e) => sum + BigInt(e.rewardACF), 0n);
    const byStake = [...group.entries].sort(
      (a, b) => (BigInt(b.rewardACF) > BigInt(a.rewardACF) ? 1 : -1),
    );

    return {
      rowId: `self:${group._id}`,
      occurredAt: group.snapshotAt,
      kind: "SELF_REWARD",
      direction: "IN",
      primary: { amount: total.toString(), unit: "ACF" },
      counter: null,
      fee: null,
      // Calculated, not transacted. It gains a transaction only when claimed.
      txHash: null,
      blockNumber: null,
      epochId: Number(group._id),
      detail: {
        stakeCount: group.entries.length,
        // Named so a reader can see at a glance that nothing was left out of the total.
        ineligible: group.entries.filter((e) => !e.rewardEligible).length,
      },
      breakdown: byStake.map((e) => ({
        label: `Stake ${e.stakeId} · pool ${e.poolId} · ${e.source}`,
        amount: { amount: e.rewardACF, unit: "ACF" as const },
      })),
    };
  });
};

/** One document carries Level, Rank and Global, so it yields up to three rows. */
const teamRewards = (
  kind: Extract<LedgerKind, "LEVEL_REWARD" | "RANK_REWARD" | "GLOBAL_REWARD">,
  field: "levelRewardACF" | "rankRewardACF" | "globalRewardACF",
  prefix: string,
): Loader => async ({ userId, atOrBefore, limit }) => {
  const maxEpoch =
    atOrBefore === undefined ? undefined : Math.floor(atOrBefore / EPOCH_SECONDS);
  const rows = await TeamRewardEntry.find(
    {
      userId,
      [field]: { $ne: "0" },
      ...(maxEpoch === undefined ? {} : { epochId: { $lte: maxEpoch } }),
    },
    { epochId: 1, [field]: 1, levelAudit: 1, rankAudit: 1, globalAudit: 1 },
  ).sort({ epochId: -1 }).limit(limit).lean();

  return rows.map((r): LedgerRow => {
    const record = r as unknown as Record<string, unknown>;
    const detail: LedgerRow["detail"] =
      kind === "LEVEL_REWARD"
        ? {
            unlockedLevels: Number(
              (record.levelAudit as { unlockedLevels?: number } | undefined)?.unlockedLevels ?? 0,
            ),
          }
        : kind === "RANK_REWARD"
          ? { rank: Number((record.rankAudit as { rank?: number } | undefined)?.rank ?? 0) }
          : {};
    return {
      rowId: `${prefix}:${r.epochId}`,
      // A team reward has no timestamp of its own: it belongs to a cycle, and the cycle's
      // boundary is when it became real.
      occurredAt: epochBoundary(Number(r.epochId)),
      kind,
      direction: "IN" as const,
      primary: { amount: String(record[field]), unit: "ACF" as const },
      counter: null,
      fee: null,
      txHash: null,
      blockNumber: null,
      epochId: Number(r.epochId),
      detail,
      breakdown: null,
    };
  });
};

const claims: Loader = async ({ userId, atOrBefore, limit }) => {
  const rows = await RewardClaim.find(
    { userId, ...window("blockTimestamp", atOrBefore, false) },
    { txHash: 1, logIndex: 1, checkpointId: 1, claimedACF: 1, usdtFee: 1,
      claimFeePercentage: 1, priceE18: 1, blockTimestamp: 1, blockNumber: 1 },
  ).sort({ blockTimestamp: -1 }).limit(limit).lean();

  return rows.map((r) => ({
    rowId: `claim:${r.txHash}:${r.logIndex}`,
    occurredAt: r.blockTimestamp as number,
    kind: "REWARD_CLAIM" as LedgerKind,
    direction: "IN" as const,
    primary: { amount: String(r.claimedACF), unit: "ACF" as const },
    counter: null,
    // The fee is USDT taken from the claimant, not ACF withheld from the claim.
    fee: { amount: String(r.usdtFee), unit: "USDT" as const },
    txHash: r.txHash as string,
    blockNumber: r.blockNumber as number,
    epochId: null,
    detail: {
      checkpointId: Number(r.checkpointId),
      feePercentageE6: String(r.claimFeePercentage),
      priceE18: String(r.priceE18),
    },
    breakdown: null,
  }));
};

const daoRevenue: Loader = async ({ userId, atOrBefore, limit }) => {
  const rows = await DAORevenuePayment.find(
    { userId, ...window("blockTimestamp", atOrBefore, false) },
    { epochId: 1, amountPaidACF: 1, expectedAmountACF: 1, txHash: 1, logIndex: 1,
      blockTimestamp: 1, blockNumber: 1 },
  ).sort({ blockTimestamp: -1 }).limit(limit).lean();

  return rows.map((r) => ({
    rowId: `dao:${r.txHash}:${r.logIndex}`,
    occurredAt: r.blockTimestamp as number,
    kind: "DAO_REVENUE" as LedgerKind,
    direction: "IN" as const,
    primary: { amount: String(r.amountPaidACF), unit: "ACF" as const },
    counter: null,
    fee: null,
    txHash: r.txHash as string,
    blockNumber: r.blockNumber as number,
    epochId: Number(r.epochId),
    detail: { expectedACF: String(r.expectedAmountACF) },
    breakdown: null,
  }));
};

/** Every source, keyed by the kind it produces. */
export const LOADERS: Readonly<Record<LedgerKind, Loader>> = {
  SWAP_BUY: swaps,
  SWAP_SELL: swaps,
  BOND_PURCHASE: bonds,
  STAKE_OPENED: stakesOpened,
  STAKE_CLOSED: stakesClosed,
  SELF_REWARD: selfRewards,
  LEVEL_REWARD: teamRewards("LEVEL_REWARD", "levelRewardACF", "level"),
  RANK_REWARD: teamRewards("RANK_REWARD", "rankRewardACF", "rank"),
  GLOBAL_REWARD: teamRewards("GLOBAL_REWARD", "globalRewardACF", "global"),
  REWARD_CLAIM: claims,
  DAO_REVENUE: daoRevenue,
};

/** Distinct loaders, since BUY and SELL come from one query. */
export const DISTINCT_LOADERS: readonly Loader[] = [
  swaps, bonds, stakesOpened, stakesClosed, selfRewards,
  LOADERS.LEVEL_REWARD, LOADERS.RANK_REWARD, LOADERS.GLOBAL_REWARD,
  claims, daoRevenue,
];
