import { getAddress, parseEventLogs, type Log } from "viem";
import { config } from "../config.js";
import { publicClient } from "../lib/chain.js";
import { logger } from "../lib/logger.js";
import { DAOConfigHistory } from "../models/DAOConfigHistory.js";
import { DAOConfigSyncState } from "../models/DAOConfigSyncState.js";
import { DAORevenueInvariantError } from "./policy.js";
import {
  marketingFeeCollectorUpdatedEventAbi, revenueConfigUpdatedEventAbi,
  revenueEnabledUpdatedEventAbi,
} from "./chain.js";

/**
 * ACFDAO revenue configuration history, and as-of resolution against it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The contract exposes only `getRevenueConfig()` and `revenueEnabled()`, both CURRENT. Settling
 * reward epoch 41010 against a Silver threshold that was raised last week would pay the wrong
 * members, and raising the 5% rate tomorrow must not retroactively repay yesterday. Both values
 * change through events whose payloads are in event DATA, and `initialize()` emits both, so the
 * complete history is recoverable from the contract's first block with no gap.
 *
 * Each stored row is a FULL snapshot rather than a delta: a RevenueEnabledUpdated row repeats
 * the thresholds in force at that block. As-of resolution is then a single descending lookup
 * instead of a replay, and a missing early row can never be papered over by a later partial one.
 */

export class DAOConfigUnavailableError extends Error {
  readonly code = "DAO_CONFIG_UNAVAILABLE";
  constructor(blockNumber: number) {
    super(
      `No DAO revenue configuration is known at or before block ${blockNumber}. ` +
        "Run the config backfill; refusing to use current configuration for a past epoch.",
    );
    this.name = "DAOConfigUnavailableError";
  }
}

export interface ResolvedDAOConfig {
  silverMinimumUSDT6: bigint;
  goldMinimumUSDT6: bigint;
  memberRevenueRateE6: bigint;
  marketingRateE6: bigint;
  /** The recipient in force at the snapshot. Zero means none was known; callers must refuse. */
  marketingCollector: string;
  revenueEnabled: boolean;
  blockNumber: number;
  logIndex: number;
}

const key = () => ({
  chainId: config.chainId,
  daoContractAddress: getAddress(config.acfDaoAddress).toLowerCase(),
});

/// "No collector was known at this block yet", never a payable recipient.
const ZERO_COLLECTOR = `0x${"0".repeat(40)}`;

/**
 * The configuration in force at `blockNumber`.
 *
 * Strictly at-or-before: a change mined after the snapshot block is invisible, which is the
 * whole point. Absence FAILS rather than falling back to the live contract.
 */
export async function resolveConfigAsOf(blockNumber: number): Promise<ResolvedDAOConfig> {
  const row = await DAOConfigHistory.findOne(
    { ...key(), blockNumber: { $lte: blockNumber } },
  ).sort({ blockNumber: -1, logIndex: -1 }).lean();

  if (!row) throw new DAOConfigUnavailableError(blockNumber);

  return {
    silverMinimumUSDT6: BigInt(row.silverMinimumUSDT6),
    goldMinimumUSDT6: BigInt(row.goldMinimumUSDT6),
    memberRevenueRateE6: BigInt(row.memberRevenueRateE6),
    marketingRateE6: BigInt(row.marketingRateE6),
    marketingCollector: (row.marketingCollector ?? ZERO_COLLECTOR).toLowerCase(),
    revenueEnabled: row.revenueEnabled,
    blockNumber: row.blockNumber,
    logIndex: row.logIndex,
  };
}

export interface ConfigSyncResult {
  fromBlock: number;
  toBlock: number;
  requests: number;
  rowsInserted: number;
  rowsAlreadyPresent: number;
}

/**
 * Indexes every configuration event in [fromBlock, toBlock] into DAOConfigHistory.
 *
 * Chunked because Amoy's free tier caps eth_getLogs at 10 blocks and exceeding it fails the
 * whole range rather than returning a partial answer. The chunk size is configurable so a
 * better endpoint can use larger windows without a code change.
 *
 * Idempotent: identity is {chainId, dao, blockNumber, logIndex}, so re-running over a range
 * already indexed inserts nothing and reports it.
 */
