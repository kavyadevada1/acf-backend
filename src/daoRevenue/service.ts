import { getAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { RewardEpoch } from "../models/RewardEpoch.js";
import { DAORevenueEpoch } from "../models/DAORevenueEpoch.js";
import { DAOConfigHistory } from "../models/DAOConfigHistory.js";
import { lastScannedBlock, syncDAOConfigHistory } from "./configHistory.js";
import { runDAORevenueEpoch, type DAORevenueEpochResult } from "./calculation.js";
import { daoRevenueChainReader, type DAORevenueChainReader } from "./chain.js";

/**
 * DAO revenue catch-up: every Phase 1 epoch that has settled but has no DAO revenue decision.
 *
 * Oldest first, stopping at the first failure. Stopping matters because DAO revenue epochs are
 * financially independent but operationally sequential — only one may be executed at a time, so
 * racing ahead past a failure would queue obligations that cannot be paid in order.
 */

const key = () => ({
  chainId: config.chainId,
  daoContractAddress: getAddress(config.acfDaoAddress).toLowerCase(),
  distributorAddress: getAddress(config.daoRevenueDistributorAddress).toLowerCase(),
});

const stakingKey = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
});

/** Statuses meaning the epoch needs no further calculation. */
const DECIDED = [
  "CALCULATED", "AUTHORIZED", "FUNDING_SUBMITTED", "FUNDED", "DISTRIBUTING",
  "COMPLETED", "NOTHING_TO_DISTRIBUTE",
];

export async function catchUpDAORevenueEpochs(
  reader: DAORevenueChainReader = daoRevenueChainReader,
): Promise<{ processed: DAORevenueEpochResult[]; stoppedAt: number | null }> {
  const k = key();

  const settled = await RewardEpoch.find(
    { ...stakingKey(), status: { $in: ["CALCULATED", "FINALIZED"] } },
    { epochId: 1 },
  ).sort({ epochId: 1 }).lean();
  if (settled.length === 0) return { processed: [], stoppedAt: null };

  const candidates = settled.map((e) => e.epochId);
  const decided = await DAORevenueEpoch.find(
    { ...k, epochId: { $in: candidates }, status: { $in: DECIDED } },
    { epochId: 1 },
  ).lean();
  const done = new Set(decided.map((e) => e.epochId));

  const processed: DAORevenueEpochResult[] = [];
  for (const epochId of candidates) {
    if (done.has(epochId)) continue;
    try {
      processed.push(await runDAORevenueEpoch(epochId, reader));
    } catch (cause) {
      // Deliberately NOT an upsert: a placeholder row would carry no financial fields, and
      // Mongoose strips immutable fields from a later $set, so it would permanently block the
      // epoch from ever being calculated. The failure is logged instead.
      await DAORevenueEpoch.updateOne(
        { ...k, epochId },
        {
          $set: {
            status: "FAILED",
            lastError: (cause as Error).message.slice(0, 1000),
            leaseExpiresAt: null,
          },
        },
      ).catch(() => {});
      logger.error("dao revenue epoch failed", {
        epochId, error: (cause as Error).message,
      });
      return { processed, stoppedAt: epochId };
    }
  }
  return { processed, stoppedAt: null };
}

/**
 * Keeps DAO configuration history current, so an as-of lookup never falls short.
 *
 * Resumes from the highest indexed block rather than rescanning: with a 10-block log window a
 * full rescan would cost one request per 10 blocks of chain history. On an empty collection it
 * refuses to guess a start block — the deployment block is an operator input, because starting
 * late would leave a hole that silently prices an epoch against the wrong threshold.
 */
export async function syncDAOConfig(fromBlockWhenEmpty?: number): Promise<void> {
  const k = key();
  // Resumes from the last block SCANNED, not the last block that happened to contain an event.
  // Configuration changes are rare, so resuming from the newest event row would re-read the
  // whole history on every tick.
  const scanned = await lastScannedBlock();

  if (scanned === null) {
    const anyRow = await DAOConfigHistory.findOne(
      { chainId: k.chainId, daoContractAddress: k.daoContractAddress },
    ).sort({ blockNumber: -1 }).lean();
    if (anyRow) {
      // History exists from a backfill that predates the cursor; continue from its last event.
      await syncDAOConfigHistory({ fromBlock: anyRow.blockNumber + 1 });
      return;
    }
    if (fromBlockWhenEmpty === undefined) {
      logger.warn("dao config history is empty; run dao-revenue:backfill-config --from=<block>");
      return;
    }
    await syncDAOConfigHistory({ fromBlock: fromBlockWhenEmpty });
    return;
  }
  await syncDAOConfigHistory({ fromBlock: scanned + 1 });
}
