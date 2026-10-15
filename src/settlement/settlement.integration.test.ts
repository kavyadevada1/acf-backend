import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import {
  assertDisposable, fakeChain, TEST_ROOT_EOA, TEST_STAKING, TEST_WITHDRAWAL, TEST_TREASURY,
} from "./testenv.ts";

const TEST_URI = process.env.MONGODB_TEST_URI;

const { calculateSettlementCheckpoint, SettlementStateError } = await import("./checkpoint.js");
const { buildSettlementTree } = await import("./merkle.js");
const { reconcileClaimStates, reconcileSettlementCheckpoint, ClaimReconciliationError } =
  await import("./reconcile.js");
const { claimedSelfACFForStake } = await import("./claims.js");
const { buildClaimProof, __clearProofCache } = await import("./proof.js");
const { getRewardSummary } = await import("./summary.js");
const { buildManifest } = await import("./manifest.js");
const { SettlementInvariantError, ZERO_ROOT } = await import("./policy.js");
const { User } = await import("../models/User.js");
const { Stake } = await import("../models/Stake.js");
const { StakeRewardEntry } = await import("../models/StakeRewardEntry.js");
const { TeamRewardEntry } = await import("../models/TeamRewardEntry.js");
const { RewardEpoch } = await import("../models/RewardEpoch.js");
const { RewardPhase2Epoch } = await import("../models/RewardPhase2Epoch.js");
const { RewardSettlementCheckpoint } = await import("../models/RewardSettlementCheckpoint.js");
const { UserRewardCheckpoint } = await import("../models/UserRewardCheckpoint.js");
const { CheckpointSelfComponent } = await import("../models/CheckpointSelfComponent.js");
const { UserClaimState } = await import("../models/UserClaimState.js");
const { RewardClaim } = await import("../models/RewardClaim.js");

const E18 = 10n ** 18n;
const LOW = TEST_STAKING.toLowerCase();
const WD = TEST_WITHDRAWAL.toLowerCase();
const SK = { chainId: 80002, stakingContractAddress: LOW };
const SETTLE = { chainId: 80002, withdrawalAddress: WD };

/**
 * A synthetic already-settled checkpoint, used by every suite that needs a predecessor.
 *
 * Replaces the old legacy-seed fixture, which pinned the suite to one obsolete deployment's
 * epoch id, root, claimant and amount. The values here are arbitrary; only the ROOT is real,
 * rebuilt from the leaf so proof generation against this checkpoint behaves exactly as it does
 * against a calculated one.
 */
const BASELINE_ID = 1_000;
const BASELINE_ACF = 5n * E18;
const NEXT = BASELINE_ID + 1;

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([
    User.init(), Stake.init(), StakeRewardEntry.init(), TeamRewardEntry.init(),
    RewardEpoch.init(), RewardPhase2Epoch.init(), RewardSettlementCheckpoint.init(),
    UserRewardCheckpoint.init(), CheckpointSelfComponent.init(), UserClaimState.init(),
    RewardClaim.init(),
  ]);
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (connected) await Promise.all([
    User.deleteMany({}), Stake.deleteMany({}), StakeRewardEntry.deleteMany({}),
    TeamRewardEntry.deleteMany({}), RewardEpoch.deleteMany({}), RewardPhase2Epoch.deleteMany({}),
    RewardSettlementCheckpoint.deleteMany({}), UserRewardCheckpoint.deleteMany({}),
    CheckpointSelfComponent.deleteMany({}), UserClaimState.deleteMany({}),
    RewardClaim.deleteMany({}),
  ]);
  seq = 0;
  __clearProofCache();
});

let seq = 0;
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

/** The baseline's claimant and its REAL root, rebuilt from the single leaf. */
const BASELINE_EOA = wallet(0xba5e).toLowerCase();
const BASELINE_ROOT = buildSettlementTree([{
  externalEOA: BASELINE_EOA, cumulativeSelfACF: BASELINE_ACF, cumulativeTeamACF: 0n,
}]).root;

