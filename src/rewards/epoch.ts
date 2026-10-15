import { getAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { RewardEpoch } from "../models/RewardEpoch.js";
import { StakeRewardEntry } from "../models/StakeRewardEntry.js";
import { Stake } from "../models/Stake.js";
import { rewardChainReader, type RewardChainReader } from "./chain.js";
import {
  backfillWithdrawalBlocks, discoverStakes, DiscoveryIncompleteError, reconcileActiveStakes,
  UnmappedStakeError,
} from "./reconcile.js";
import {
  RATE_DENOMINATOR, epochReward, isRewardEligible, rateFor,
  snapshotAtOf, windowStartOf, type StakeSource,
} from "./policy.js";
import { claimedSelfACFForStake } from "../settlement/claims.js";

/** How long a worker may own a PROCESSING epoch before another may take it over. */
const LEASE_MS = 30 * 60 * 1000;

const key = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
});

export class EpochNotEligibleError extends Error {
  constructor(message: string) { super(message); this.name = "EpochNotEligibleError"; }
}

/** The reward ledger and the settlement ledger disagree about what has been paid out. */
export class ClaimLedgerError extends Error {
  constructor(message: string) { super(message); this.name = "ClaimLedgerError"; }
}

export interface EpochResult {
  epochId: number;
  status: "CALCULATED" | "SKIPPED";
  stakesProcessed: number;
  stakesRewarded: number;
  totalRegularSelfACF: string;
  totalDAOStakeACF: string;
}

/**
 * Settles one twelve-hour window.
 *
 * The single calculation path: the scheduler, the catch-up sweep and the manual command all
 * call this, so there is no second implementation to drift.
 *
 * Order matters and is not an accident — stake discovery and active-state reconciliation run
 * BEFORE any arithmetic, because rewarding on unverified state is how a withdrawn position
 * keeps earning.
 */
