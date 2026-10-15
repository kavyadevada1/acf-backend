import { getAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { findRootUser } from "../lib/bootstrap.js";
import { syncLogicalRootEOAFromChain } from "../lib/rootSync.js";
import { User } from "../models/User.js";
import { CheckpointSelfComponent } from "../models/CheckpointSelfComponent.js";
import { RewardSettlementCheckpoint } from "../models/RewardSettlementCheckpoint.js";
import { UserRewardCheckpoint } from "../models/UserRewardCheckpoint.js";
import { earnedByUser, selfComponents, settledEpochRange, type SelfComponent } from "./earned.js";
import { buildSettlementTree } from "./merkle.js";
import {
  assertInvariant, AWAITING_OPERATOR, leafHash, ZERO_ROOT, type SettlementLeaf,
} from "./policy.js";
import { settlementChainReader, type SettlementChainReader } from "./chain.js";
import { persistAndVerify } from "./verify.js";

/**
 * Builds one cumulative settlement checkpoint.
 *
 * This module calculates and verifies; it never signs. Funding and root finalization move real
 * Treasury assets and are submitted by the separate settlement executor, after which this
 * module reconciles from chain state.
 */

const keys = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
  withdrawalAddress: getAddress(config.withdrawalAddress).toLowerCase(),
  treasuryAddress: getAddress(config.treasuryAddress).toLowerCase(),
});
const stakeKey = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
});
const settlementKey = () => ({
  chainId: config.chainId,
  withdrawalAddress: getAddress(config.withdrawalAddress).toLowerCase(),
});

export class SettlementStateError extends Error {
  readonly code = "SETTLEMENT_STATE";
  constructor(message: string) {
    super(message);
    this.name = "SettlementStateError";
  }
}

/** The checkpoint id of the zero baseline. Real checkpoints start at 1, so it never collides. */
export const GENESIS_CHECKPOINT_ID = 0;

/**
 * The cumulative predecessor a calculation chains from.
 *
 * Normally the latest FINALIZED checkpoint. On a brand-new deployment there is none, and the
 * predecessor is instead the ZERO BASELINE: the state a virgin Withdrawal already reports.
 *
 * The baseline is derived from live chain state on every call and never persisted. It is not a
 * reward epoch, holds no leaves, no root, no entitlement and no funding, so there is no document
 * for a read model to mistake for settled history and nothing for two processes to race to
 * create. See `resolvePredecessor`.
 */
interface SettlementPredecessor {
  checkpointId: number;
  root: string;
  publishedCumulativeTotalACF: string;
  throughRewardEpochId: number | null;
  /** True only for the zero baseline, which has no document and no published leaves. */
  genesis: boolean;
}

export type CalculateOutcome =
  | { outcome: "NOTHING_TO_SETTLE"; reason: string }
  | { outcome: "AWAITING_OPERATOR"; checkpointId: number; status: string }
  | {
      outcome: "CALCULATED";
      checkpointId: number;
      root: string;
      leafCount: number;
      publishedCumulativeTotalACF: string;
      publishedDeltaACF: string;
      fromRewardEpochId: number;
      throughRewardEpochId: number;
    };

/**
 * Resolves what the next checkpoint chains from.
 *
 * A FINALIZED checkpoint is used exactly as before. Only when none exists is genesis considered,
 * and then ONLY if the Withdrawal itself proves it has never settled anything. An empty database
 * is NOT evidence of a fresh deployment — it is equally consistent with a dropped database in
 * front of a contract that already holds a published root, and chaining from zero there would
 * compute a cumulative total below what the contract already knows, destroying real entitlement.
 * So the decision rests entirely on live chain state, and every mismatch fails closed.
 */