const mkUser = async (userId: string, parent: string | null, walletAddr?: string) => {
  seq += 1;
  await User.collection.insertOne({
    userId,
    externalEOA: userId === "root" ? TEST_ROOT_EOA : `0x${seq.toString(16).padStart(40, "a")}`,
    referralCode: `ACF-${userId.toUpperCase()}`,
    referredByUserId: parent,
    ...(walletAddr ? { externalEOA: walletAddr.toLowerCase() } : {}),
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);
};

/** Marks a reward epoch settled by both upstream phases. */
const settleEpoch = async (epochId: number) => {
  await RewardEpoch.collection.insertOne({
    ...SK, epochId, windowStart: epochId * 43200 - 43200, snapshotAt: epochId * 43200,
    status: "CALCULATED", attempts: 1, snapshotBlockNumber: epochId * 43200,
    priceE18: E18.toString(), poolROISnapshot: [],
    stakesProcessed: 0, stakesRewarded: 0, totalRegularSelfACF: "0", totalDAOStakeACF: "0",
  } as never);
  await RewardPhase2Epoch.collection.insertOne({
    ...SK, epochId, status: "CALCULATED", attempts: 1,
    snapshotAt: epochId * 43200, priceE18: E18.toString(),
  } as never);
};

/** A Phase 1 Self reward for one stake in one epoch. */
const mkSelf = async (
  userId: string, walletAddr: string, stakeId: string, epochId: number, amount: bigint,
) => {
  await StakeRewardEntry.collection.insertOne({
    ...SK, stakeId, epochId, userId, externalEOA: walletAddr.toLowerCase(),
    source: "DIRECT", poolId: 1, principalACF: (1000n * E18).toString(),
    compoundBaseACF: (1000n * E18).toString(), rewardACF: amount.toString(),
    cumulativeEarnedACF: "0", rateApplied: "2500", rateDenominator: "1000000",
    rewardEligible: true, ineligibleReason: null, snapshotAt: epochId * 43200,
  } as never);
};

/** A Phase 2 Team reward. */
const mkTeam = async (userId: string, epochId: number, amount: bigint) => {
  await TeamRewardEntry.collection.insertOne({
    ...SK, epochId, userId,
    levelRewardACF: amount.toString(), rankRewardACF: "0", globalRewardACF: "0",
    teamRewardACF: amount.toString(),
    levelAudit: { unlockedLevels: 1, directCount: 1, perLevel: [] },
    rankAudit: {
      leaderRank: 0, leaderRateE6: "0", highestDownlineRank: 0, highestDownlineRateE6: "0",
      differentialRateE6: "0", teamRewardBaseACF: "0", grossACF: "0", epochCapUSD6: "0",
      capped: false,
    },
    globalAudit: {
      rankNumber: 0, selfStakeACF: "0", selfStakeUSD6: "0", l1StakeACF: "0", l1StakeUSD6: "0",
      networkContributionACF: "0", networkContributionUSD6: "0", priceE18: E18.toString(),
    },
  } as never);
};

/**
 * Installs the synthetic FINALIZED predecessor plus a fake chain that agrees with it.
 *
 * Written directly rather than calculated, so the suites below start from a known cumulative
 * state without first having to settle one. The baseline user is fully claimed, which is what
 * the carry-forward and component-retirement cases need.
 */
const seedBaseline = async () => {
  const eoa = BASELINE_EOA;
  await mkUser("baseline", null, eoa);
  const tree = { root: BASELINE_ROOT };         // single leaf: the root IS the leaf hash
  await RewardSettlementCheckpoint.collection.insertOne({
    chainId: 80002, stakingContractAddress: LOW, withdrawalAddress: WD,
    treasuryAddress: TEST_TREASURY.toLowerCase(),
    checkpointId: BASELINE_ID, legacy: false, status: "FINALIZED",
    fromRewardEpochId: null, throughRewardEpochId: null, previousCheckpointId: null,
    root: tree.root,
    publishedCumulativeTotalACF: BASELINE_ACF.toString(),
    publishedDeltaACF: BASELINE_ACF.toString(),
    leafCount: 1,
    totalNewSelfACF: BASELINE_ACF.toString(), totalNewTeamACF: "0",
    totalDeferredReleasedSelfACF: "0", totalDeferredReleasedTeamACF: "0",
    attempts: 1, leaseExpiresAt: null, lastError: null, auditWarning: null,
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);
  await UserRewardCheckpoint.collection.insertOne({
    ...SETTLE, checkpointId: BASELINE_ID, userId: "baseline", externalEOA: eoa.toLowerCase(),
    newSelfACF: BASELINE_ACF.toString(), newTeamACF: "0",
    deferredReleasedSelfACF: "0", deferredReleasedTeamACF: "0",
    cumulativeSelfACF: BASELINE_ACF.toString(), cumulativeTeamACF: "0",
    combinedCumulativeACF: BASELINE_ACF.toString(), leafHash: tree.root,
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);
  await UserClaimState.collection.insertOne({
    ...SETTLE, userId: "baseline", externalEOA: eoa.toLowerCase(),
    alreadyClaimedACF: BASELINE_ACF.toString(),
    highestClaimedCheckpointId: BASELINE_ID,
    lastReconciledBlock: null, lastReconciledAt: new Date(1),
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);
  const chain = fakeChain({
    root: tree.root, cumulativeTotal: BASELINE_ACF, totalClaimed: BASELINE_ACF,
    latestEpochId: BASELINE_ID, finalized: new Set([BASELINE_ID]),
    funded: new Set([BASELINE_ID]),
    claimed: new Map([[eoa.toLowerCase(), BASELINE_ACF]]),
  });
  return { chain, eoa, root: tree.root };
};

// ═════════════════════════════════════════════════════════ GENESIS ════

/**
 * The fresh-launch path.
 *
 * A brand-new deployment has no FINALIZED checkpoint to chain from, and the obsolete seeder that
 * used to provide the first one was pinned to a superseded Withdrawal's state. The cumulative
 * chain now starts from the ZERO BASELINE the virgin contract already reports — but only when
 * the contract proves it is virgin, because an empty database is equally consistent with a
 * dropped database in front of a contract that already holds a published root.
 */
describe("settlement genesis on a fresh deployment", () => {
  /** One user with one Team reward, the smallest thing that can be settled. */
  const entitled = async (amount = 9n * E18, epochId = 41010) => {
    await mkUser("alice", null, wallet(0xa11ce));
    await settleEpoch(epochId);
    await mkTeam("alice", epochId, amount);
  };

  it("1. a virgin Withdrawal plus an empty database settles from zero", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await entitled();
    const chain = fakeChain();                       // defaults ARE the virgin state
    const r = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(r.outcome, "CALCULATED");
    assert.equal(r.outcome === "CALCULATED" && r.checkpointId, 1,
      "the first real checkpoint is 1; the baseline occupies 0 and is never stored");
  });

  it("2. the first checkpoint records no predecessor document", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await entitled();
    await calculateSettlementCheckpoint(fakeChain().reader);
    const cp = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: 1 }))!;
    assert.equal(cp.previousCheckpointId, null);
    assert.equal(cp.legacy, false);
    assert.equal(await RewardSettlementCheckpoint.countDocuments({}), 1,
      "exactly one checkpoint: the real one. No genesis row was written.");
  });

  it("3. the baseline creates no leaf, no entitlement and no claim state", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await entitled();
    await calculateSettlementCheckpoint(fakeChain().reader);
    // Every published row belongs to checkpoint 1 and to a real user.
    assert.equal(await UserRewardCheckpoint.countDocuments({ checkpointId: 0 }), 0);
    assert.equal(await RewardSettlementCheckpoint.countDocuments({ checkpointId: 0 }), 0);
    const rows = await UserRewardCheckpoint.find({ ...SETTLE }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.userId, "alice");
    assert.equal(await UserClaimState.countDocuments({}), 0, "nothing claimed yet");
  });

  it("4. the first published delta IS the first cumulative entitlement", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await entitled(9n * E18);
    const r = await calculateSettlementCheckpoint(fakeChain().reader);
    assert.equal(r.outcome, "CALCULATED");
    if (r.outcome !== "CALCULATED") return;
    assert.equal(r.publishedCumulativeTotalACF, (9n * E18).toString());
    assert.equal(r.publishedDeltaACF, (9n * E18).toString(),
      "predecessor total was zero, so the whole entitlement must be funded");
    assert.equal(r.leafCount, 1);
  });

  it("5. the root is the real tree of real users only", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await entitled(9n * E18);
    const r = await calculateSettlementCheckpoint(fakeChain().reader);
    assert.equal(r.outcome, "CALCULATED");
    if (r.outcome !== "CALCULATED") return;
    const expected = buildSettlementTree([{
      externalEOA: wallet(0xa11ce).toLowerCase(),
      cumulativeSelfACF: 0n,
      cumulativeTeamACF: 9n * E18,
    }]);
    assert.equal(r.root, expected.root, "no baseline leaf is mixed into the tree");
    assert.notEqual(r.root, ZERO_ROOT);
  });

  it("6. the SECOND settlement chains from the first real checkpoint, as before", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await entitled(9n * E18, 41010);
    const chain = fakeChain();
    await calculateSettlementCheckpoint(chain.reader);
    const first = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: 1 }))!;
    chain.settle(1, first.root, BigInt(first.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);

    await settleEpoch(41011);
    await mkTeam("alice", 41011, 4n * E18);
    const second = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(second.outcome, "CALCULATED");
    if (second.outcome !== "CALCULATED") return;
    assert.equal(second.checkpointId, 2);
    assert.equal(second.publishedCumulativeTotalACF, (13n * E18).toString());
    assert.equal(second.publishedDeltaACF, (4n * E18).toString(), "only the new reward");
    const cp2 = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: 2 }))!;
    assert.equal(cp2.previousCheckpointId, 1, "normal chaining resumes immediately");
  });

  it("7. a claim proof is generated against the first real checkpoint", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await entitled(9n * E18);
    const chain = fakeChain();
    await calculateSettlementCheckpoint(chain.reader);
    const cp = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: 1 }))!;
    chain.settle(1, cp.root, BigInt(cp.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);

    const proof = await buildClaimProof("alice", chain.reader);
    assert.equal(proof.status, "CLAIMABLE");
    if (proof.status !== "CLAIMABLE") return;
    assert.equal(proof.checkpointId, 1);
    assert.equal(proof.cumulativeTeamACF, (9n * E18).toString());
    assert.equal(proof.alreadyClaimedACF, "0");
    assert.deepEqual(proof.proof, [], "single-leaf tree: the root is the leaf");
  });

  it("8. an existing FINALIZED checkpoint is used, with no genesis attempt", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010);
    await mkTeam("bob", 41010, 7n * E18);
    const r = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(r.outcome, "CALCULATED");
    if (r.outcome !== "CALCULATED") return;
    assert.equal(r.checkpointId, NEXT, "chains from the baseline, not from zero");
    const cp = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT }))!;
    assert.equal(cp.previousCheckpointId, BASELINE_ID);
  });

  // ── fail-closed: an empty database never overrides what the chain says ──
  for (const [label, patch] of [
    ["an epoch has been finalized", { latestEpochId: 7 }],
    ["a root has been published", { root: `0x${"b".repeat(64)}` }],
    ["entitlement is already published", { cumulativeTotal: 5n * E18 }],
    ["reward has already been claimed", { totalClaimed: 1n * E18 }],
    ["epoch 0 is finalized on the Withdrawal", { finalized: new Set([0]) }],
    ["epoch 0 is funded on the Treasury", { funded: new Set([0]) }],
  ] as const) {
    it(`9-${label}. refuses to settle from zero`, async (t) => {
      if (!connected) return t.skip("no MONGODB_TEST_URI");
      await entitled();
      await assert.rejects(
        calculateSettlementCheckpoint(fakeChain(patch).reader),
        (e: unknown) => e instanceof SettlementStateError
          && /NOT in its virgin state/.test((e as Error).message),
      );
      assert.equal(await RewardSettlementCheckpoint.countDocuments({}), 0, "nothing written");
      assert.equal(await UserRewardCheckpoint.countDocuments({}), 0);
    });
  }

  it("10. the refusal names the live value, and never an obsolete seed command", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await entitled();
    await assert.rejects(
      calculateSettlementCheckpoint(fakeChain({ latestEpochId: 7 }).reader),
      (e: unknown) => {
        const m = (e as Error).message;
        assert.match(m, /latestEpochId is 7, expected 0/);
        assert.doesNotMatch(m, /seed-legacy|seed the legacy/i);
        return true;
      },
    );
  });

  it("11. repeated calculation is idempotent: one checkpoint, no second baseline", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await entitled();
    const chain = fakeChain();
    const first = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(first.outcome, "CALCULATED");
    // The checkpoint is now CALCULATING/CALCULATED and awaits the operator, so a rerun must not
    // allocate a second id or write a second baseline.
    const again = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(again.outcome, "AWAITING_OPERATOR");
    assert.equal(await RewardSettlementCheckpoint.countDocuments({}), 1);
    assert.equal(await UserRewardCheckpoint.countDocuments({}), 1);
  });

  it("12. concurrent first calculations cannot create two checkpoints", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await entitled();
    const chain = fakeChain();
    // Both resolve the same zero baseline and both target checkpoint 1. The unique index on
    // (chainId, withdrawalAddress, checkpointId) is what makes that safe — and because the
    // baseline is derived rather than stored, there is no genesis document to race over.
    const results = await Promise.allSettled([
      calculateSettlementCheckpoint(chain.reader),
      calculateSettlementCheckpoint(chain.reader),
    ]);
    assert.ok(results.some((r) => r.status === "fulfilled"), "at least one must succeed");
    assert.equal(await RewardSettlementCheckpoint.countDocuments({}), 1);
    assert.equal(await RewardSettlementCheckpoint.countDocuments({ checkpointId: 1 }), 1);
    assert.equal(await UserRewardCheckpoint.countDocuments({}), 1);
  });

  it("13. genesis needs no hardcoded claimant, epoch id or root", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const source = await readFile(new URL("./checkpoint.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /1790792573|1_790_792_573/, "no obsolete epoch id");
    assert.doesNotMatch(source, /0x7c2d6b5f/i, "no obsolete claimant");
    assert.doesNotMatch(source, /0x0f5e4a1e/i, "no obsolete root");
    assert.doesNotMatch(source, /seed-legacy/i, "no obsolete operator command");
    // The only constant the baseline needs is the zero root itself.
    assert.equal(ZERO_ROOT, `0x${"0".repeat(64)}`);
  });

  it("14. the operator manifest for the first checkpoint names the zero baseline", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await entitled(9n * E18);
    await calculateSettlementCheckpoint(fakeChain().reader);
    // The executor refuses to spend gas without a manifest, so the FIRST checkpoint must be
    // able to produce one even though it has no predecessor document.
    const m = await buildManifest(1);
    assert.equal(m.manifest.checkpointId, 1);
    assert.equal(m.manifest.previousCheckpointId, null);
    assert.equal(m.manifest.previousRoot, ZERO_ROOT);
    assert.equal(m.manifest.previousPublishedCumulativeTotalACF, "0");
    assert.equal(m.manifest.publishedDeltaACF, (9n * E18).toString());
    // And a virgin chain satisfies exactly what that manifest claims the previous state was.
    const live = await fakeChain().reader.liveState();
    assert.equal(live.root, m.manifest.previousRoot);
    assert.equal(live.cumulativeTotalEntitlementACF,
      BigInt(m.manifest.previousPublishedCumulativeTotalACF));
  });

  it("15. the executor's epoch-id guard stays null-safe for the first checkpoint", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // preflight() reads the Treasury balance over the real RPC, so the guard is asserted at
    // source level instead. Without this condition the first checkpoint of every deployment
    // would be blocked by a comparison against a predecessor that does not exist.
    const source = await readFile(new URL("./executor.ts", import.meta.url), "utf8");
    assert.match(source, /manifest\.previousCheckpointId !== null\s*\n?\s*&&\s*live\.latestEpochId !== manifest\.previousCheckpointId/);
  });

  it("16. the retired seeder and its command are gone", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Indirect specifier on purpose: a literal would make `tsc` resolve a module this test
    // exists to prove is absent, turning a passing assertion into a compile error.
    const retired = "./legacy.js";
    await assert.rejects(
      import(retired),
      "settlement/legacy.ts must not exist: it could only ever target the old deployment",
    );
    const pkg = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts["settlement:seed-legacy"], undefined);
    const cli = await readFile(new URL("../../scripts/run-settlement.ts", import.meta.url), "utf8");
    assert.doesNotMatch(cli, /seed-legacy/);
  });
});