export async function runRewardEpoch(
  epochId: number,
  deps: { reader?: RewardChainReader; now?: () => number } = {},
): Promise<EpochResult> {
  const reader = deps.reader ?? rewardChainReader;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  const snapshotAt = snapshotAtOf(epochId);
  const windowStart = windowStartOf(epochId);
  const k = key();

  if (epochId < config.rewardActivationEpoch) {
    throw new EpochNotEligibleError(
      `Epoch ${epochId} precedes REWARD_ENGINE_ACTIVATION_EPOCH ` +
        `${config.rewardActivationEpoch}. The engine creates no liability before activation.`,
    );
  }
  if (snapshotAt > now()) {
    throw new EpochNotEligibleError(
      `Epoch ${epochId} ends at ${snapshotAt} which is in the future. An epoch settles a window ` +
        "that has already completed.",
    );
  }

  // ── 1. acquire ────────────────────────────────────────────────────────────
  // Conditional update, not an in-memory mutex: two processes must not both own one epoch, and
  // a mutex is invisible across instances. A PROCESSING epoch whose lease expired is reclaimable,
  // so a worker killed mid-epoch does not freeze it forever.
  const staleBefore = new Date(Date.now() - LEASE_MS);
  const acquired = await RewardEpoch.findOneAndUpdate(
    {
      ...k, epochId,
      $or: [
        { status: { $in: ["PENDING", "FAILED"] } },
        { status: "PROCESSING", leaseExpiresAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: { status: "PROCESSING", leaseExpiresAt: new Date(Date.now() + LEASE_MS), startedAt: new Date() },
      $setOnInsert: { ...k, epochId, windowStart, snapshotAt },
      $inc: { attempts: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).catch((cause: { code?: number }) => {
    // Another worker inserted it first; it owns the epoch.
    if (cause?.code === 11000) return null;
    throw cause;
  });

  if (!acquired) {
    const existing = await RewardEpoch.findOne({ ...k, epochId });
    return {
      epochId,
      status: "SKIPPED",
      stakesProcessed: existing?.stakesProcessed ?? 0,
      stakesRewarded: existing?.stakesRewarded ?? 0,
      totalRegularSelfACF: existing?.totalRegularSelfACF ?? "0",
      totalDAOStakeACF: existing?.totalDAOStakeACF ?? "0",
    };
  }
  if (acquired.status === "CALCULATED" || acquired.status === "FINALIZED") {
    return {
      epochId, status: "SKIPPED",
      stakesProcessed: acquired.stakesProcessed, stakesRewarded: acquired.stakesRewarded,
      totalRegularSelfACF: acquired.totalRegularSelfACF, totalDAOStakeACF: acquired.totalDAOStakeACF,
    };
  }

  try {
    // ── 2. the epoch's chain-state anchor ───────────────────────────────────
    // Resolved once and reused forever after. Re-resolving on a retry would settle the same
    // epoch against a different chain state, which is the whole defect this guards against.
    let snapshotBlockNumber = acquired.snapshotBlockNumber ?? null;
    let snapshotBlockTimestamp = acquired.snapshotBlockTimestamp ?? null;
    if (snapshotBlockNumber === null) {
      const resolved = await reader.blockAtOrBefore(snapshotAt);
      snapshotBlockNumber = Number(resolved.blockNumber);
      snapshotBlockTimestamp = resolved.blockTimestamp;
      await RewardEpoch.updateOne({ ...k, epochId }, {
        $set: { snapshotBlockNumber, snapshotBlockTimestamp },
      });
    }
    const pin = { blockNumber: BigInt(snapshotBlockNumber) };

    // ── 3. chain is authoritative before any money is computed ──────────────
    // Discovery and current-state reconciliation run against LATEST on purpose: the former
    // finds positions the browser never synced, the latter keeps Stake.active useful for the
    // UI. Neither decides this epoch's eligibility — the pinned reads below do.
    const discovery = await discoverStakes(reader);
    if (discovery.unmapped.length > 0) throw new UnmappedStakeError(discovery.unmapped);
    // Completion is checked SEPARATELY from mapping: a walk cut short by an unreadable id
    // reports no unmapped stakes, and settling on it would silently omit every stake past the
    // failure for an epoch that will never re-run.
    if (!discovery.completed) throw new DiscoveryIncompleteError(discovery);
    await reconcileActiveStakes(reader);
    await backfillWithdrawalBlocks(reader);

    // ── 4-5. snapshots AT THE BOUNDARY. Either fails the epoch; neither is defaulted. ──
    const price = await reader.priceSnapshot(pin);
    const pools = await reader.getPools(pin);
    // Only the ROI is consumed. lockDuration is still snapshotted into the epoch record below
    // for audit, but it never prices or gates a reward.
    const rateByPool = new Map(pools.map((p) => [p.poolId, p.currentDailyRewardRate]));

    await RewardEpoch.updateOne({ ...k, epochId }, {
      $set: {
        priceE18: price.priceE18.toString(),
        // Equals snapshotBlockNumber: the price is read at the boundary, not at settlement time.
        priceBlockNumber: price.blockNumber,
        priceBlockTimestamp: price.blockTimestamp,
        poolROISnapshot: pools.map((p) => ({
          poolId: p.poolId,
          currentDailyRewardRate: p.currentDailyRewardRate.toString(),
          lockDuration: p.lockDuration,
          active: p.active,
        })),
      },
    });

    // ── 6-8. per-stake calculation ──────────────────────────────────────────
    let processed = 0;
    let rewarded = 0;
    let totalRegular = 0n;
    let totalDAO = 0n;
    let lastStakeId = "";

    for (;;) {
      // Keyset pagination. stakeId is a decimal string, so this orders lexicographically
      // ("10" before "9"); that is complete and duplicate-free because the sort and the $gt
      // cursor share one ordering, and neither loop depends on numeric order.
      const page = await Stake.find({
        ...k,
        ...(lastStakeId ? { stakeId: { $gt: lastStakeId } } : {}),
      }).sort({ stakeId: 1 }).limit(config.rewardStakePageSize);
      if (page.length === 0) break;
      lastStakeId = page.at(-1)!.stakeId;

      const rows: Record<string, unknown>[] = [];
      // Stake state AS OF the boundary. Never the mutable DB `active`, which reflects whenever
      // reconciliation last ran and would retroactively void an epoch the position was active
      // throughout.
      const atSnapshot = await reader.getStakes(page.map((s) => BigInt(s.stakeId)), pin);

      for (const [index, stake] of page.entries()) {
        const source = stake.source as StakeSource;
        const stakeTimestamp = Math.floor(stake.stakeTimestamp.getTime() / 1000);
        const chain = atSnapshot[index] ?? null;

        let verdict;
        if (chain === null) {
          // Absent at the boundary. Legitimate only for a position created after it — any
          // stake created at or before snapshotAt was mined in a block at or before the
          // snapshot block, so it must be readable there.
          if (stakeTimestamp <= snapshotAt) {
            throw new Error(
              `Stake ${stake.stakeId} could not be read at snapshot block ${snapshotBlockNumber} ` +
                `although it was created at ${stakeTimestamp} (<= ${snapshotAt}). Refusing to ` +
                "settle an epoch on unverified stake state.",
            );
          }
          // Did not exist yet. The 12-hour age rule is what excludes it; a negative age can
          // only ever produce TOO_YOUNG.
          verdict = { eligible: false, reason: "TOO_YOUNG" } as const;
        } else {
          assertImmutableFieldsMatch(stake, chain, snapshotBlockNumber);
          // unlockTimestamp is deliberately NOT passed: maturity decides when principal may be
          // withdrawn, not whether the stake earns. Only `active` ends earning — and it is the
          // value from the snapshot block, so a later withdrawal cannot reach back.
          verdict = isRewardEligible({ source, active: chain.active, stakeTimestamp }, snapshotAt);
        }

        const principal = BigInt(stake.principalACF);
        const prior = await priorRewardACF(k, stake.userId, stake.stakeId, epochId);
        // Only UNCLAIMED reward compounds; cumulativeEarnedACF stays lifetime earned.
        const compoundBase = principal + prior.earned - prior.claimed;
        const rate = verdict.eligible ? rateFor(source, rateByPool.get(stake.poolId)) : 0n;
        const reward = verdict.eligible ? epochReward(compoundBase, rate) : 0n;

        if (reward > 0n) {
          rewarded += 1;
          if (source === "DAO") totalDAO += reward;
          else totalRegular += reward;
        }
        processed += 1;

        rows.push({
          ...k, stakeId: stake.stakeId, epochId,
          userId: stake.userId, externalEOA: stake.externalEOA,
          source, poolId: stake.poolId,
          principalACF: principal.toString(),
          compoundBaseACF: compoundBase.toString(),
          rewardACF: reward.toString(),
          cumulativeEarnedACF: (prior.earned + reward).toString(),
          rateApplied: rate.toString(),
          rateDenominator: RATE_DENOMINATOR.toString(),
          rewardEligible: verdict.eligible,
          ineligibleReason: verdict.eligible ? null : verdict.reason,
          snapshotAt,
        });
      }

      await persistRewardEntries(k, epochId, rows);

      if (page.length < config.rewardStakePageSize) break;
    }

    // ── 9-10. only now is the epoch financial truth ─────────────────────────
    await RewardEpoch.updateOne({ ...k, epochId }, {
      $set: {
        status: "CALCULATED",
        leaseExpiresAt: null,
        lastError: null,
        calculatedAt: new Date(),
        stakesProcessed: processed,
        stakesRewarded: rewarded,
        totalRegularSelfACF: totalRegular.toString(),
        totalDAOStakeACF: totalDAO.toString(),
      },
    });

    logger.info("reward epoch calculated", {
      epochId, stakesProcessed: processed, stakesRewarded: rewarded,
    });

    return {
      epochId, status: "CALCULATED",
      stakesProcessed: processed, stakesRewarded: rewarded,
      totalRegularSelfACF: totalRegular.toString(),
      totalDAOStakeACF: totalDAO.toString(),
    };
  } catch (cause) {
    await RewardEpoch.updateOne({ ...k, epochId }, {
      $set: {
        status: "FAILED",
        leaseExpiresAt: null,
        lastError: (cause as Error).message.slice(0, 500),
      },
    });
    throw cause;
  }
}

/**
 * Confirms the persisted row still describes the same position the chain does.
 *
 * These four fields are immutable in both places — ACFStaking never mutates principal, poolId,
 * source or user after creation (verified: no assignment to `.principal` exists), and the Stake
 * schema marks them immutable too. So a divergence is not a stale cache to be refreshed; it
 * means the row is about a different position than the id implies, and every amount derived
 * from it is suspect.
 *
 * Therefore it is reported, never repaired. Silently rewriting the row would destroy the
 * evidence and pay out against unverified data.
 */
function assertImmutableFieldsMatch(
  stake: { stakeId: string; principalACF: string; poolId: number; source: string; externalEOA: string },
  chain: { principal: bigint; poolId: bigint; source: 0 | 1 | 2; user: string },
  snapshotBlockNumber: number,
): void {
  const expected = SOURCE_BY_INDEX[chain.source];
  const mismatches: string[] = [];
  if (stake.principalACF !== chain.principal.toString()) {
    mismatches.push(`principal ${stake.principalACF} != ${chain.principal}`);
  }
  if (stake.poolId !== Number(chain.poolId)) {
    mismatches.push(`poolId ${stake.poolId} != ${chain.poolId}`);
  }
  if (stake.source !== expected) {
    mismatches.push(`source ${stake.source} != ${expected}`);
  }
  if (stake.externalEOA.toLowerCase() !== chain.user.toLowerCase()) {
    mismatches.push(`beneficiary ${stake.externalEOA} != ${chain.user}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Stake ${stake.stakeId} does not match chain state at block ${snapshotBlockNumber}: ` +
        `${mismatches.join("; ")}. Refusing to settle an epoch against a position whose ` +
        "immutable financial fields diverge.",
    );
  }
}

/** Mirrors ACFStaking's StakeSource enum ordering. */
const SOURCE_BY_INDEX = ["DIRECT", "BOND", "DAO"] as const;

/**
 * Writes one page of reward rows and PROVES they landed.
 *
 * insertMany(ordered: false) cannot be trusted to report what failed, which is why this does
 * not branch on the error at all:
 *
 *   - one duplicate sets the error's top-level `code` to 11000 even when OTHER rows in the same
 *     batch failed for unrelated reasons, so that code says nothing about the rest;
 *   - a row rejected by schema validation is reported in no channel whatsoever — not
 *     `writeErrors`, not `mongoose.validationErrors` — it is merely absent from `insertedCount`.
 *
 * Both were verified against a real MongoDB. Dropping a row silently is unacceptable here:
 * a later epoch's compound base reads only persisted rows, so one lost row under-pays that
 * stake for the rest of its life and nothing in the system would ever report it.
 *
 * So persistence is confirmed by reading the rows back. A duplicate is fine — a previous
 * attempt wrote it, which is exactly what makes a retry safe — but an absent row is fatal and
 * fails the epoch before it can be marked CALCULATED.
 */
async function persistRewardEntries(
  k: { chainId: number; stakingContractAddress: string },
  epochId: number,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;

  let insertError: unknown;
  try {
    await StakeRewardEntry.insertMany(rows, { ordered: false });
  } catch (cause) {
    // Deliberately not inspected: the verification below is the only reliable signal.
    insertError = cause;
  }

  const stakeIds = rows.map((r) => String(r.stakeId));
  const present = await StakeRewardEntry.countDocuments({
    ...k, epochId, stakeId: { $in: stakeIds },
  });
  if (present === stakeIds.length) return;

  const landed = await StakeRewardEntry.find(
    { ...k, epochId, stakeId: { $in: stakeIds } }, { stakeId: 1 },
  ).lean();
  const missing = stakeIds.filter((id) => !landed.some((e) => e.stakeId === id));
  throw new Error(
    `Epoch ${epochId}: ${missing.length} of ${stakeIds.length} reward rows did not persist ` +
      `(stake ${missing.slice(0, 10).join(", ")}). Refusing to mark the epoch calculated with ` +
      "a missing reward liability." +
      (insertError ? ` Insert reported: ${(insertError as Error).message.slice(0, 200)}` : ""),
  );
}

/**
 * This stake's earned reward from PRIOR epochs, and how much of it a claim has paid out.
 *
 * Reads only epochs whose RewardEpoch is CALCULATED, so a half-written or failed epoch can
 * never contribute to a later compound base — the rows may exist, but they are not yet truth.
 * The current epoch is excluded, so a reward never compounds on itself.
 *
 * The two numbers stay separate because they answer different questions. `earned` is lifetime
 * earned and only ever grows, which is what the audit trail records. `claimed` is what a
 * confirmed on-chain claim has already paid out, and only the difference still compounds: once
 * the user holds those tokens they are no longer an unpaid balance earning reward. Unclaimed
 * reward compounds however old it is, and publishing a checkpoint changes nothing — only a
 * confirmed claim does.
 */
async function priorRewardACF(
  k: { chainId: number; stakingContractAddress: string },
  userId: string,
  stakeId: string,
  beforeEpochId: number,
): Promise<{ earned: bigint; claimed: bigint }> {
  const settled = await RewardEpoch.find(
    { ...k, epochId: { $lt: beforeEpochId }, status: { $in: ["CALCULATED", "FINALIZED"] } },
    { epochId: 1 },
  ).lean();
  if (settled.length === 0) return { earned: 0n, claimed: 0n };

  const entries = await StakeRewardEntry.find(
    { ...k, stakeId, epochId: { $in: settled.map((e) => e.epochId) } },
    { rewardACF: 1 },
  ).lean();

  const earned = entries.reduce((sum, e) => sum + BigInt(e.rewardACF as string), 0n);
  const claimed = await claimedSelfACFForStake(k, userId, stakeId, beforeEpochId);

  // Claimed can never exceed earned: every claimed component records one of the entries summed
  // above, over the same epoch range. If it does, the two ledgers disagree, and continuing would
  // silently alter this stake's compound base — so refuse the epoch rather than floor to zero and
  // pay a number nobody can reconstruct.
  if (claimed > earned) {
    throw new ClaimLedgerError(
      `Stake ${stakeId} (user ${userId}) has ${claimed} ACF recorded as claimed against ` +
        `${earned} ACF earned before epoch ${beforeEpochId}. The settlement and reward ledgers ` +
        "disagree; refusing to compute a compound base.",
    );
  }
  return { earned, claimed };
}