async function resolvePredecessor(
  reader: SettlementChainReader,
  settle: { chainId: number; withdrawalAddress: string },
): Promise<SettlementPredecessor> {
  const finalized = await RewardSettlementCheckpoint.findOne({ ...settle, status: "FINALIZED" })
    .sort({ checkpointId: -1 });
  if (finalized) {
    return {
      checkpointId: finalized.checkpointId,
      root: finalized.root,
      publishedCumulativeTotalACF: finalized.publishedCumulativeTotalACF,
      throughRewardEpochId: finalized.throughRewardEpochId ?? null,
      genesis: false,
    };
  }

  const live = await reader.liveState();
  // finalizeEpoch rejects a zero root and records the epoch, so a virgin contract is exactly:
  // no epoch, no root, nothing entitled and nothing claimed. Each is reported separately rather
  // than inferred from one another, so a partially-advanced contract cannot slip through.
  const notVirgin: string[] = [];
  if (live.latestEpochId !== 0) notVirgin.push(`latestEpochId is ${live.latestEpochId}, expected 0`);
  if (live.root !== ZERO_ROOT) notVirgin.push(`latestCumulativeMerkleRoot is ${live.root}, expected ${ZERO_ROOT}`);
  if (live.cumulativeTotalEntitlementACF !== 0n) {
    notVirgin.push(`latestCumulativeTotalEntitlementACF is ${live.cumulativeTotalEntitlementACF}, expected 0`);
  }
  if (live.totalClaimedACF !== 0n) {
    notVirgin.push(`totalClaimedACF is ${live.totalClaimedACF}, expected 0`);
  }
  // The baseline claims epoch 0 as its id, so epoch 0 must itself be untouched on both contracts.
  if (await reader.epochFinalized(GENESIS_CHECKPOINT_ID)) {
    notVirgin.push(`Withdrawal.epochFinalized(${GENESIS_CHECKPOINT_ID}) is true`);
  }
  if (await reader.rewardEpochFunded(GENESIS_CHECKPOINT_ID)) {
    notVirgin.push(`Treasury.rewardEpochFunded(${GENESIS_CHECKPOINT_ID}) is true`);
  }

  if (notVirgin.length > 0) {
    throw new SettlementStateError(
      "No FINALIZED settlement checkpoint exists, but the Withdrawal contract is NOT in its " +
        "virgin state, so zero is not a safe cumulative starting point:\n" +
        notVirgin.map((reason) => `  - ${reason}`).join("\n") +
        "\n\nThis means settlement history exists on chain that this database does not have. " +
        "Restore the database that matches this deployment, or point the backend at the " +
        "Withdrawal it was calculated against. Settling from zero here would publish a " +
        "cumulative total below the one already on chain and withhold entitlement users have " +
        "already earned.",
    );
  }

  logger.info("settlement genesis: chaining the first checkpoint from the zero baseline", {
    withdrawalAddress: settle.withdrawalAddress,
    chainId: settle.chainId,
  });
  return {
    checkpointId: GENESIS_CHECKPOINT_ID,
    root: ZERO_ROOT,
    publishedCumulativeTotalACF: "0",
    throughRewardEpochId: null,
    genesis: true,
  };
}

/**
 * The single canonical calculation path. Scripts and the worker both call this.
 *
 * NOTHING_TO_SETTLE consumes no reward-epoch range and allocates no checkpoint id, so the same
 * range stays reconsiderable.
 */