// ════════════════════════════════════════════ DEFERRED ENTITLEMENT ════

describe("deferred entitlement", () => {
  /**
   * Deferral no longer arises from a missing wallet — every user has a claimable address from
   * registration. What can still defer entitlement is LATE ARRIVAL: Phase 2 writing a Team
   * reward row for an epoch range a finalized checkpoint has already consumed. The first leaf
   * that does include the user must then carry their whole history, not just the current range.
   */
  const scenario = async () => {
    const { chain } = await seedBaseline();
    await mkUser("alice", "baseline", wallet(0xa11ce));
    return chain;
  };

  it("8. an earner is publishable immediately, with nothing deferred", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const chain = await scenario();
    await settleEpoch(41010);
    await mkTeam("alice", 41010, 10n * E18);

    const r = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(r.outcome, "CALCULATED", "there is no onboarding step to wait for");
    const row = (await UserRewardCheckpoint.findOne({
      ...SETTLE, checkpointId: NEXT, userId: "alice",
    }))!;
    assert.equal(row.cumulativeTeamACF, (10n * E18).toString());
    assert.equal(row.newTeamACF, (10n * E18).toString(), "all of it earned inside this range");
    assert.equal(row.deferredReleasedTeamACF, "0", "so nothing was deferred");
    assert.equal(row.deferredReleasedSelfACF, "0");

    // Earned is reported at once. `published` tracks the latest FINALIZED root, and this
    // checkpoint is only CALCULATED, so it is still zero here — see test 12 for the finalized case.
    const summary = await getRewardSummary("alice");
    assert.equal(summary.earnedTeamACF, (10n * E18).toString());
    assert.equal(summary.publishedTeamACF, "0", "not yet finalized on chain");
  });

  /**
   * Epochs 41010-41011 are consumed by a REAL checkpoint driven by Bob, and Alice's rows for
   * those epochs are written only AFTERWARDS. When the next checkpoint runs, only 41012 is in
   * range — which is what makes her earlier 30 ACF genuinely deferred rather than merely late.
   */
  const deferredFixture = async () => {
    const chain = await scenario();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010); await mkTeam("bob", 41010, 1n * E18);
    await settleEpoch(41011);

    // Checkpoint 1: Bob is the only earner on record, so Alice gets no leaf.
    const first = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(first.outcome, "CALCULATED");
    assert.equal(await UserRewardCheckpoint.countDocuments({
      ...SETTLE, checkpointId: NEXT, userId: "alice",
    }), 0, "Alice had earned nothing yet, so no leaf");
    const cp1 = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT }))!;
    chain.settle(NEXT, cp1.root, BigInt(cp1.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);

    // Alice's entitlement for the CONSUMED range arrives late, then 41012 earns 5 in range.
    await mkTeam("alice", 41010, 10n * E18);
    await mkTeam("alice", 41011, 20n * E18);
    await settleEpoch(41012); await mkTeam("alice", 41012, 5n * E18);
    return { chain, previousTotal: BigInt(cp1.publishedCumulativeTotalACF) };
  };

  it("9. THE FIXTURE — 10 + 20 arriving late, then 5 in range, publishes 35", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await deferredFixture();

    const r = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(r.outcome, "CALCULATED");

    const row = (await UserRewardCheckpoint.findOne({
      ...SETTLE, checkpointId: NEXT + 1, userId: "alice",
    }))!;
    assert.equal(row.cumulativeTeamACF, (35n * E18).toString(), "ALL earned, not just 5");
    assert.equal(row.newTeamACF, (5n * E18).toString(), "earned inside this range");
    assert.equal(row.deferredReleasedTeamACF, (30n * E18).toString(), "released from the consumed range");
    assert.equal(row.deferredReleasedSelfACF, "0", "Self is never deferred: a stake is published with its owner");
    assert.equal(row.combinedCumulativeACF, (35n * E18).toString());
  });

  it("10. the funding delta is the PUBLISHED delta, including the deferred 30", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, previousTotal } = await deferredFixture();

    const r = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(r.outcome, "CALCULATED");
    // Earned inside the range is 5. Published liability rises by 35, because Alice's first
    // leaf carries her whole history. Funding the EARNED delta would under-fund by 30 and
    // finalizeEpoch would revert on backing.
    assert.equal(r.publishedDeltaACF, (35n * E18).toString());
    assert.equal(
      BigInt(r.publishedCumulativeTotalACF) - previousTotal, 35n * E18,
      "the published total rises by exactly the published delta",
    );
  });

  it("11. a user who earned nothing is simply absent, and blocks nobody", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const chain = await scenario();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010);
    await mkTeam("bob", 41010, 7n * E18);                 // the only earner

    const r = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(r.outcome, "CALCULATED");
    assert.ok(await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT, userId: "bob" }));
    // Alice is left out because she earned nothing, not because she is waiting on anything.
    assert.equal(await UserRewardCheckpoint.countDocuments({
      ...SETTLE, checkpointId: NEXT, userId: "alice",
    }), 0);
    const summary = await getRewardSummary("alice");
    assert.equal(summary.status, "NOTHING_TO_CLAIM");
    assert.equal(summary.earnedTeamACF, "0");
  });
});

