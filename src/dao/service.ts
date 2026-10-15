import { decodeEventLog, getAddress } from "viem";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { chainReader, type ChainReader } from "../lib/chain.js";
import { daoContributionCreatedEventAbi } from "../abi/daoEvent.js";
import { stakeCreatedEventAbi } from "../abi/stakingEvent.js";
import { DAOContribution, type DAOContributionDocument } from "../models/DAOContribution.js";
import { DAOReconciliationState } from "../models/DAOReconciliationState.js";
import { Stake } from "../models/Stake.js";
import { User } from "../models/User.js";
import { upsertStake } from "../staking/service.js";
import { daoRewardPolicy } from "./policy.js";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const STAKE_SOURCE = ["DIRECT", "BOND", "DAO"] as const;

/** Only the reads this module needs, so tests can supply a small fake. */
export type DAOServiceReader = ChainReader;

interface ContributionArgs {
  contributionId: bigint;
  beneficiary: string;
  stakeId: bigint;
  poolId: bigint;
  usdtContributed: bigint;
  acfStaked: bigint;
  executionPriceE18: bigint;
}

interface StakeArgs {
  user: string;
  stakeId: bigint;
  poolId: bigint;
  principal: bigint;
  poolDailyROIAtCreation: bigint;
  stakeTimestamp: bigint;
  unlockTimestamp: bigint;
  source: number;
}

export type MembershipTier = "NONE" | "SILVER" | "GOLD";

export interface DAOContributionResponse {
  contributionId: string;
  usdtContributed: string;
  acfStaked: string;
  executionPriceE18: string;
  daoPoolId: number;
  stakeId: string;
  stakeTimestamp: string | null;
  unlockTimestamp: string | null;
  /** Current chain truth, re-read from Staking — never a cached business flag. */
  active: boolean;
  /** Past its 750-day unlock. Maturity alone does NOT end rewards or governance. */
  matured: boolean;
  txHash: string;
  blockNumber: number;
  contributedAt: string;
}

export interface DAOMembership {
  activeContributionUSDT: string;
  totalContributionUSDT: string;
  /** True whenever ANY source=DAO position is still active, regardless of current tier. */
  hasActiveDAOPosition: boolean;
  membershipTier: MembershipTier;
  /** Tier-based: the shared member revenue pool needs the current Silver minimum. */
  revenueEligible: boolean;
  /** Stake-based, matching the contract: one active source=DAO position is enough. */
  governanceEligible: boolean;

  silverMinimumUSDT: string;
  goldMinimumUSDT: string;
  memberRevenuePercentage: string;

  /** The smallest amount contribute() accepts — always the Silver minimum, never Gold's. */
  minimumNextContributionUSDT: string;
  /** One-transaction amount that lands at or above Gold; floored at Silver. 0 once Gold. */
  amountToReachGoldUSDT: string;
  /** Pure distance to Gold, which may be BELOW the submittable minimum. Display only. */
  distanceToGoldUSDT: string;

  daoPoolId: number;
  daoLockDurationSeconds: string;
  daoDailyRewardPercentage: number;
  daoEpochRewardPercentage: number;

  revenueEnabled: boolean;
  daoClosed: boolean;
}

function requireTxHash(raw: unknown): string {
  if (typeof raw !== "string" || !TX_HASH.test(raw.trim())) {
    throw new HttpError(400, "INVALID_TX_HASH", "A 32-byte transaction hash is required.");
  }
  return raw.trim().toLowerCase();
}

async function requireUserAddress(userId: string): Promise<string> {
  const user = await User.findOne({ userId });
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "User no longer exists.");
  // `externalEOA` is required and immutable on every user, so an absent value is a corrupt
  // record rather than a state the caller can resolve by onboarding.
  if (!user.externalEOA) {
    throw new HttpError(500, "INTERNAL_ERROR", "This account has no address on record.");
  }
  return user.externalEOA.toLowerCase();
}

/**
 * Records a DAO contribution from its transaction hash.
 *
 * The browser supplies ONLY a hash. Every amount, id and address is read back from the chain,
 * and the authenticated user's own address — never a body field — is the beneficiary that must match.
 */
