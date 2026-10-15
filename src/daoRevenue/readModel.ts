import { getAddress } from "viem";
import { config } from "../config.js";
import { DAOContribution } from "../models/DAOContribution.js";
import { DAORevenueEpoch } from "../models/DAORevenueEpoch.js";
import { DAORevenueMemberEntry } from "../models/DAORevenueMemberEntry.js";
import { DAORevenuePayment } from "../models/DAORevenuePayment.js";

/**
 * The authenticated user's DAO Member Revenue — summary and history.
 *
 * DAO Member Revenue is Phase 4's 5% share of system revenue, paid DIRECTLY in ACF to the
 * member's own wallet. It is not Self, not Team, not part of the Withdrawal Merkle claim, not
 * subject to the claim fee, and it does not compound. The UI must keep it separate, so this is
 * a separate read model rather than a field on the reward summary.
 *
 * ONLY calculated obligations and reconciled payments count. A plain ACF transfer into the
 * wallet is not DAO revenue, so nothing here is derived from a balance or a generic ERC-20
 * movement: an amount appears as received only when a DAORevenuePaid event was reconciled
 * against the member's immutable obligation.
 */

const key = () => ({
  chainId: config.chainId,
  distributorAddress: getAddress(config.daoRevenueDistributorAddress).toLowerCase(),
});

const daoKey = () => ({
  chainId: config.chainId,
  daoContractAddress: getAddress(config.acfDaoAddress).toLowerCase(),
});

/** What the user sees, rather than the executor's internal state machine. */
export type DistributionStatus = "PENDING_PAYOUT" | "PAID";

export interface DAORevenueHistoryRow {
  epochId: number;
  snapshotAt: number | null;
  /** The epoch's whole-system figures, for context on how the share was derived. */
  systemRevenueUSD6: string | null;
  daoRevenuePoolUSD6: string | null;
  /** The member's own recorded active contribution that produced the weight. */
  activeContributionUSDT6: string;
  memberRevenueUSD6: string;
  memberRevenueACF: string;
  status: DistributionStatus;
  /** Present only when a DAORevenuePaid event was reconciled. */
  txHash: string | null;
  blockNumber: number | null;
  paidAt: string | null;
  amountPaidACF: string | null;
}

export interface DAORevenueSummary {
  /** Σ recorded USDT of the member's contributions active at the most recent decided epoch. */
  activeContributionUSDT6: string;
  totalCalculatedRevenueACF: string;
  totalPaidRevenueACF: string;
  /** Calculated but with no reconciled payment yet. Never includes undecided epochs. */
  pendingRevenueACF: string;
  distributionsCount: number;
  paidCount: number;
  latestDistribution: DAORevenueHistoryRow | null;
}

export interface DAORevenueHistoryPage {
  rows: DAORevenueHistoryRow[];
  /** Pass back as `before` to continue. Null when the last page was reached. */
  nextCursor: number | null;
}

/** Joins obligations to payments and epoch context in a bounded number of queries. */
async function buildRows(
  userId: string,
  entries: Array<Record<string, unknown>>,
): Promise<DAORevenueHistoryRow[]> {
  if (entries.length === 0) return [];
  const k = key();
  const epochIds = entries.map((e) => e.epochId as number);

  const [payments, epochs] = await Promise.all([
    DAORevenuePayment.find({ ...k, userId, epochId: { $in: epochIds } }).lean(),
    DAORevenueEpoch.find(
      { chainId: k.chainId, distributorAddress: k.distributorAddress, epochId: { $in: epochIds } },
      { epochId: 1, snapshotAt: 1, systemRevenueUSD6: 1, daoRevenuePoolUSD6: 1 },
    ).lean(),
  ]);
  const paymentByEpoch = new Map(payments.map((p) => [p.epochId, p]));
  const epochByEpoch = new Map(epochs.map((e) => [e.epochId, e]));

  return entries.map((entry) => {
    const epochId = entry.epochId as number;
    const paid = paymentByEpoch.get(epochId);
    const epoch = epochByEpoch.get(epochId);
    return {
      epochId,
      snapshotAt: epoch?.snapshotAt ?? null,
      systemRevenueUSD6: epoch?.systemRevenueUSD6 ?? null,
      daoRevenuePoolUSD6: epoch?.daoRevenuePoolUSD6 ?? null,
      activeContributionUSDT6: String(entry.activeContributionUSDT6),
      memberRevenueUSD6: String(entry.memberRevenueUSD6),
      memberRevenueACF: String(entry.memberRevenueACF),
      // PAID only with a reconciled event. A calculated obligation is never shown as received.
      status: paid ? "PAID" : "PENDING_PAYOUT",
      txHash: paid?.txHash ?? null,
      blockNumber: paid?.blockNumber ?? null,
      paidAt: paid ? new Date(paid.blockTimestamp * 1000).toISOString() : null,
      amountPaidACF: paid?.amountPaidACF ?? null,
    };
  });
}

export async function getDAORevenueSummary(userId: string): Promise<DAORevenueSummary> {
  const k = key();
  const entries = await DAORevenueMemberEntry.find({ ...k, userId })
    .sort({ epochId: -1 }).lean();

  const rows = await buildRows(userId, entries as unknown as Array<Record<string, unknown>>);

  let calculated = 0n;
  let paidTotal = 0n;
  let paidCount = 0;
  for (const r of rows) {
    calculated += BigInt(r.memberRevenueACF);
    if (r.status === "PAID") {
      paidTotal += BigInt(r.amountPaidACF ?? r.memberRevenueACF);
      paidCount += 1;
    }
  }

  // The member's current weight, from their own contributions rather than any epoch's snapshot:
  // `lastKnownActive` is a cached chain read, so this is indicative for display only — the
  // weight that was PAID is on each history row, where it is immutable.
  const contributions = await DAOContribution.find(
    { ...daoKey(), userId, lastKnownActive: true }, { usdtContributed: 1 },
  ).lean();
  const activeContribution = contributions.reduce((s, c) => s + BigInt(c.usdtContributed), 0n);

  return {
    activeContributionUSDT6: activeContribution.toString(),
    totalCalculatedRevenueACF: calculated.toString(),
    totalPaidRevenueACF: paidTotal.toString(),
    pendingRevenueACF: (calculated - paidTotal).toString(),
    distributionsCount: rows.length,
    paidCount,
    latestDistribution: rows[0] ?? null,
  };
}

export async function getDAORevenueHistory(
  userId: string,
  options: { limit?: number; before?: number } = {},
): Promise<DAORevenueHistoryPage> {
  const k = key();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

  // Keyset pagination on epochId, newest first. Bounded, so no unbounded history scan.
  const filter: Record<string, unknown> = { ...k, userId };
  if (options.before !== undefined) filter.epochId = { $lt: options.before };

  const entries = await DAORevenueMemberEntry.find(filter)
    .sort({ epochId: -1 }).limit(limit + 1).lean();

  const hasMore = entries.length > limit;
  const page = hasMore ? entries.slice(0, limit) : entries;
  const rows = await buildRows(userId, page as unknown as Array<Record<string, unknown>>);

  return { rows, nextCursor: hasMore ? rows.at(-1)!.epochId : null };
}