// ════════════════════════════════════════════ CARRY-FORWARD ════

describe("root membership carry-forward", () => {
  /** Legacy + one published user, with the chain advanced as the operator would. */
  const published = async () => {
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010);
    await mkTeam("bob", 41010, 7n * E18);
    const first = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(first.outcome, "CALCULATED");
    const cp = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT }))!;
    chain.settle(NEXT, cp.root, BigInt(cp.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);
    return chain;
  };

  it("12. a user with zero new reward is still carried into the next root", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const chain = await published();
    // A second settlement driven only by a different user's reward.
    await mkUser("carol", "baseline", wallet(0xca201));
    await settleEpoch(41011);
    await mkTeam("carol", 41011, 3n * E18);

    const r = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(r.outcome, "CALCULATED");
    const bob = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT + 1, userId: "bob" }))!;
    assert.equal(bob.newTeamACF, "0", "earned nothing this time");
    assert.equal(bob.cumulativeTeamACF, (7n * E18).toString(), "but keeps his cumulative");
    // The fully-claimed baseline user is carried too.
    assert.ok(await UserRewardCheckpoint.findOne({
      ...SETTLE, checkpointId: NEXT + 1, userId: "baseline",
    }));
    assert.equal(r.leafCount, 3);
  });

  it("13. sum of leaves equals the published cumulative total", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const chain = await published();
    const rows = await UserRewardCheckpoint.find({ ...SETTLE, checkpointId: NEXT }).lean();
    const sum = rows.reduce((s, r) => s + BigInt(r.combinedCumulativeACF), 0n);
    const cp = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT }))!;
    assert.equal(sum, BigInt(cp.publishedCumulativeTotalACF));
    void chain;
  });

  it("14. a changed address after publication FAILS the settlement", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const chain = await published();
    await User.collection.updateOne({ userId: "bob" }, { $set: { externalEOA: wallet(0xdead) } });
    await settleEpoch(41011);
    await mkTeam("bob", 41011, 1n * E18);
    await assert.rejects(calculateSettlementCheckpoint(chain.reader),
      (e: unknown) => /address changed/.test((e as Error).message));
  });

  it("15. an address that disappears after publication FAILS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const chain = await published();
    await User.collection.updateOne({ userId: "bob" }, { $unset: { externalEOA: "" } });
    await settleEpoch(41011);
    await mkTeam("bob", 41011, 1n * E18);
    await assert.rejects(calculateSettlementCheckpoint(chain.reader),
      (e: unknown) => /no user record to publish/.test((e as Error).message));
  });

  it("16. two users sharing one address FAILS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("x", "baseline", wallet(0xd0b1e));

    // User.externalEOA is uniquely indexed, so this is unreachable through normal
    // registration — the index has to be dropped to produce it. The settlement check is
    // defence in depth for corrupt data.
    await User.collection.dropIndex("externalEOA_1").catch(() => {});
    await User.collection.insertOne({
      userId: "y", externalEOA: wallet(0xd0b1e), referralCode: "ACF-Y",
      referredByUserId: "baseline",
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);
    await settleEpoch(41010);
    await mkTeam("x", 41010, 1n * E18);
    await mkTeam("y", 41010, 1n * E18);

    await assert.rejects(calculateSettlementCheckpoint(chain.reader),
      (e: unknown) => /share the address/.test((e as Error).message));
    await User.init();                       // restore the index for later cases
  });
});