export async function recordDAOContribution(
  userId: string,
  rawTxHash: unknown,
  reader: DAOServiceReader = chainReader,
): Promise<DAOContributionResponse> {
  const txHash = requireTxHash(rawTxHash);
  const userAddress = await requireUserAddress(userId);

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

  const daoAddress = getAddress(config.acfDaoAddress).toLowerCase();
  const stakingAddress = getAddress(config.acfStakingAddress).toLowerCase();

  // ── the DAOContributionCreated belonging to this user, from the canonical DAO ──
  let contribution: ContributionArgs | null = null;
  let contributionLogIndex = -1;

  for (const log of receipt.logs) {
    if (log.address !== daoAddress) continue;
    try {
      const decoded = decodeEventLog({
        abi: daoContributionCreatedEventAbi,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName !== "DAOContributionCreated") continue;
      const a = decoded.args as unknown as ContributionArgs;
      if (a.beneficiary.toLowerCase() !== userAddress) continue;
      contribution = a;
      contributionLogIndex = log.logIndex;
      break;
    } catch {
      continue;
    }
  }

  if (!contribution) {
    throw new HttpError(
      422,
      "NO_CONTRIBUTION_FOR_WALLET",
      "That transaction contains no DAO contribution belonging to this account.",
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
      if (a.stakeId !== contribution.stakeId) continue;
      stakeLog = { logIndex: log.logIndex, args: a };
      break;
    } catch {
      continue;
    }
  }
  if (!stakeLog) {
    throw new HttpError(422, "NO_LINKED_STAKE", "The contribution's staking position could not be found.");
  }

  const s = stakeLog.args;
  const source = STAKE_SOURCE[s.source as 0 | 1 | 2];

  if (source !== "DAO") {
    throw new HttpError(422, "NOT_DAO_STAKE", "The linked position was not created by the DAO.");
  }
  if (s.user.toLowerCase() !== userAddress) {
    throw new HttpError(422, "STAKE_BENEFICIARY_MISMATCH", "The linked position belongs to another account.");
  }
  if (s.poolId !== contribution.poolId) {
    throw new HttpError(422, "POOL_MISMATCH", "DAO and staking events disagree on the pool.");
  }
  if (s.principal !== contribution.acfStaked) {
    throw new HttpError(422, "PRINCIPAL_MISMATCH", "DAO and staking events disagree on the amount.");
  }

  // The DAO's own canonical pool, so a contribution into any other pool is rejected outright.
  const canonicalPoolId = await reader.daoPoolId();
  if (contribution.poolId !== canonicalPoolId) {
    throw new HttpError(422, "NOT_DAO_POOL", "The position is not in the canonical DAO staking pool.");
  }

  // Contract storage must agree with the event before anything is written.
  const stored = await reader.daoContribution(contribution.contributionId);
  if (
    stored.beneficiary !== userAddress ||
    stored.usdtContributed !== contribution.usdtContributed ||
    stored.acfStaked !== contribution.acfStaked ||
    stored.stakeId !== contribution.stakeId
  ) {
    throw new HttpError(422, "CONTRIBUTION_MISMATCH", "The on-chain record does not match the event.");
  }

  const timestamp = await reader.blockTimestamp(receipt.blockNumber);
  const blockTimestamp = new Date(Number(timestamp) * 1000);

  // ── idempotent dual persistence (NOT a Mongo transaction) ──
  // Stake first: a contribution pointing at a missing Stake is a dangling reference, whereas a
  // DAO Stake without its contribution row is merely incomplete and repaired by retrying.
  await upsertStake({
    eventId: `${config.chainId}:${txHash}:${stakeLog.logIndex}`,
    chainId: config.chainId,
    stakingContractAddress: stakingAddress,
    stakeId: s.stakeId.toString(),
    userId,
    externalEOA: userAddress,
    poolId: Number(s.poolId),
    principalACF: s.principal.toString(),
    source: "DAO",
    poolDailyROIAtCreation: s.poolDailyROIAtCreation.toString(),
    stakeTimestamp: new Date(Number(s.stakeTimestamp) * 1000),
    unlockTimestamp: new Date(Number(s.unlockTimestamp) * 1000),
    txHash,
    blockNumber: Number(receipt.blockNumber),
    logIndex: stakeLog.logIndex,
  });

  const eventId = `${config.chainId}:${txHash}:${contributionLogIndex}`;

  // Match on the PROTOCOL identity, not the event id. Reconciliation may already have stored
  // this contribution under a synthetic id (it has no receipt to derive one from), and the
  // compound {chainId, daoContractAddress, contributionId} index is unique — so keying the
  // upsert on eventId alone would attempt a second insert and fail with E11000.
  const identity = {
    chainId: config.chainId,
    daoContractAddress: daoAddress,
    contributionId: contribution.contributionId.toString(),
  };

  const row = (await DAOContribution.findOneAndUpdate(
    identity,
    {
      // A reconciled row carries placeholders the getter could not supply; a receipt can, so
      // these always win. Every one is read from the chain, never from the request body.
      $set: {
        eventId,
        executionPriceE18: contribution.executionPriceE18.toString(),
        txHash,
        blockNumber: Number(receipt.blockNumber),
        logIndex: contributionLogIndex,
        blockTimestamp,
      },
      $setOnInsert: {
        ...identity,
        userId,
        externalEOA: userAddress,
        usdtContributed: contribution.usdtContributed.toString(),
        acfStaked: contribution.acfStaked.toString(),
        daoPoolId: Number(contribution.poolId),
        stakingContractAddress: stakingAddress,
        stakeId: contribution.stakeId.toString(),
        lastKnownActive: true,
      },
    },
    { upsert: true, new: true },
  ))!;

  return (await decorate([row], reader))[0]!;
}

/**
 * Attaches CURRENT chain activity to persisted rows.
 *
 * Activity is never trusted from Mongo. The one optimisation: withdrawal is terminal in
 * ACFStaking (`active` goes true -> false with no inverse), so a row already proven inactive
 * is not re-read. Everything still believed active is re-checked every time.
 */
async function decorate(
  rows: DAOContributionDocument[],
  reader: DAOServiceReader,
): Promise<DAOContributionResponse[]> {
  const stakes = await Stake.find({
    chainId: config.chainId,
    stakeId: { $in: rows.map((r) => r.stakeId) },
  });
  const stakeBy = new Map(stakes.map((s) => [s.stakeId, s]));

  const now = Date.now();

  // Checked in parallel: a member with ten positions would otherwise cost ten sequential
  // round-trips on every history and membership read.
  const activity = await Promise.all(
    rows.map(async (row) => {
      if (!row.lastKnownActive) return false;   // withdrawal is terminal; never re-read
      try {
        return await reader.daoContributionActive(BigInt(row.contributionId));
      } catch {
        // A read failure must not silently retire a live position; keep the last known value
        // rather than inventing a withdrawal.
        return true;
      }
    }),
  );

  const retired = rows.filter((row, i) => row.lastKnownActive && !activity[i]).map((r) => r.eventId);
  if (retired.length > 0) {
    await DAOContribution.updateMany(
      { eventId: { $in: retired } },
      { $set: { lastKnownActive: false, lastActivityCheckAt: new Date() } },
    );
  }

  const out: DAOContributionResponse[] = [];
  for (const [index, row] of rows.entries()) {
    const active = activity[index]!;
    const stake = stakeBy.get(row.stakeId);
    const unlock = stake?.unlockTimestamp ?? null;

    out.push({
      contributionId: row.contributionId,
      usdtContributed: row.usdtContributed,
      acfStaked: row.acfStaked,
      executionPriceE18: row.executionPriceE18,
      daoPoolId: row.daoPoolId,
      stakeId: row.stakeId,
      stakeTimestamp: stake ? stake.stakeTimestamp.toISOString() : null,
      unlockTimestamp: unlock ? unlock.toISOString() : null,
      active,
      matured: unlock ? unlock.getTime() <= now : false,
      txHash: row.txHash,
      blockNumber: row.blockNumber,
      contributedAt: row.blockTimestamp.toISOString(),
    });
  }

  return out;
}

/**
 * Discovers contributions this user made that never reached /dao/sync.
 *
 * A transaction can confirm and the browser close before the sync call, so Mongo alone is an
 * incomplete record. Discovery walks the contract's own sequential ids from a persisted
 * high-water mark, which is complete by construction and costs O(new ids), not O(chain age).
 *
 * Deliberately NOT a generic indexer: it reads one contract's getters and nothing else.
 */
/**
 * One reconciliation pass per user at a time.
 *
 * The Council page requests membership and history together, so both endpoints start a scan
 * simultaneously. Each reads the cursor before either writes it, so both would walk the same
 * ids — double the RPC work and two writers racing the same rows. Concurrent callers share the
 * in-flight pass instead.
 */
const inFlight = new Map<string, Promise<number>>();

export function reconcileDAOContributions(
  userId: string,
  userAddress: string,
  reader: DAOServiceReader = chainReader,
): Promise<number> {
  const key = `${config.chainId}:${userAddress.toLowerCase()}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const pass = runReconciliation(userId, userAddress, reader).finally(() => inFlight.delete(key));
  inFlight.set(key, pass);
  return pass;
}

async function runReconciliation(
  userId: string,
  userAddress: string,
  reader: DAOServiceReader = chainReader,
): Promise<number> {
  const daoAddress = getAddress(config.acfDaoAddress).toLowerCase();
  // Scoped to this user: a pass stores only the caller's rows, so a shared cursor would let
  // one user's read skip past another user's contribution permanently.
  const key = { chainId: config.chainId, daoContractAddress: daoAddress, externalEOA: userAddress };

  const state =
    (await DAOReconciliationState.findOne(key)) ??
    (await DAOReconciliationState.findOneAndUpdate(
      key,
      { $setOnInsert: { ...key, nextContributionIdProcessed: "1" } },
      { upsert: true, new: true },
    ))!;

  let nextId: bigint;
  try {
    nextId = await reader.daoNextContributionId();
  } catch {
    // Discovery is best-effort: a reconciliation outage must not fail a history read.
    return 0;
  }

  let cursor = BigInt(state.nextContributionIdProcessed);
  if (cursor < 1n) cursor = 1n;
  let discovered = 0;

  for (; cursor < nextId; cursor++) {
    let record;
    try {
      record = await reader.daoContribution(cursor);
    } catch {
      break; // stop at the first unreadable id; the cursor is not advanced past it
    }

    if (record.beneficiary === userAddress) {
      const eventId = `${config.chainId}:reconciled:${daoAddress}:${cursor}`;
      const already = await DAOContribution.findOne({
        chainId: config.chainId,
        daoContractAddress: daoAddress,
        contributionId: cursor.toString(),
      });
      if (!already) {
        try {
          await DAOContribution.findOneAndUpdate(
            { eventId },
            {
              $setOnInsert: {
                eventId,
                chainId: config.chainId,
                daoContractAddress: daoAddress,
                contributionId: cursor.toString(),
                userId,
                externalEOA: userAddress,
                usdtContributed: record.usdtContributed.toString(),
                acfStaked: record.acfStaked.toString(),
                // Not emitted by the getter; the event carries it and a sync will fill it in.
                executionPriceE18: "0",
                daoPoolId: Number(record.poolId),
                stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
                stakeId: record.stakeId.toString(),
                txHash: `0x${"0".repeat(64)}`,
                blockNumber: 0,
                logIndex: -1,
                blockTimestamp: new Date(Number(record.timestamp) * 1000),
                lastKnownActive: true,
              },
            },
            { upsert: true, new: true },
          );
          discovered += 1;
        } catch (cause) {
          // Another writer inserted the same contribution first. The row exists either way,
          // which is the outcome we wanted; only a different failure is worth surfacing.
          if ((cause as { code?: number })?.code !== 11000) throw cause;
        }
      }
    }
  }

  await DAOReconciliationState.updateOne(key, {
    $set: {
      nextContributionIdProcessed: cursor.toString(),
      lastReconciledAt: new Date(),
    },
  });

  return discovered;
}

/** The authenticated user's DAO contributions, reconciled against chain before returning. */
export async function listDAOContributions(
  userId: string,
  reader: DAOServiceReader = chainReader,
): Promise<{ contributions: DAOContributionResponse[] }> {
  const userAddress = await requireUserAddress(userId);
  await reconcileDAOContributions(userId, userAddress, reader);

  const rows = await DAOContribution.find({ userId }).sort({ blockTimestamp: -1 });
  return { contributions: await decorate(rows, reader) };
}

/**
 * Derives membership from CURRENT chain state, never from a stored tier.
 *
 * Tier and governance eligibility are deliberately separate. A contribution made before an
 * admin RAISED the Silver minimum can leave a member with an active DAO position whose
 * combined total now sits below the threshold: tier becomes NONE and revenue stops, but the
 * contract still accepts their vote because the stake is active. The response models both.
 */
export async function getDAOMembership(
  userId: string,
  reader: DAOServiceReader = chainReader,
): Promise<DAOMembership> {
  const userAddress = await requireUserAddress(userId);
  await reconcileDAOContributions(userId, userAddress, reader);

  const rows = await DAOContribution.find({ userId });
  const decorated = await decorate(rows, reader);

  let activeUSDT = 0n;
  let totalUSDT = 0n;
  let hasActiveDAOPosition = false;
  for (const [index, row] of rows.entries()) {
    totalUSDT += BigInt(row.usdtContributed);
    if (decorated[index]!.active) {
      activeUSDT += BigInt(row.usdtContributed);
      hasActiveDAOPosition = true;
    }
  }

  let revenueConfig;
  let poolId: bigint;
  let lockDuration: bigint;
  let revenueEnabled: boolean;
  let daoClosed: boolean;
  try {
    [revenueConfig, poolId, lockDuration, revenueEnabled, daoClosed] = await Promise.all([
      reader.daoRevenueConfig(),
      reader.daoPoolId(),
      reader.daoLockDuration(),
      reader.daoRevenueEnabled(),
      reader.daoClosed(),
    ]);
  } catch {
    throw new HttpError(503, "CHAIN_UNAVAILABLE", "Could not read DAO configuration. Try again.");
  }

  const silver = revenueConfig.silverMinimumUSDT;
  const gold = revenueConfig.goldMinimumUSDT;

  const membershipTier: MembershipTier =
    activeUSDT >= gold ? "GOLD" : activeUSDT >= silver ? "SILVER" : "NONE";

  const distanceToGold = activeUSDT >= gold ? 0n : gold - activeUSDT;
  // Gold is a TARGET, not a minimum. contribute() only ever enforces the Silver minimum, so a
  // new member joins at Silver; quoting the Gold gap here would price entry at 25,000.
  const minimumNext = silver;
  // What it would take, in one transaction, to land at or above Gold. Floored at Silver
  // because a 2,000 top-up from 23,000 would revert BelowSilverMinimum.
  const amountToReachGold =
    activeUSDT >= gold ? 0n : distanceToGold > silver ? distanceToGold : silver;

  return {
    activeContributionUSDT: activeUSDT.toString(),
    totalContributionUSDT: totalUSDT.toString(),
    hasActiveDAOPosition,
    membershipTier,
    revenueEligible: activeUSDT >= silver,
    // Matches the contract: one active source=DAO position is sufficient, tier is irrelevant.
    governanceEligible: hasActiveDAOPosition,

    silverMinimumUSDT: silver.toString(),
    goldMinimumUSDT: gold.toString(),
    memberRevenuePercentage: revenueConfig.memberRevenuePercentage.toString(),

    minimumNextContributionUSDT: minimumNext.toString(),
    amountToReachGoldUSDT: amountToReachGold.toString(),
    distanceToGoldUSDT: distanceToGold.toString(),

    daoPoolId: Number(poolId),
    daoLockDurationSeconds: lockDuration.toString(),
    daoDailyRewardPercentage: daoRewardPolicy.daoDailyRewardPercentage,
    daoEpochRewardPercentage: daoRewardPolicy.daoEpochRewardPercentage,

    revenueEnabled,
    daoClosed,
  };
}