export async function syncDAOConfigHistory(options: {
  fromBlock: number;
  toBlock?: number;
} ): Promise<ConfigSyncResult> {
  const k = key();
  const address = getAddress(config.acfDaoAddress);
  const toBlock = options.toBlock ?? Number(await publicClient.getBlockNumber());
  const chunk = Math.max(1, config.daoConfigLogChunkBlocks);

  if (options.fromBlock > toBlock) {
    return {
      fromBlock: options.fromBlock, toBlock, requests: 0,
      rowsInserted: 0, rowsAlreadyPresent: 0,
    };
  }

  // Carried forward across chunks so a RevenueEnabledUpdated row can store the thresholds in
  // force at its own block. Seeded from whatever is already indexed before this range.
  let carried = await latestBefore(options.fromBlock);

  let requests = 0;
  let inserted = 0;
  let present = 0;
  const timestampCache = new Map<number, number>();

  for (let start = options.fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(start + chunk - 1, toBlock);
    const logs = await getLogsWithRetry(address, start, end);
    requests += 1;
    // Recorded per chunk, not once at the end: an interrupted scan then resumes where it
    // stopped instead of starting over.
    await recordScanned(k, end);
    if (logs.length === 0) continue;

    const parsed = parseEventLogs({
      abi: [revenueConfigUpdatedEventAbi, revenueEnabledUpdatedEventAbi, marketingFeeCollectorUpdatedEventAbi],
      logs: logs as Log[],
    });
    // Chain order within the chunk, so carried state advances correctly.
    const ordered = [...parsed].sort(
      (a, b) =>
        Number(a.blockNumber! - b.blockNumber!) || Number(a.logIndex!) - Number(b.logIndex!),
    );

    for (const event of ordered) {
      const blockNumber = Number(event.blockNumber);
      if (!timestampCache.has(blockNumber)) {
        const block = await publicClient.getBlock({ blockNumber: BigInt(blockNumber) });
        timestampCache.set(blockNumber, Number(block.timestamp));
      }

      const row = nextRow(carried, event);
      carried = row;

      const result = await DAOConfigHistory.updateOne(
        {
          ...k, blockNumber, logIndex: Number(event.logIndex),
        },
        {
          $setOnInsert: {
            ...k,
            blockNumber,
            logIndex: Number(event.logIndex),
            blockTimestamp: timestampCache.get(blockNumber)!,
            txHash: String(event.transactionHash).toLowerCase(),
            eventName: event.eventName,
            silverMinimumUSDT6: row.silverMinimumUSDT6.toString(),
            goldMinimumUSDT6: row.goldMinimumUSDT6.toString(),
            memberRevenueRateE6: row.memberRevenueRateE6.toString(),
            marketingRateE6: row.marketingRateE6.toString(),
            marketingCollector: row.marketingCollector,
            revenueEnabled: row.revenueEnabled,
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount > 0) inserted += 1;
      else present += 1;
    }
  }

  logger.info("dao config history synced", {
    fromBlock: options.fromBlock, toBlock, requests, inserted, present,
  });
  return {
    fromBlock: options.fromBlock, toBlock, requests,
    rowsInserted: inserted, rowsAlreadyPresent: present,
  };
}

/**
 * Reads one chunk's logs, retrying a rate limit or a transient server error.
 *
 * A 10-block window means thousands of sequential requests over a long range, so a 429 is an
 * expected part of the scan rather than an exception. Retries are bounded and backed off; after
 * that the error propagates, and because the cursor advances per chunk the next run simply
 * resumes from where this one stopped.
 */
async function getLogsWithRetry(
  address: `0x${string}`,
  fromBlock: number,
  toBlock: number,
): Promise<Awaited<ReturnType<typeof publicClient.getLogs>>> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await publicClient.getLogs({
        address,
        events: [revenueConfigUpdatedEventAbi, revenueEnabledUpdatedEventAbi, marketingFeeCollectorUpdatedEventAbi],
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      });
    } catch (cause) {
      const message = (cause as Error).message ?? "";
      const retryable = /429|rate limit|timeout|ETIMEDOUT|ECONNRESET|50[0234]/i.test(message);
      if (!retryable || attempt >= MAX_ATTEMPTS) throw cause;
      const waitMs = 500 * 2 ** (attempt - 1);          // 0.5s, 1s, 2s, 4s
      logger.warn("dao config log read retrying", {
        fromBlock, toBlock, attempt, waitMs, error: (message.split("\n")[0] ?? message).slice(0, 120),
      });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** Remembers how far the log has been read, so the next run only looks at new blocks. */
async function recordScanned(
  k: { chainId: number; daoContractAddress: string },
  blockNumber: number,
): Promise<void> {
  await DAOConfigSyncState.updateOne(
    k,
    {
      $max: { lastScannedBlock: blockNumber },
      $set: { lastScannedAt: new Date() },
      $setOnInsert: k,
    },
    { upsert: true },
  );
}

/** How far the log has been read, or null when it has never been scanned. */
export async function lastScannedBlock(): Promise<number | null> {
  const row = await DAOConfigSyncState.findOne(key()).lean();
  return row?.lastScannedBlock ?? null;
}

/** The highest indexed row strictly before `blockNumber`, as carry-forward state. */
async function latestBefore(blockNumber: number): Promise<CarriedConfig> {
  const row = await DAOConfigHistory.findOne(
    { ...key(), blockNumber: { $lt: blockNumber } },
  ).sort({ blockNumber: -1, logIndex: -1 }).lean();
  if (!row) {
    return {
      silverMinimumUSDT6: null, goldMinimumUSDT6: null,
      memberRevenueRateE6: null, marketingRateE6: null, marketingCollector: null,
      revenueEnabled: null,
    };
  }
  return {
    silverMinimumUSDT6: BigInt(row.silverMinimumUSDT6),
    goldMinimumUSDT6: BigInt(row.goldMinimumUSDT6),
    memberRevenueRateE6: BigInt(row.memberRevenueRateE6),
    marketingRateE6: BigInt(row.marketingRateE6),
    marketingCollector: (row.marketingCollector ?? ZERO_COLLECTOR).toLowerCase(),
    revenueEnabled: row.revenueEnabled,
  };
}

interface CarriedConfig {
  silverMinimumUSDT6: bigint | null;
  goldMinimumUSDT6: bigint | null;
  memberRevenueRateE6: bigint | null;
  marketingRateE6: bigint | null;
  marketingCollector: string | null;
  revenueEnabled: boolean | null;
}

interface FullConfig {
  silverMinimumUSDT6: bigint;
  goldMinimumUSDT6: bigint;
  memberRevenueRateE6: bigint;
  marketingRateE6: bigint;
  marketingCollector: string;
  revenueEnabled: boolean;
}

/**
 * Folds one event onto the carried state to produce a complete snapshot.
 *
 * A RevenueEnabledUpdated arriving before any thresholds are known means the range started
 * after `initialize()` — the history would have a hole, and a hole here silently prices an
 * epoch against the wrong threshold. Refuse rather than invent a default.
 */
function nextRow(
  carried: CarriedConfig,
  event: { eventName: string; args: Record<string, unknown>; blockNumber?: bigint | null },
): FullConfig {
  if (event.eventName === "RevenueConfigUpdated") {
    return {
      silverMinimumUSDT6: event.args.silverMinimumUSDT as bigint,
      goldMinimumUSDT6: event.args.goldMinimumUSDT as bigint,
      memberRevenueRateE6: event.args.memberRevenuePercentage as bigint,
      marketingRateE6: event.args.marketingPercentage as bigint,
      // initialize() emits RevenueConfigUpdated then RevenueEnabledUpdated(true) then
      // MarketingFeeCollectorUpdated; before the later two land, carry whatever is already in
      // force. Both default to "unknown" rather than to a guess: `false` pays nobody, and the
      // zero collector makes an epoch resolving to it refuse rather than pay an invented address.
      marketingCollector: carried.marketingCollector ?? ZERO_COLLECTOR,
      revenueEnabled: carried.revenueEnabled ?? false,
    };
  }

  if (
    carried.silverMinimumUSDT6 === null || carried.goldMinimumUSDT6 === null
    || carried.memberRevenueRateE6 === null || carried.marketingRateE6 === null
  ) {
    throw new DAORevenueInvariantError(
      `${event.eventName} at block ${event.blockNumber} arrived with no known thresholds. ` +
        "The configuration history has a hole; backfill from the contract's deployment block.",
    );
  }

  const carriedForward = {
    silverMinimumUSDT6: carried.silverMinimumUSDT6,
    goldMinimumUSDT6: carried.goldMinimumUSDT6,
    memberRevenueRateE6: carried.memberRevenueRateE6,
    marketingRateE6: carried.marketingRateE6,
  };

  if (event.eventName === "MarketingFeeCollectorUpdated") {
    return {
      ...carriedForward,
      marketingCollector: String(event.args.newCollector).toLowerCase(),
      revenueEnabled: carried.revenueEnabled ?? false,
    };
  }

  return {
    ...carriedForward,
    marketingCollector: carried.marketingCollector ?? ZERO_COLLECTOR,
    revenueEnabled: event.args.enabled as boolean,
  };
}