// ══════════════════════════════════════ CLAIM RECONCILIATION ════

describe("claim state reconciliation", () => {
  /** Legacy + bob published and finalized, with components for his staking reward. */
  const settled = async (selfPerEpoch: Array<[number, bigint]> = []) => {
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    for (const [epochId, amount] of selfPerEpoch) {
      await settleEpoch(epochId);
      await mkSelf("bob", wallet(0xb0b), "1", epochId, amount);
    }
    if (selfPerEpoch.length === 0) {
      await settleEpoch(41010);
      await mkTeam("bob", 41010, 7n * E18);
    }
    const r = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(r.outcome, "CALCULATED");
    const cp = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT }))!;
    chain.settle(NEXT, cp.root, BigInt(cp.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);
    return { chain, cp };
  };

  it("17. alreadyClaimed of zero means nothing is claimed", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await settled();
    const r = await reconcileClaimStates(chain.reader);
    assert.ok(r.reconciled >= 1);
    const bob = (await UserClaimState.findOne({ ...SETTLE, userId: "bob" }))!;
    assert.equal(bob.alreadyClaimedACF, "0");
    assert.equal(bob.highestClaimedCheckpointId, null);
  });

  it("18. an EXACT combined match resolves the claimed checkpoint", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await settled();
    const row = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT, userId: "bob" }))!;
    chain.state.claimed.set(wallet(0xb0b).toLowerCase(), BigInt(row.combinedCumulativeACF));

    await reconcileClaimStates(chain.reader);
    const bob = (await UserClaimState.findOne({ ...SETTLE, userId: "bob" }))!;
    assert.equal(bob.alreadyClaimedACF, row.combinedCumulativeACF);
    assert.equal(bob.highestClaimedCheckpointId, NEXT);
  });

  it("19. an amount between two published totals FAILS loudly, never <=", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await settled();
    const row = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT, userId: "bob" }))!;
    // One wei off: unreachable through claim(), so it means corrupt or unknown state.
    chain.state.claimed.set(wallet(0xb0b).toLowerCase(), BigInt(row.combinedCumulativeACF) - 1n);

    await assert.rejects(reconcileClaimStates(chain.reader),
      (e: unknown) => e instanceof ClaimReconciliationError
        && /matches no finalized published cumulative total/.test((e as Error).message));
  });

  it("20. a direct claim with no receipt still advances the watermark", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await settled();
    const row = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT, userId: "bob" }))!;
    chain.state.claimed.set(wallet(0xb0b).toLowerCase(), BigInt(row.combinedCumulativeACF));

    await reconcileClaimStates(chain.reader);
    // No RewardClaim row exists, yet the financial watermark is correct.
    assert.equal(await RewardClaim.countDocuments({}), 0);
    assert.equal(
      (await UserClaimState.findOne({ ...SETTLE, userId: "bob" }))!.highestClaimedCheckpointId,
      NEXT,
    );
  });

  it("21. equal combined totals across checkpoints resolve identically", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await settled();
    // A second checkpoint where Bob earns nothing: his combined total is unchanged, so his
    // component coverage is identical and either checkpoint is a correct answer.
    await mkUser("carol", "baseline", wallet(0xca201));
    await settleEpoch(41011);
    await mkTeam("carol", 41011, 3n * E18);
    const second = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(second.outcome, "CALCULATED");
    const cp2 = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT + 1 }))!;
    chain.settle(NEXT + 1, cp2.root, BigInt(cp2.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);

    const row = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT + 1, userId: "bob" }))!;
    chain.state.claimed.set(wallet(0xb0b).toLowerCase(), BigInt(row.combinedCumulativeACF));
    await reconcileClaimStates(chain.reader);
    // The latest matching checkpoint is taken; coverage is the same either way.
    assert.equal(
      (await UserClaimState.findOne({ ...SETTLE, userId: "bob" }))!.highestClaimedCheckpointId,
      NEXT + 1,
    );
  });
});