export async function calculateSettlementCheckpoint(
  reader: SettlementChainReader = settlementChainReader,
): Promise<CalculateOutcome> {
  const k = keys();
  const sk = stakeKey();
  const settle = settlementKey();

  // ── only one unfinalized checkpoint at a time ──────────────────────────
  // The cumulative chain is linear: each checkpoint's previous root and total come from the one
  // before it, so building ahead of an unsigned checkpoint would fork that chain.
  const latest = await RewardSettlementCheckpoint.findOne({ ...settle })
    .sort({ checkpointId: -1 });
  if (latest && AWAITING_OPERATOR.includes(latest.status as never)) {
    return { outcome: "AWAITING_OPERATOR", checkpointId: latest.checkpointId, status: latest.status };
  }

  // The latest FINALIZED checkpoint, or the zero baseline of a provably virgin deployment.
  const previous = await resolvePredecessor(reader, settle);

  // ── live-chain guard: the contract must still agree with our last checkpoint ──
  const live = await reader.liveState();
  assertInvariant(
    live.latestEpochId === previous.checkpointId,
    `Withdrawal.latestEpochId is ${live.latestEpochId}, expected ${previous.checkpointId}. ` +
      "Out-of-band settlement detected.",
  );
  assertInvariant(
    live.root === previous.root,
    `Withdrawal root is ${live.root}, expected ${previous.root}. Out-of-band root publication.`,
  );
  assertInvariant(
    live.cumulativeTotalEntitlementACF === BigInt(previous.publishedCumulativeTotalACF),
    `Withdrawal cumulative total is ${live.cumulativeTotalEntitlementACF}, expected ` +
      `${previous.publishedCumulativeTotalACF}.`,
  );
  assertInvariant(
    (await reader.treasuryWithdrawal()) === k.withdrawalAddress,
    "Treasury's configured Withdrawal address does not match this backend's configuration.",
  );

  const candidate = previous.checkpointId + 1;
  assertInvariant(
    !(await reader.epochFinalized(candidate)),
    `Withdrawal.epochFinalized(${candidate}) is already true. Investigate before settling; ` +
      "never skip to another id.",
  );
  assertInvariant(
    !(await reader.rewardEpochFunded(candidate)),
    `Treasury.rewardEpochFunded(${candidate}) is already true. Investigate before settling.`,
  );

  // ── the logical root's binding, before anything is keyed to it ─────────
  //
  // THE point at which a stale binding would do real damage. A checkpoint leaf is keyed to an
  // ADDRESS, and a published checkpoint is cumulative and permanent — so publishing the root's
  // new entitlement against a wallet the contract no longer recognizes cannot be undone later.
  //
  // Synchronized here rather than by a background watcher: rotation is rare, this is the
  // operation that depends on it, and polling would rebind at an arbitrary moment instead of
  // immediately before the write that cares.
  //
  // Any refusal aborts the checkpoint. Nothing is published, nothing is funded and nothing is
  // finalized, which is recoverable; a checkpoint published against the wrong root is not.
  await syncLogicalRootEOAFromChain(reader);

  // ── the reward-epoch range ─────────────────────────────────────────────
  const range = await settledEpochRange(sk, previous.throughRewardEpochId);

  // ── previously published population, carried forward unconditionally ───
  // The zero baseline published nobody, so there is nothing to carry. Stated structurally rather
  // than relying on the query returning nothing for a checkpoint id that was never written.
  const priorLeaves = previous.genesis
    ? []
    : await UserRewardCheckpoint.find({
        ...settle, checkpointId: previous.checkpointId,
      }).lean();
  const prior = new Map(priorLeaves.map((r) => [r.userId, r]));

  // ── earned inside the new range ────────────────────────────────────────
  const inRange = range
    ? await earnedByUser(sk, { epochId: { $in: range.epochIds } })
    : new Map<string, { selfACF: bigint; teamACF: bigint }>();

  // Candidate population: everyone already published, plus anyone who earned in the range,
  // plus anyone with earned history not yet published.
  const candidateUserIds = new Set<string>([...prior.keys(), ...inRange.keys()]);
  const everEarned = range
    ? await earnedByUser(sk, { epochId: { $lte: range.through } })
    : new Map<string, { selfACF: bigint; teamACF: bigint }>();
  for (const [userId, t] of everEarned) {
    if (t.selfACF > 0n || t.teamACF > 0n) candidateUserIds.add(userId);
  }

  const users = await User.find(
    { userId: { $in: [...candidateUserIds] } },
    { userId: 1, externalEOA: 1 },
  ).lean();
  const addressOf = new Map(users.map((u) => [u.userId, u.externalEOA ?? null]));

  // ── sanctioned identity change ─────────────────────────────────────────
  //
  // A published address is immutable, with exactly ONE exception: the permanent logical referral
  // root may be rebound to the ROOT account the contract now names, so a rotation does not jam
  // settlement forever. Everything about the exception is verified here, once, BEFORE the leaf
  // loop — so the ordinary path makes no extra chain read and keeps the original guarantee
  // untouched.
  //
  // What makes carrying the root's cumulative total onto a new address safe is that the contract
  // keeps ONE claim watermark for every ROOT EOA. `available = cumulativeInLeaf -
  // alreadyClaimed(claimant)` therefore continues across the rotation instead of restarting, and
  // the incoming address can only draw the delta above what the outgoing one already took.
  //
  // That property is VERIFIED here against the live contract rather than assumed from the source
  // tree, because the whole rebind rests on it: against a deployment that still keyed the
  // watermark per address, publishing the carried cumulative would re-pay everything already
  // drawn. The two reads below are what distinguishes the two, and both fail closed.
  const changedUserIds = [...candidateUserIds].filter((userId) => {
    const previousRow = prior.get(userId);
    const address = addressOf.get(userId) ?? null;
    return previousRow !== undefined && address !== null && address !== previousRow.externalEOA;
  });

  let sanctionedRebindUserId: string | null = null;
  if (changedUserIds.length > 0) {
    assertInvariant(
      changedUserIds.length === 1,
      `${changedUserIds.length} published users changed address (${changedUserIds.join(", ")}). ` +
        "Only the logical referral root may be rebound, and only one at a time.",
    );
    const userId = changedUserIds[0]!;
    const previousRow = prior.get(userId)!;
    const address = (addressOf.get(userId) ?? "").toLowerCase();

    const root = await findRootUser();
    assertInvariant(
      root !== null && root.userId === userId,
      `User ${userId} address changed from ${previousRow.externalEOA} to ${address}, but ${userId} ` +
        "is not the logical referral root. Published identity is immutable for every other user.",
    );
    const chainRootEOA = (await reader.currentRootEOA()).toLowerCase();
    assertInvariant(
      address === chainRootEOA,
      `The logical root ${userId} is bound to ${address}, but ACFWithdrawal.currentRootEOA() is ` +
        `${chainRootEOA}. Refusing to publish a root leaf the contract does not recognize.`,
    );
    // Both addresses must be ROOT-routed as far as the contract is concerned. If the incoming one
    // were not, its reward would be paid DIRECTLY instead of through the partner splitter — the
    // exact bypass the splitter exists to prevent — and it would also be settling against its own
    // watermark rather than the shared one.
    const [newIsRoot, previousIsRoot] = await Promise.all([
      reader.isRootRewardAccount(address),
      reader.isRootRewardAccount(previousRow.externalEOA),
    ]);
    assertInvariant(
      newIsRoot,
      `ACFWithdrawal does not recognize ${address} as a ROOT reward account, so publishing root ` +
        "entitlement against it would pay it directly instead of through the splitter.",
    );
    assertInvariant(
      previousIsRoot,
      `ACFWithdrawal does not recognize the outgoing ${previousRow.externalEOA} as a ROOT reward ` +
        "account. The published history this rebind carries forward was not ROOT-routed.",
    );

    // The shared watermark, demonstrated rather than trusted: two ROOT EOAs sharing one counter
    // must report the SAME figure. They differ only if the watermark is still per-address, in
    // which case the carried cumulative would be paid out a second time.
    const claimedMap = await reader.alreadyClaimed([previousRow.externalEOA, address]);
    const drawnPrevious = claimedMap.get(previousRow.externalEOA) ?? 0n;
    const drawnNew = claimedMap.get(address) ?? 0n;
    assertInvariant(
      drawnNew === drawnPrevious,
      `ACFWithdrawal reports alreadyClaimed(${previousRow.externalEOA}) = ${drawnPrevious} but ` +
        `alreadyClaimed(${address}) = ${drawnNew}. Two ROOT accounts must share one claim ` +
        "watermark; because they do not, carrying the root's cumulative entitlement onto " +
        `${address} would release ${drawnPrevious} ACF a second time.`,
    );
    sanctionedRebindUserId = userId;
    logger.warn(
      `settlement: logical root ${userId} rebound ${previousRow.externalEOA} -> ${address}; ` +
        `shared ROOT claim watermark ${drawnNew} ACF carries forward, future root entitlement ` +
        "publishes against the new address, and nothing historical is rewritten.",
    );
  }

  // ── build the leaf set ─────────────────────────────────────────────────
  const leaves: SettlementLeaf[] = [];
  const userRows: Record<string, unknown>[] = [];
  const newlyPublished: string[] = [];
  let totalNewSelf = 0n;
  let totalNewTeam = 0n;
  let totalDeferredSelf = 0n;
  let totalDeferredTeam = 0n;
  const seenAddresses = new Map<string, string>();

  for (const userId of [...candidateUserIds].sort()) {
    const previousRow = prior.get(userId);
    const address = addressOf.get(userId) ?? null;
    const ranged = inRange.get(userId) ?? { selfACF: 0n, teamACF: 0n };

    // `externalEOA` is required and immutable on every user, so an absent address here means the
    // user record is gone. Fail rather than skip: skipping would silently withhold entitlement.
    assertInvariant(
      address !== null,
      `User ${userId} has reward entitlement but no user record to publish it against.`,
    );

    if (previousRow) {
      // Identity is immutable once published: migrating entitlement to a different address would
      // hand one user's money to another. The single exception was fully validated above.
      assertInvariant(
        address === previousRow.externalEOA || sanctionedRebindUserId === userId,
        `User ${userId} address changed from ${previousRow.externalEOA} to ${address}.`,
      );
    }

    const prevSelf = previousRow ? BigInt(previousRow.cumulativeSelfACF) : 0n;
    const prevTeam = previousRow ? BigInt(previousRow.cumulativeTeamACF) : 0n;

    let cumSelf: bigint;
    let cumTeam: bigint;
    let deferredSelf = 0n;
    let deferredTeam = 0n;

    if (previousRow) {
      cumSelf = prevSelf + ranged.selfACF;
      cumTeam = prevTeam + ranged.teamACF;
    } else {
      // First publication: release EVERYTHING earned through the range end. Deferral is
      // structurally impossible now — a user has a claimable address from registration — so this
      // is expected to equal the ranged figures, and the invariant below proves it rather than
      // assuming it.
      const lifetime = everEarned.get(userId) ?? { selfACF: 0n, teamACF: 0n };
      cumSelf = lifetime.selfACF;
      cumTeam = lifetime.teamACF;
      deferredSelf = cumSelf - ranged.selfACF;
      deferredTeam = cumTeam - ranged.teamACF;
      assertInvariant(
        deferredSelf >= 0n && deferredTeam >= 0n,
        `User ${userId} has negative deferred entitlement; lifetime is below range earnings.`,
      );
      if (cumSelf + cumTeam === 0n) continue;          // nothing to publish
      newlyPublished.push(userId);
    }

    const addressLower = address!.toLowerCase();
    const clash = seenAddresses.get(addressLower);
    assertInvariant(
      clash === undefined,
      `Users ${clash} and ${userId} share the address ${addressLower}.`,
    );
    seenAddresses.set(addressLower, userId);

    const leaf: SettlementLeaf = {
      externalEOA: addressLower,
      cumulativeSelfACF: cumSelf,
      cumulativeTeamACF: cumTeam,
    };
    leaves.push(leaf);

    totalNewSelf += ranged.selfACF;
    totalNewTeam += ranged.teamACF;
    totalDeferredSelf += deferredSelf;
    totalDeferredTeam += deferredTeam;

    userRows.push({
      ...settle, checkpointId: candidate, userId, externalEOA: addressLower,
      newSelfACF: ranged.selfACF.toString(),
      newTeamACF: ranged.teamACF.toString(),
      deferredReleasedSelfACF: deferredSelf.toString(),
      deferredReleasedTeamACF: deferredTeam.toString(),
      cumulativeSelfACF: cumSelf.toString(),
      cumulativeTeamACF: cumTeam.toString(),
      combinedCumulativeACF: (cumSelf + cumTeam).toString(),
      leafHash: leafHash(leaf).toLowerCase(),
    });
  }

  if (leaves.length === 0) {
    return { outcome: "NOTHING_TO_SETTLE", reason: "No publishable leaf." };
  }

  // ── tree, totals and the two independent delta computations ───────────
  const tree = buildSettlementTree(leaves);
  const previousTotal = BigInt(previous.publishedCumulativeTotalACF);
  const newTotal = tree.publishedCumulativeTotalACF;
  const delta = newTotal - previousTotal;

  assertInvariant(
    newTotal >= previousTotal,
    `Published total would decrease from ${previousTotal} to ${newTotal}; the contract forbids it.`,
  );

  // Cross-check: the aggregate delta must equal the sum of per-user increases.
  let perUserDelta = 0n;
  for (const row of userRows) {
    const userId = row.userId as string;
    const previousRow = prior.get(userId);
    const was = previousRow
      ? BigInt(previousRow.cumulativeSelfACF) + BigInt(previousRow.cumulativeTeamACF)
      : 0n;
    perUserDelta += BigInt(row.combinedCumulativeACF as string) - was;
  }
  assertInvariant(
    delta === perUserDelta,
    `Delta disagreement: total difference ${delta} vs per-user sum ${perUserDelta}.`,
  );
  assertInvariant(
    tree.leafCount === userRows.length,
    `Leaf count ${tree.leafCount} does not match ${userRows.length} user rows.`,
  );

  if (delta === 0n) {
    // fundRewardEpoch rejects a zero amount, so a checkpoint here could never be finalized
    // on chain — and persisting one would be a permanent lie about settled state.
    return {
      outcome: "NOTHING_TO_SETTLE",
      reason: "Published delta is zero; no on-chain checkpoint is needed.",
    };
  }

  // ── Self components: published exactly once, at first representation ───
  const componentScope = range
    ? (newlyPublished.length > 0
        ? { epochId: { $lte: range.through } }       // newcomers need their whole history
        : { epochId: { $in: range.epochIds } })
    : null;
  let components: SelfComponent[] = [];
  if (componentScope) {
    const published = new Set(leaves.map((l) => l.externalEOA));
    const publishedUserIds = userRows.map((r) => r.userId as string);
    const all = await selfComponents(sk, componentScope, publishedUserIds);
    const existing = await CheckpointSelfComponent.find(
      { chainId: k.chainId, stakingContractAddress: k.stakingContractAddress,
        withdrawalAddress: k.withdrawalAddress },
      { stakeId: 1, rewardEpochId: 1 },
    ).lean();
    const already = new Set(existing.map((e) => `${e.stakeId}:${e.rewardEpochId}`));
    components = all.filter(
      (c) => !already.has(`${c.stakeId}:${c.rewardEpochId}`)
        && published.has((addressOf.get(c.userId) ?? "").toLowerCase()),
    );
  }

  // ── persist: checkpoint first (so a crash leaves a CALCULATING record) ─
  await RewardSettlementCheckpoint.findOneAndUpdate(
    { ...settle, checkpointId: candidate },
    {
      $set: {
        status: "CALCULATING",
        leaseExpiresAt: new Date(Date.now() + config.settlementLeaseMs),
      },
      $setOnInsert: {
        ...k, checkpointId: candidate, legacy: false,
        fromRewardEpochId: range?.from ?? null,
        throughRewardEpochId: range?.through ?? previous.throughRewardEpochId,
        // Null on the first checkpoint of a deployment: the zero baseline is derived state, not a
        // document, so there is no predecessor id to point at.
        previousCheckpointId: previous.genesis ? null : previous.checkpointId,
        root: tree.root,
        publishedCumulativeTotalACF: newTotal.toString(),
        publishedDeltaACF: delta.toString(),
        leafCount: tree.leafCount,
        totalNewSelfACF: totalNewSelf.toString(),
        totalNewTeamACF: totalNewTeam.toString(),
        totalDeferredReleasedSelfACF: totalDeferredSelf.toString(),
        totalDeferredReleasedTeamACF: totalDeferredTeam.toString(),
      },
      $inc: { attempts: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await persistAndVerify(
    "UserRewardCheckpoint", UserRewardCheckpoint, { ...settle, checkpointId: candidate },
    userRows,
    (row) => (row as { userId: string }).userId,
    [
      "externalEOA", "newSelfACF", "newTeamACF",
      "deferredReleasedSelfACF", "deferredReleasedTeamACF",
      "cumulativeSelfACF", "cumulativeTeamACF", "combinedCumulativeACF", "leafHash",
    ],
  );

  if (components.length > 0) {
    const componentRows = components.map((c) => ({
      chainId: k.chainId,
      stakingContractAddress: k.stakingContractAddress,
      withdrawalAddress: k.withdrawalAddress,
      checkpointId: candidate,
      userId: c.userId,
      externalEOA: (addressOf.get(c.userId) ?? "").toLowerCase(),
      stakeId: c.stakeId,
      source: c.source,
      rewardEpochId: c.rewardEpochId,
      rewardACF: c.rewardACF.toString(),
    }));
    await persistAndVerify(
      "CheckpointSelfComponent", CheckpointSelfComponent,
      { chainId: k.chainId, stakingContractAddress: k.stakingContractAddress,
        withdrawalAddress: k.withdrawalAddress, checkpointId: candidate },
      componentRows,
      (row) => {
        const r = row as { stakeId: string; rewardEpochId: number };
        return `${r.stakeId}:${r.rewardEpochId}`;
      },
      ["userId", "externalEOA", "source", "rewardACF"],
    );
  }

  // Re-verify the stored checkpoint matches what we just computed, then publish the status.
  const stored = await RewardSettlementCheckpoint.findOne({ ...settle, checkpointId: candidate });
  assertInvariant(
    stored!.root === tree.root
      && stored!.publishedCumulativeTotalACF === newTotal.toString()
      && stored!.publishedDeltaACF === delta.toString()
      && stored!.leafCount === tree.leafCount,
    `Stored checkpoint ${candidate} diverges from the recomputed values; refusing to publish it.`,
  );

  await RewardSettlementCheckpoint.updateOne(
    { ...settle, checkpointId: candidate },
    { $set: { status: "CALCULATED", leaseExpiresAt: null, lastError: null } },
  );

  logger.info("settlement checkpoint calculated", {
    checkpointId: candidate, leafCount: tree.leafCount,
    publishedDeltaACF: delta.toString(), components: components.length,
  });

  return {
    outcome: "CALCULATED",
    checkpointId: candidate,
    root: tree.root,
    leafCount: tree.leafCount,
    publishedCumulativeTotalACF: newTotal.toString(),
    publishedDeltaACF: delta.toString(),
    fromRewardEpochId: range?.from ?? 0,
    throughRewardEpochId: range?.through ?? 0,
  };
}