// ══════════════════════════════════════════ COMPOUND RESET ════

describe("compound reset composition", () => {
  it("22. THE MANDATORY SCENARIO — epochs 10+11 claimed, epoch 12 still compounds", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));

    // Phase 1 rewards on one stake: 100 at epoch 41010, 105 at 41011.
    await settleEpoch(41010); await mkSelf("bob", wallet(0xb0b), "1", 41010, 100n * E18);
    await settleEpoch(41011); await mkSelf("bob", wallet(0xb0b), "1", 41011, 105n * E18);

    // Checkpoint C covers through 41011.
    const c = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(c.outcome, "CALCULATED");
    assert.equal((c as { throughRewardEpochId: number }).throughRewardEpochId, 41011);
    const cp = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT }))!;
    chain.settle(NEXT, cp.root, BigInt(cp.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);

    // Components for epochs 10 and 11 exist; nothing yet for 12.
    assert.equal(await CheckpointSelfComponent.countDocuments({ stakeId: "1" }), 2);

    // Epoch 12 earns 110 AFTER the checkpoint was built.
    await settleEpoch(41012); await mkSelf("bob", wallet(0xb0b), "1", 41012, 110n * E18);

    // Bob claims checkpoint C.
    const row = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT, userId: "bob" }))!;
    chain.state.claimed.set(wallet(0xb0b).toLowerCase(), BigInt(row.combinedCumulativeACF));
    await reconcileClaimStates(chain.reader);

    // The claim covers epochs 10 and 11 only.
    const claimed = await claimedSelfACFForStake(SK, "bob", "1", 41013);
    assert.equal(claimed, 205n * E18, "100 + 105, NOT 315 and NOT 0");

    // So for epoch 13, earned(315) − claimed(205) = 110 keeps compounding.
    const earned = 100n * E18 + 105n * E18 + 110n * E18;
    assert.equal(earned - claimed, 110n * E18);
  });

  it("23. an UNCONFIRMED claim retires nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010); await mkSelf("bob", wallet(0xb0b), "1", 41010, 100n * E18);
    const c = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(c.outcome, "CALCULATED");
    // Published but never claimed: alreadyClaimed stays zero.
    assert.equal(await claimedSelfACFForStake(SK, "bob", "1", 41011), 0n);
    void chain;
  });

  it("24. a component published AFTER the claimed checkpoint stays unclaimed", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010); await mkSelf("bob", wallet(0xb0b), "1", 41010, 100n * E18);
    const first = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(first.outcome, "CALCULATED");
    const cp1 = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT }))!;
    chain.settle(NEXT, cp1.root, BigInt(cp1.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);

    const row1 = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT, userId: "bob" }))!;
    chain.state.claimed.set(wallet(0xb0b).toLowerCase(), BigInt(row1.combinedCumulativeACF));
    await reconcileClaimStates(chain.reader);

    // A second checkpoint publishes epoch 41011's reward, but Bob has not claimed it.
    await settleEpoch(41011); await mkSelf("bob", wallet(0xb0b), "1", 41011, 50n * E18);
    const second = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(second.outcome, "CALCULATED");
    const cp2 = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT + 1 }))!;
    chain.settle(NEXT + 1, cp2.root, BigInt(cp2.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);

    // Still only the first checkpoint is claimed, so only its component is retired.
    assert.equal(await claimedSelfACFForStake(SK, "bob", "1", 41012), 100n * E18);
  });

  it("25. Team rewards never enter the compound composition", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010);
    await mkTeam("bob", 41010, 500n * E18);              // Team only, no Self
    const c = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(c.outcome, "CALCULATED");
    const cp = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT }))!;
    chain.settle(NEXT, cp.root, BigInt(cp.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);
    const row = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT, userId: "bob" }))!;
    chain.state.claimed.set(wallet(0xb0b).toLowerCase(), BigInt(row.combinedCumulativeACF));
    await reconcileClaimStates(chain.reader);

    assert.equal(await CheckpointSelfComponent.countDocuments({ userId: "bob" }), 0);
    assert.equal(await claimedSelfACFForStake(SK, "bob", "1", 41011), 0n);
  });

  it("26. the fully-claimed baseline user retires no component", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedBaseline();
    // The baseline user is already fully claimed through the baseline checkpoint.
    const cs = (await UserClaimState.findOne({ ...SETTLE, userId: "baseline" }))!;
    assert.equal(cs.highestClaimedCheckpointId, BASELINE_ID);
    assert.equal(await claimedSelfACFForStake(SK, "baseline", "1", 99_999), 0n);
  });

  it("27. each staking reward is published exactly once, never recopied", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010); await mkSelf("bob", wallet(0xb0b), "1", 41010, 100n * E18);
    const first = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(first.outcome, "CALCULATED");
    const cp1 = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT }))!;
    chain.settle(NEXT, cp1.root, BigInt(cp1.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);

    await settleEpoch(41011); await mkSelf("bob", wallet(0xb0b), "1", 41011, 50n * E18);
    await calculateSettlementCheckpoint(chain.reader);

    // Two components, one per reward epoch — the first is NOT duplicated into checkpoint 2.
    const all = await CheckpointSelfComponent.find({ stakeId: "1" }).lean();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((c) => c.rewardEpochId).sort(), [41010, 41011]);
    assert.deepEqual(all.map((c) => c.checkpointId).sort(), [NEXT, NEXT + 1]);
  });
});

// ══════════════════════════════════ CHECKPOINT GUARDS ════

describe("checkpoint guards", () => {
  it("28. a zero published delta creates NO on-chain checkpoint", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010);
    await mkTeam("bob", 41010, 0n);                     // settled, but nothing earned

    const r = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(r.outcome, "NOTHING_TO_SETTLE");
    // The range stays reconsiderable: a pending-wallet user may become publishable later with
    // no new reward epoch at all.
    assert.equal(await RewardSettlementCheckpoint.countDocuments({ ...SETTLE, checkpointId: NEXT }), 0);
    assert.equal(await UserRewardCheckpoint.countDocuments({ ...SETTLE, checkpointId: NEXT }), 0);
  });

  it("29. an OCCUPIED candidate id fails loudly instead of skipping", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010); await mkTeam("bob", 41010, 7n * E18);

    chain.state.finalized.add(NEXT);                   // out-of-band settlement
    await assert.rejects(calculateSettlementCheckpoint(chain.reader),
      (e: unknown) => new RegExp(`epochFinalized\\(${NEXT}\\) is already true`)
        .test((e as Error).message));
  });

  it("30. an already-funded candidate id fails loudly", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010); await mkTeam("bob", 41010, 7n * E18);

    chain.state.funded.add(NEXT);
    await assert.rejects(calculateSettlementCheckpoint(chain.reader),
      (e: unknown) => new RegExp(`rewardEpochFunded\\(${NEXT}\\) is already true`)
        .test((e as Error).message));
  });

  for (const [label, mutate] of [
    ["root", (c: { state: { root: string } }) => { c.state.root = `0x${"e".repeat(64)}`; }],
    ["epoch id", (c: { state: { latestEpochId: number } }) => { c.state.latestEpochId = 42; }],
    ["total", (c: { state: { cumulativeTotal: bigint } }) => { c.state.cumulativeTotal = 99n; }],
  ] as const) {
    it(`31-${label}. out-of-band live ${label} blocks the next checkpoint`, async (t) => {
      if (!connected) return t.skip("no MONGODB_TEST_URI");
      const { chain } = await seedBaseline();
      await mkUser("bob", "baseline", wallet(0xb0b));
      await settleEpoch(41010); await mkTeam("bob", 41010, 7n * E18);
      mutate(chain as never);
      await assert.rejects(calculateSettlementCheckpoint(chain.reader), SettlementInvariantError);
    });
  }

  it("32. Treasury pointing at a different Withdrawal blocks settlement", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010); await mkTeam("bob", 41010, 7n * E18);
    chain.state.treasuryWithdrawal = `0x${"f".repeat(40)}`;
    await assert.rejects(calculateSettlementCheckpoint(chain.reader),
      (e: unknown) => /Treasury's configured Withdrawal/.test((e as Error).message));
  });

  it("33. only ONE unfinalized checkpoint may exist at a time", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010); await mkTeam("bob", 41010, 7n * E18);
    const first = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(first.outcome, "CALCULATED");

    // Another reward epoch settles, but the operator has not acted yet.
    await settleEpoch(41011); await mkTeam("bob", 41011, 1n * E18);
    const second = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(second.outcome, "AWAITING_OPERATOR");
    assert.equal((second as { checkpointId: number }).checkpointId, NEXT);
    assert.equal(await RewardSettlementCheckpoint.countDocuments({ ...SETTLE }), 2,
      "the baseline plus the one awaiting the operator; no third");
  });

  it("34. the range stops at the first gap", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010); await mkTeam("bob", 41010, 1n * E18);
    await settleEpoch(41011); await mkTeam("bob", 41011, 1n * E18);
    // 41012 Phase 1 only — Phase 2 has not settled it, so the range must end at 41011.
    await RewardEpoch.collection.insertOne({
      ...SK, epochId: 41012, windowStart: 0, snapshotAt: 41012 * 43200,
      status: "CALCULATED", attempts: 1, priceE18: E18.toString(), poolROISnapshot: [],
      stakesProcessed: 0, stakesRewarded: 0, totalRegularSelfACF: "0", totalDAOStakeACF: "0",
    } as never);
    await mkTeam("bob", 41012, 99n * E18);

    const r = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(r.outcome, "CALCULATED");
    assert.equal((r as { throughRewardEpochId: number }).throughRewardEpochId, 41011);
    const row = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT, userId: "bob" }))!;
    assert.equal(row.newTeamACF, (2n * E18).toString(), "41012's 99 is excluded");
  });

  it("35. a divergent persisted immutable row fails and is never overwritten", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010); await mkTeam("bob", 41010, 7n * E18);
    await calculateSettlementCheckpoint(chain.reader);

    // Tamper, then force a recalculation of the same checkpoint.
    await UserRewardCheckpoint.collection.updateOne(
      { ...SETTLE, checkpointId: NEXT, userId: "bob" },
      { $set: { cumulativeTeamACF: "1" } },
    );
    await RewardSettlementCheckpoint.updateOne(
      { ...SETTLE, checkpointId: NEXT }, { $set: { status: "FAILED" } },
    );
    await assert.rejects(calculateSettlementCheckpoint(chain.reader),
      (e: unknown) => /cumulativeTeamACF expected/.test((e as Error).message));
    assert.equal(
      (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT, userId: "bob" }))!.cumulativeTeamACF,
      "1", "reported, never repaired",
    );
  });
});

// ════════════════════════════════════════ PROOF / MANIFEST ════

describe("proof and manifest", () => {
  const finalized = async () => {
    const { chain } = await seedBaseline();
    await mkUser("bob", "baseline", wallet(0xb0b));
    await settleEpoch(41010); await mkTeam("bob", 41010, 7n * E18);
    const r = await calculateSettlementCheckpoint(chain.reader);
    assert.equal(r.outcome, "CALCULATED");
    const cp = (await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT }))!;
    return { chain, cp };
  };

  it("36. an unpublished earner cannot claim yet, and the reward is never dropped", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, cp } = await finalized();
    chain.settle(NEXT, cp.root, BigInt(cp.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);
    await mkUser("alice", "baseline", wallet(0xa11ce));
    await settleEpoch(41011); await mkTeam("alice", 41011, 4n * E18);

    // Her address is claimable from registration; what she lacks is a leaf in the LIVE root.
    const proof = await buildClaimProof("alice", chain.reader);
    assert.equal(proof.status, "NOTHING_TO_CLAIM");
    assert.equal(proof.claimable, false);
    const summary = await getRewardSummary("alice");
    assert.equal(summary.earnedTeamACF, (4n * E18).toString(), "earned is still reported");
    assert.equal(summary.reason, "NOT_YET_PUBLISHED");
  });

  it("37. a valid proof is issued against the LIVE root", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, cp } = await finalized();
    chain.settle(NEXT, cp.root, BigInt(cp.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);

    const proof = await buildClaimProof("bob", chain.reader);
    assert.equal(proof.status, "CLAIMABLE");
    if (proof.status !== "CLAIMABLE") return;
    assert.equal(proof.root, cp.root);
    assert.equal(proof.liveRoot, cp.root);
    assert.equal(proof.cumulativeTeamACF, (7n * E18).toString());
    assert.ok(proof.proof.length >= 1, "a two-leaf tree gives a one-element proof");
  });

  it("38. a STALE on-chain root refuses to issue a proof", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, cp } = await finalized();
    chain.settle(NEXT, cp.root, BigInt(cp.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);
    // Someone finalized a different root out of band.
    chain.state.root = `0x${"9".repeat(64)}`;
    await assert.rejects(buildClaimProof("bob", chain.reader),
      (e: unknown) => (e as { code?: string }).code === "SETTLEMENT_STALE");
  });

  it("39. a fully claimed user gets NOTHING_TO_CLAIM", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, cp } = await finalized();
    chain.settle(NEXT, cp.root, BigInt(cp.publishedCumulativeTotalACF));
    await reconcileSettlementCheckpoint(chain.reader);
    const row = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: NEXT, userId: "bob" }))!;
    chain.state.claimed.set(wallet(0xb0b).toLowerCase(), BigInt(row.combinedCumulativeACF));

    const proof = await buildClaimProof("bob", chain.reader);
    assert.equal(proof.status, "NOTHING_TO_CLAIM");
    assert.equal((proof as { reason: string }).reason, "FULLY_CLAIMED");
  });

  it("40. the manifest is deterministic and detects tampering", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await finalized();
    const a = await buildManifest(NEXT);
    const b = await buildManifest(NEXT);
    assert.equal(a.manifestHash, b.manifestHash);
    assert.equal(a.manifest.checkpointId, NEXT);
    assert.equal(a.manifest.previousCheckpointId, BASELINE_ID);
    assert.equal(a.manifest.previousRoot, BASELINE_ROOT);
    assert.equal(a.manifest.previousPublishedCumulativeTotalACF, BASELINE_ACF.toString());

    // Any altered field changes the hash, which is what the operator script checks.
    const { manifestHash: hashOf } = await import("./policy.js");
    assert.notEqual(
      hashOf({ ...a.manifest, publishedDeltaACF: "1" }), a.manifestHash,
    );
  });
});
