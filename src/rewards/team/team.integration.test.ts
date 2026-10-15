import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { assertDisposable, TEST_ROOT_EOA, TEST_STAKING } from "./testenv.ts";

const TEST_URI = process.env.MONGODB_TEST_URI;

const { runTeamRewardEpoch, Phase1NotSettledError } = await import("./epoch.js");
const { catchUpTeamRewardEpochs } = await import("./service.js");
const {
  MissingRewardEntryError, MissingStakeError, DuplicateStakeIdentityError,
} = await import("./inputs.js");
const { RowVerificationError } = await import("./verify.js");
const {
  USD, acfToUsd6,
  DAO_TEAM_PROPAGATION_START_EPOCH, teamPropagationRuleForEpoch, directRuleForEpoch,
} = await import("./policy.js");
const { snapshotAtOf, windowStartOf } = await import("../policy.js");
const { RewardEpoch } = await import("../../models/RewardEpoch.js");
const { RewardPhase2Epoch } = await import("../../models/RewardPhase2Epoch.js");
const { UserRankSnapshot } = await import("../../models/UserRankSnapshot.js");
const { TeamRewardEntry } = await import("../../models/TeamRewardEntry.js");
const { LevelRewardCredit } = await import("../../models/LevelRewardCredit.js");
const { StakeRewardEntry } = await import("../../models/StakeRewardEntry.js");
const { Stake } = await import("../../models/Stake.js");
const { User } = await import("../../models/User.js");

const E18 = 10n ** 18n;
const EPOCH = 41_200;
const SNAP = snapshotAtOf(EPOCH);
const WINDOW_START = windowStartOf(EPOCH);
const LOW = TEST_STAKING.toLowerCase();
const KEY = { chainId: 80002, stakingContractAddress: LOW };
const P1 = E18;                                    // $1.00 per ACF, keeps USD == ACF

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([
    User.init(), Stake.init(), StakeRewardEntry.init(), RewardEpoch.init(),
    RewardPhase2Epoch.init(), UserRankSnapshot.init(), TeamRewardEntry.init(),
    LevelRewardCredit.init(),
  ]);
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (connected) await Promise.all([
    User.deleteMany({}), Stake.deleteMany({}), StakeRewardEntry.deleteMany({}),
    RewardEpoch.deleteMany({}), RewardPhase2Epoch.deleteMany({}),
    UserRankSnapshot.deleteMany({}), TeamRewardEntry.deleteMany({}),
    LevelRewardCredit.deleteMany({}),
  ]);
  seq = 0; stakeSeq = 0;
});

let seq = 0;
let stakeSeq = 0;

const mkUser = async (userId: string, parent: string | null, createdAtSec = SNAP - 86_400) => {
  seq += 1;
  await User.collection.insertOne({
    userId,
    externalEOA: userId === "root" ? TEST_ROOT_EOA : `0x${seq.toString(16).padStart(40, "0")}`,
    referralCode: `ACF-${userId.toUpperCase()}`,
    referredByUserId: parent,
    // `createdAt` is the whole of qualification: a member registered at or before an epoch's
    // snapshot counts as a direct for that epoch, with no wallet and no stake required.
    createdAt: new Date(createdAtSec * 1000),
    updatedAt: new Date(createdAtSec * 1000),
  } as never);
};

type StakeOpts = {
  principalACF?: bigint;
  source?: "DIRECT" | "BOND" | "DAO";
  /** "ACTIVE" | "TOO_YOUNG" | "WITHDRAWN" — the Phase 1 verdict to persist. */
  verdict?: "ACTIVE" | "TOO_YOUNG" | "WITHDRAWN";
  rewardACF?: bigint;
  stakeTimestamp?: number;
  /** Omit the Phase 1 entry, to exercise the integrity check. */
  skipEntry?: boolean;
  /** Settle into a different epoch, for tests that need a later policy version. */
  epochId?: number;
  /**
   * Write the Phase 1 entry for these epochs as well.
   *
   * A stake exists from its timestamp onward, and Phase 2 requires an entry for EVERY stake that
   * existed at the boundary. A test that settles two epochs therefore needs one stake with an
   * entry in each, not two stakes.
   */
  alsoEpochs?: number[];
};

/** Creates a Stake row plus its Phase 1 StakeRewardEntry, as a settled epoch would have. */
const mkStake = async (userId: string, o: StakeOpts = {}) => {
  stakeSeq += 1;
  const stakeId = String(stakeSeq);
  const principalACF = o.principalACF ?? 0n;
  const source = o.source ?? "DIRECT";
  const verdict = o.verdict ?? "ACTIVE";
  const epochId = o.epochId ?? EPOCH;
  const snapshotAt = snapshotAtOf(epochId);
  const stakeTimestamp = o.stakeTimestamp ?? snapshotAt - 50 * 43_200;
  const reward = o.rewardACF ?? 0n;

  await Stake.collection.insertOne({
    eventId: `80002:t:${stakeId}`, chainId: 80002, stakingContractAddress: LOW, stakeId,
    userId, externalEOA: `0x${(stakeSeq + 0x9000).toString(16).padStart(40, "0")}`,
    poolId: 1, principalACF: principalACF.toString(), source, poolDailyROIAtCreation: "0",
    stakeTimestamp: new Date(stakeTimestamp * 1000),
    unlockTimestamp: new Date(stakeTimestamp * 1000),
    active: verdict !== "WITHDRAWN",
    txHash: `0x${"0".repeat(64)}`, blockNumber: 0, logIndex: -1,
  } as never);

  if (o.skipEntry) return stakeId;

  await StakeRewardEntry.collection.insertOne({
    chainId: 80002, stakingContractAddress: LOW, stakeId, epochId,
    userId, externalEOA: `0x${(stakeSeq + 0x9000).toString(16).padStart(40, "0")}`,
    source, poolId: 1,
    principalACF: principalACF.toString(),
    compoundBaseACF: principalACF.toString(),
    rewardACF: (verdict === "ACTIVE" ? reward : 0n).toString(),
    cumulativeEarnedACF: "0",
    rateApplied: "2500", rateDenominator: "1000000",
    rewardEligible: verdict === "ACTIVE",
    ineligibleReason: verdict === "ACTIVE" ? null : verdict,
    snapshotAt,
  } as never);

  for (const extra of o.alsoEpochs ?? []) {
    await StakeRewardEntry.collection.insertOne({
      chainId: 80002, stakingContractAddress: LOW, stakeId, epochId: extra,
      userId, externalEOA: `0x${(stakeSeq + 0x9000).toString(16).padStart(40, "0")}`,
      source, poolId: 1,
      principalACF: principalACF.toString(),
      compoundBaseACF: principalACF.toString(),
      rewardACF: (verdict === "ACTIVE" ? reward : 0n).toString(),
      cumulativeEarnedACF: "0",
      rateApplied: "2500", rateDenominator: "1000000",
      rewardEligible: verdict === "ACTIVE",
      ineligibleReason: verdict === "ACTIVE" ? null : verdict,
      snapshotAt: snapshotAtOf(extra),
    } as never);
  }
  return stakeId;
};

const mkPhase1 = async (status = "CALCULATED", epochId = EPOCH) => {
  await RewardEpoch.collection.insertOne({
    chainId: 80002, stakingContractAddress: LOW, epochId,
    windowStart: windowStartOf(epochId), snapshotAt: snapshotAtOf(epochId),
    status, attempts: 1, leaseExpiresAt: null,
    snapshotBlockNumber: snapshotAtOf(epochId), snapshotBlockTimestamp: snapshotAtOf(epochId),
    priceE18: P1.toString(), poolROISnapshot: [],
    stakesProcessed: 0, stakesRewarded: 0,
    totalRegularSelfACF: "0", totalDAOStakeACF: "0",
  } as never);
};

const team = (userId: string) => TeamRewardEntry.findOne({ ...KEY, epochId: EPOCH, userId });
const snap = (userId: string) => UserRankSnapshot.findOne({ ...KEY, epochId: EPOCH, userId });

// ══════════════════════════════════════════════════════════════════ LEVEL ════

describe("Level Income", () => {
  /**
   * The specification's A-F fixture.
   *   A -> B, C      B -> D, E      C -> F
   * Epoch self rewards: B=100, C=200, D=50, E=40, F=60.
   * A has 2 directs, so only L1 and L2 are unlocked.
   */
  const buildAF = async () => {
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("A", "root");
    await mkUser("B", "A");
    await mkUser("C", "A");
    await mkUser("D", "B");
    await mkUser("E", "B");
    await mkUser("F", "C");
    for (const [u, r] of [["B", 100n], ["C", 200n], ["D", 50n], ["E", 40n], ["F", 60n]] as const) {
      await mkStake(u, { principalACF: 1n * E18, rewardACF: r * E18 });
    }
  };

  it("1. the A-F fixture pays A exactly 42 ACF and B exactly 9 ACF", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await buildAF();
    await runTeamRewardEpoch(EPOCH);

    // A: L1 = (100+200) x 10% = 30; L2 = (50+40+60) x 8% = 12
    assert.equal((await team("A"))!.levelRewardACF, (42n * E18).toString());
    // B: L1 = (50+40) x 10% = 9; nothing below D/E
    assert.equal((await team("B"))!.levelRewardACF, (9n * E18).toString());
  });

  it("2. one reward pays two different ancestors at different levels", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await buildAF();
    await runTeamRewardEpoch(EPOCH);
    const credits = await LevelRewardCredit.find({ ...KEY, epochId: EPOCH, sourceUserId: "D" });
    const byBeneficiary = new Map(credits.map((c) => [c.beneficiaryUserId, c]));
    assert.equal(byBeneficiary.get("B")!.relativeLevel, 1);
    assert.equal(byBeneficiary.get("B")!.rewardACF, (5n * E18).toString());    // 50 x 10%
    assert.equal(byBeneficiary.get("A")!.relativeLevel, 2);
    assert.equal(byBeneficiary.get("A")!.rewardACF, (4n * E18).toString());    // 50 x 8%
  });

  it("3. each of L1-L7 pays its exact rate, and L8 pays nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    // A ten-deep chain. EVERY node needs 4+ directs of its own, or it unlocks fewer levels
    // than the test is measuring — a chain alone gives each node a single direct and so only
    // unlocks L1.
    let parent = "root";
    const chain: string[] = [];
    for (let i = 0; i < 10; i++) { const id = `n${i}`; await mkUser(id, parent); chain.push(id); parent = id; }
    for (const node of ["root", ...chain]) {
      for (let i = 0; i < 3; i++) await mkUser(`${node}-pad${i}`, node);
    }
    // Only the deepest user earns, so each ancestor sees it at a distinct relative level.
    await mkStake("n9", { principalACF: 1n * E18, rewardACF: 1000n * E18 });

    await runTeamRewardEpoch(EPOCH);

    const expected = [100n, 80n, 60n, 40n, 40n, 10n, 10n];   // L1..L7 of 1000 ACF
    for (const [i, pct] of expected.entries()) {
      const beneficiary = chain[8 - i]!;                     // n8 is L1, n7 is L2, ...
      const credit = await LevelRewardCredit.findOne({
        ...KEY, epochId: EPOCH, beneficiaryUserId: beneficiary, sourceUserId: "n9",
      });
      assert.equal(credit!.rewardACF, (pct * E18).toString(), `L${i + 1} -> ${beneficiary}`);
    }
    // n1 is relative L8 from n9 and must receive nothing from it.
    assert.equal(await LevelRewardCredit.countDocuments({
      ...KEY, epochId: EPOCH, beneficiaryUserId: "n1", sourceUserId: "n9",
    }), 0);
  });

  it("4. unlock follows the direct count: 0/1/2/3/4+", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    for (const [directs, expectedLevels] of [[1, 1], [2, 2], [3, 3], [4, 7], [6, 7]] as const) {
      await Promise.all([
        User.deleteMany({}), Stake.deleteMany({}), StakeRewardEntry.deleteMany({}),
        RewardEpoch.deleteMany({}), RewardPhase2Epoch.deleteMany({}),
        UserRankSnapshot.deleteMany({}), TeamRewardEntry.deleteMany({}),
        LevelRewardCredit.deleteMany({}),
      ]);
      seq = 0; stakeSeq = 0;
      await mkPhase1();
      await mkUser("root", null);
      await mkUser("L", "root");
      // A seven-deep chain under L so every unlocked level has a source.
      let parent = "L";
      for (let d = 0; d < 7; d++) { await mkUser(`c${d}`, parent); parent = `c${d}`; }
      // The chain's first node is already one direct; add extras to reach the target count.
      for (let i = 1; i < directs; i++) await mkUser(`extra${i}`, "L");
      for (let d = 0; d < 7; d++) {
        await mkStake(`c${d}`, { principalACF: 1n * E18, rewardACF: 100n * E18 });
      }

      await runTeamRewardEpoch(EPOCH);

      const entry = (await team("L"))!;
      assert.equal(entry.levelAudit.unlockedLevels, expectedLevels, `${directs} directs`);
      const paidLevels = (await LevelRewardCredit.find({
        ...KEY, epochId: EPOCH, beneficiaryUserId: "L",
      })).map((c) => c.relativeLevel).sort((a, b) => a - b);
      assert.deepEqual(
        paidLevels,
        Array.from({ length: expectedLevels }, (_, i) => i + 1),
        `${directs} directs should pay levels 1..${expectedLevels}`,
      );
    }
  });

  it("4b. a leader with zero directs unlocks nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");                  // no children at all
    await mkStake("L", { principalACF: 1n * E18, rewardACF: 100n * E18 });

    await runTeamRewardEpoch(EPOCH);
    const entry = (await team("L"))!;
    assert.equal(entry.levelAudit.directCount, 0);
    assert.equal(entry.levelAudit.unlockedLevels, 0);
    assert.equal(entry.levelRewardACF, "0");
    assert.equal(await LevelRewardCredit.countDocuments({
      ...KEY, epochId: EPOCH, beneficiaryUserId: "L",
    }), 0);
  });

  it("5. a direct registered AFTER the boundary does not raise the unlock tier", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkUser("early", "L", SNAP - 100);
    for (let i = 0; i < 5; i++) await mkUser(`late${i}`, "L", SNAP + 100);
    await mkStake("early", { principalACF: 1n * E18, rewardACF: 100n * E18 });

    await runTeamRewardEpoch(EPOCH);

    const entry = (await team("L"))!;
    assert.equal(entry.levelAudit.directCount, 1, "only the early direct counts");
    assert.equal(entry.levelAudit.unlockedLevels, 1, "not 7");
  });

  it("6. before epoch 41463, DAO staking reward does not propagate; BOND does", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkUser("x", "L");
    await mkStake("x", { principalACF: 1n * E18, rewardACF: 500n * E18, source: "DAO" });
    await mkStake("x", { principalACF: 1n * E18, rewardACF: 100n * E18, source: "BOND" });

    await runTeamRewardEpoch(EPOCH);

    // Only the BOND reward is a Level source: 100 x 10% = 10.
    assert.equal((await team("L"))!.levelRewardACF, (10n * E18).toString());
    const credit = await LevelRewardCredit.findOne({
      ...KEY, epochId: EPOCH, beneficiaryUserId: "L", sourceUserId: "x",
    });
    assert.equal(credit!.sourceRegularSelfRewardACF, (100n * E18).toString());
  });

  it("7. a recipient with no stake and no reward of their own is still paid", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");                 // never staked
    await mkUser("x", "L");
    await mkStake("x", { principalACF: 1n * E18, rewardACF: 100n * E18 });

    await runTeamRewardEpoch(EPOCH);
    assert.equal((await team("L"))!.levelRewardACF, (10n * E18).toString());
    assert.equal((await snap("L"))!.selfStakeACF, "0");
  });

  it("8. ROOT receives Level Income when otherwise eligible", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("a", "root");
    await mkStake("a", { principalACF: 1n * E18, rewardACF: 100n * E18 });

    await runTeamRewardEpoch(EPOCH);
    assert.equal((await team("root"))!.levelRewardACF, (10n * E18).toString());
  });

  it("9. several earners aggregate into one beneficiary total", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    for (const id of ["a", "b", "c"]) {
      await mkUser(id, "L");
      await mkStake(id, { principalACF: 1n * E18, rewardACF: 100n * E18 });
    }
    await runTeamRewardEpoch(EPOCH);
    // Three directs, each 100 ACF at L1 = 30 ACF total.
    assert.equal((await team("L"))!.levelRewardACF, (30n * E18).toString());
    const audit = (await team("L"))!.levelAudit.perLevel[0]!;
    assert.equal(audit.sourceCount, 3);
    assert.equal(audit.baseACF, (300n * E18).toString());
  });
});

// ═════════════════════════════════════════════════ RANK QUALIFICATION ════

describe("Rank qualification", () => {
  /** A leader with `directs` staked directs and a given self stake. */
  const buildLeader = async (selfACF: bigint, directs: number, directStakeACF: bigint) => {
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    if (selfACF > 0n) await mkStake("L", { principalACF: selfACF });
    for (let i = 0; i < directs; i++) {
      await mkUser(`d${i}`, "L");
      if (directStakeACF > 0n) await mkStake(`d${i}`, { principalACF: directStakeACF });
    }
  };

  it("10. Nova qualifies at exactly $100 self, $5,000 team, 2 active directs", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await buildLeader(100n * E18, 2, 2_500n * E18);
    await runTeamRewardEpoch(EPOCH);
    const s = (await snap("L"))!;
    assert.equal(s.rank, 1);
    assert.equal(s.rankName, "Nova");
    assert.equal(s.selfStakeUSD6, (100n * USD).toString());
    assert.equal(s.teamStakeUSD6, (5_000n * USD).toString());
    assert.equal(s.activeDirects, 2);
  });

  it("11. one dollar short of Nova's self is unranked", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await buildLeader(99n * E18, 2, 2_500n * E18);
    await runTeamRewardEpoch(EPOCH);
    assert.equal((await snap("L"))!.rank, 0);
    assert.equal((await snap("L"))!.rankName, null);
  });

  it("12. one short on active directs is unranked", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await buildLeader(100n * E18, 1, 5_000n * E18);
    await runTeamRewardEpoch(EPOCH);
    assert.equal((await snap("L"))!.rank, 0);
  });

  it("13. an unstaked direct still qualifies its referrer, and reaches Nova", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkStake("L", { principalACF: 100n * E18 });
    await mkUser("staked", "L");
    await mkStake("staked", { principalACF: 5_000n * E18 });
    await mkUser("unstaked", "L");                 // registered, never staked

    await runTeamRewardEpoch(EPOCH);
    const s = (await snap("L"))!;
    assert.equal(s.directCount, 2);
    assert.equal(s.activeDirects, 1, "only one holds stake — retained for audit");
    assert.equal(s.registeredDirects, 2, "but both qualify");
    assert.equal(s.directRule, "REGISTERED_EOA");
    // Nova needs 2 directs plus $100 self and $5,000 team, all of which L has. Under the old
    // active-stake rule this same fixture reached rank 0, which is exactly what changed.
    assert.equal(s.rank, 1, "qualified on registration, not on the directs' stake");
  });

  it("14. a TOO_YOUNG stake still counts as active principal", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    // Existed at the boundary but under 12h old: no staking reward, yet real principal.
    await mkStake("L", {
      principalACF: 100n * E18, verdict: "TOO_YOUNG", stakeTimestamp: SNAP - 600,
    });
    for (let i = 0; i < 2; i++) {
      await mkUser(`d${i}`, "L");
      await mkStake(`d${i}`, { principalACF: 2_500n * E18, verdict: "TOO_YOUNG" });
    }

    await runTeamRewardEpoch(EPOCH);
    const s = (await snap("L"))!;
    assert.equal(s.selfStakeACF, (100n * E18).toString(), "TOO_YOUNG is ACTIVE principal");
    assert.equal(s.teamStakeACF, (5_000n * E18).toString());
    assert.equal(s.activeDirects, 2);
    assert.equal(s.rank, 1, "qualifies for Nova on principal alone");
  });

  it("15. a WITHDRAWN stake contributes no principal", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkStake("L", { principalACF: 100n * E18, verdict: "WITHDRAWN" });
    await runTeamRewardEpoch(EPOCH);
    assert.equal((await snap("L"))!.selfStakeACF, "0");
    assert.equal((await snap("L"))!.rank, 0);
  });

  it("16. a stake created AFTER the boundary is excluded even with an entry", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    // Discovered before the worker ran, so it carries a TOO_YOUNG row — but it was not part
    // of this epoch.
    await mkStake("L", {
      principalACF: 100_000n * E18, verdict: "TOO_YOUNG", stakeTimestamp: SNAP + 60,
    });
    await runTeamRewardEpoch(EPOCH);
    assert.equal((await snap("L"))!.selfStakeACF, "0", "post-boundary principal must not count");
  });

  it("17. Self and Team count DIRECT, BOND and DAO principal alike", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkStake("L", { principalACF: 40n * E18, source: "DIRECT" });
    await mkStake("L", { principalACF: 30n * E18, source: "BOND" });
    await mkStake("L", { principalACF: 30n * E18, source: "DAO" });
    await mkUser("d", "L");
    await mkStake("d", { principalACF: 1_000n * E18, source: "DAO" });

    await runTeamRewardEpoch(EPOCH);
    const s = (await snap("L"))!;
    assert.equal(s.selfStakeACF, (100n * E18).toString(), "all three sources");
    assert.equal(s.teamStakeACF, (1_000n * E18).toString(), "DAO principal counts for team");
  });

  it("18. Team spans the entire downline, deeper than seven, excluding the leader", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkStake("L", { principalACF: 7n * E18 });
    let parent = "L";
    for (let i = 0; i < 9; i++) {                 // depth 9, past relative L7
      await mkUser(`deep${i}`, parent);
      await mkStake(`deep${i}`, { principalACF: 10n * E18 });
      parent = `deep${i}`;
    }
    await runTeamRewardEpoch(EPOCH);
    const s = (await snap("L"))!;
    assert.equal(s.teamStakeACF, (90n * E18).toString(), "9 x 10, leader's 7 excluded");
  });

  it("19. rank falls when the team withdraws", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await buildLeader(100n * E18, 2, 2_500n * E18);
    await runTeamRewardEpoch(EPOCH);
    assert.equal((await snap("L"))!.rank, 1);

    // A later epoch where the directs' stakes read WITHDRAWN.
    const later = EPOCH + 1;
    await mkPhase1("CALCULATED", later);
    for (const row of await StakeRewardEntry.find({ ...KEY, epochId: EPOCH })) {
      await StakeRewardEntry.collection.insertOne({
        ...row.toObject(), _id: undefined, epochId: later,
        rewardACF: "0", rewardEligible: false, ineligibleReason: "WITHDRAWN",
        snapshotAt: snapshotAtOf(later),
      } as never);
    }
    await runTeamRewardEpoch(later);
    const after = await UserRankSnapshot.findOne({ ...KEY, epochId: later, userId: "L" });
    assert.equal(after!.rank, 0, "rank is recomputed and may fall");
    assert.equal(after!.previousRank, 1, "the prior rank is kept for support only");
  });
});

// ══════════════════════════════════════════ RANK REWARD / CAP ════

describe("Rank reward", () => {
  it("20. 50% leader over a 30% downline on a 1000 ACF base pays 200 ACF", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("legend", "root");
    await mkUser("crown", "legend");

    // Legend: self $5,000, team $400,000, 6 active directs.
    await mkStake("legend", { principalACF: 5_000n * E18 });
    for (let i = 0; i < 6; i++) {
      await mkUser(`ld${i}`, "legend");
      await mkStake(`ld${i}`, { principalACF: 1n * E18 });
    }
    // Crown: self $900, team $45,000, 4 active directs — and the reward base lives here.
    await mkStake("crown", { principalACF: 900n * E18, rewardACF: 1000n * E18 });
    for (let i = 0; i < 4; i++) {
      await mkUser(`cd${i}`, "crown");
      await mkStake(`cd${i}`, { principalACF: 45_000n * E18 });
    }
    // Top up Legend's team to $400,000 via a deep node.
    await mkUser("filler", "crown");
    await mkStake("filler", { principalACF: 300_000n * E18 });

    await runTeamRewardEpoch(EPOCH);

    const legend = (await snap("legend"))!;
    const crown = (await snap("crown"))!;
    assert.equal(crown.rank, 3, `crown resolved to ${crown.rank}`);
    assert.equal(legend.rank, 5, `legend resolved to ${legend.rank}`);

    const entry = (await team("legend"))!;
    assert.equal(entry.rankAudit.highestDownlineRank, 3);
    assert.equal(entry.rankAudit.differentialRateE6, "200000");
    assert.equal(entry.rankAudit.teamRewardBaseACF, (1000n * E18).toString());
    assert.equal(entry.rankRewardACF, (200n * E18).toString());
    assert.equal(entry.rankAudit.capped, false);
  });

  it("20b. a ranked GRANDCHILD under an unranked child caps the differential", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("leader", "root");
    // Crown: self $900, team >= $45,000, 4 active directs.
    await mkStake("leader", { principalACF: 900n * E18 });
    for (let i = 0; i < 4; i++) {
      await mkUser(`ld${i}`, "leader");
      // One direct carries the whole reward base; none of them qualifies for any rank
      // (no directs of their own), so the leader's max can only come from deeper.
      await mkStake(`ld${i}`, {
        principalACF: 10_000n * E18,
        // Kept small so Crown's $45 twelve-hour cap does not bind and the DIFFERENTIAL
        // itself is what the payout reveals: 20% of 100 is 20, while a missed grandchild
        // would pay 30.
        rewardACF: i === 0 ? 100n * E18 : 0n,
      });
    }
    // An UNRANKED intermediate — no stake at all — with a Nova-qualified child beneath it.
    await mkUser("mid", "leader");
    await mkUser("nova", "mid");
    await mkStake("nova", { principalACF: 100n * E18 });
    for (let i = 0; i < 2; i++) {
      await mkUser(`nd${i}`, "nova");
      await mkStake(`nd${i}`, { principalACF: 2_500n * E18 });
    }

    await runTeamRewardEpoch(EPOCH);

    assert.equal((await snap("mid"))!.rank, 0, "the intermediate is unranked");
    assert.equal((await snap("nova"))!.rank, 1, "the grandchild is Nova");
    assert.equal((await snap("leader"))!.rank, 3, "the leader is Crown");

    const entry = (await team("leader"))!;
    // The depth-two Nova must be visible to the leader THROUGH the unranked intermediate.
    assert.equal(entry.rankAudit.highestDownlineRank, 1,
      "a grandchild's rank must propagate; 0 here would mean only direct children were seen");
    assert.equal(entry.rankAudit.highestDownlineRateE6, "100000");
    assert.equal(entry.rankAudit.differentialRateE6, "200000", "30% - 10%, not 30%");
    assert.equal(entry.rankAudit.teamRewardBaseACF, (100n * E18).toString());
    assert.equal(entry.rankAudit.capped, false, "the cap must not mask the differential");
    assert.equal(entry.rankRewardACF, (20n * E18).toString(), "20 ACF, not 30");
  });

  it("21. an unranked leader earns no rank reward", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkUser("x", "L");
    await mkStake("x", { principalACF: 1n * E18, rewardACF: 1000n * E18 });
    await runTeamRewardEpoch(EPOCH);
    assert.equal((await team("L"))!.rankRewardACF, "0");
    assert.equal((await team("L"))!.rankAudit.differentialRateE6, "0");
  });

  it("22. the leader's own staking reward is excluded from the base", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkStake("L", { principalACF: 100n * E18, rewardACF: 999n * E18 });
    await mkUser("x", "L");
    await mkStake("x", { principalACF: 5_000n * E18, rewardACF: 10n * E18 });
    await mkUser("y", "L");
    await mkStake("y", { principalACF: 1n * E18 });

    await runTeamRewardEpoch(EPOCH);
    const entry = (await team("L"))!;
    assert.equal(entry.rankAudit.teamRewardBaseACF, (10n * E18).toString(),
      "the leader's own 999 is excluded");
  });

  it("23. the cap binds in USD and is NOT halved a second time", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    // Nova: self $100, team $5,000, 2 active directs. 12h cap is $5.
    await mkStake("L", { principalACF: 100n * E18 });
    for (let i = 0; i < 2; i++) {
      await mkUser(`d${i}`, "L");
      // A big downline reward so the 10% differential exceeds the cap.
      await mkStake(`d${i}`, { principalACF: 2_500n * E18, rewardACF: 1_000n * E18 });
    }
    await runTeamRewardEpoch(EPOCH);

    const entry = (await team("L"))!;
    assert.equal(entry.rankAudit.leaderRank, 1);
    assert.equal(entry.rankAudit.epochCapUSD6, (5n * USD).toString(), "the 12h cap, not $10");
    // Gross = 2000 x 10% = 200 ACF = $200, far over the $5 cap.
    assert.equal(entry.rankAudit.grossACF, (200n * E18).toString());
    assert.equal(entry.rankAudit.capped, true);
    assert.equal(entry.rankRewardACF, (5n * E18).toString(), "exactly $5 of ACF at P=1");
    assert.equal(acfToUsd6(BigInt(entry.rankRewardACF), P1), 5n * USD);
  });

  it("24. DAO staking reward is excluded from the rank reward base", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkStake("L", { principalACF: 100n * E18 });
    for (let i = 0; i < 2; i++) {
      await mkUser(`d${i}`, "L");
      await mkStake(`d${i}`, { principalACF: 2_500n * E18 });
      await mkStake(`d${i}`, { principalACF: 1n * E18, rewardACF: 500n * E18, source: "DAO" });
    }
    await runTeamRewardEpoch(EPOCH);
    const entry = (await team("L"))!;
    assert.equal(entry.rankAudit.teamRewardBaseACF, "0", "1000 ACF of DAO reward must not count");
    assert.equal(entry.rankRewardACF, "0");
  });
});

// ════════════════════════════════════════════════════════════ GLOBAL ════

describe("Global Contribution", () => {
  it("25. the documented fixture reproduces exactly", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    // Self 10,000 ACF; six staked directs holding 50,000 in total; Legend rank (5).
    await mkStake("L", { principalACF: 10_000n * E18 });
    for (let i = 0; i < 6; i++) {
      await mkUser(`d${i}`, "L");
      await mkStake(`d${i}`, { principalACF: 50_000n * E18 / 6n });
    }
    // Team must reach $400,000 for Legend; add depth under one direct.
    await mkUser("deep", "d0");
    await mkStake("deep", { principalACF: 400_000n * E18 });
    // Network contribution: one stake created inside the window.
    await mkUser("fresh", "root");
    await mkStake("fresh", {
      principalACF: 1_000_000n * E18, stakeTimestamp: WINDOW_START + 10,
    });

    await runTeamRewardEpoch(EPOCH);

    const entry = (await team("L"))!;
    const self = BigInt(entry.globalAudit.selfStakeACF);
    const l1 = BigInt(entry.globalAudit.l1StakeACF);
    const net = BigInt(entry.globalAudit.networkContributionACF);
    const rank = entry.globalAudit.rankNumber;
    assert.equal(self, 10_000n * E18);
    assert.equal(rank, 5, `expected Legend, got ${rank}`);
    assert.equal(
      BigInt(entry.globalRewardACF),
      (self * l1 * BigInt(rank)) / net,
      "must equal the price-cancelled form exactly",
    );
  });

  it("26. L1 counts direct children only, never grandchildren", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkUser("child", "L");
    await mkStake("child", { principalACF: 100n * E18 });
    await mkUser("grandchild", "child");
    await mkStake("grandchild", { principalACF: 900n * E18 });

    await runTeamRewardEpoch(EPOCH);
    const s = (await snap("L"))!;
    assert.equal(s.l1StakeACF, (100n * E18).toString(), "grandchild's 900 excluded");
    assert.equal(s.teamStakeACF, (1_000n * E18).toString(), "but team includes it");
  });

  it("27. the denominator is gross flow: created and withdrawn in the window still counts", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkStake("root", {
      principalACF: 500n * E18, stakeTimestamp: WINDOW_START + 5, verdict: "WITHDRAWN",
    });
    await mkStake("root", {
      principalACF: 300n * E18, stakeTimestamp: WINDOW_START + 6, source: "BOND",
    });
    await mkStake("root", {
      principalACF: 200n * E18, stakeTimestamp: WINDOW_START + 7, source: "DAO",
    });
    // Outside the window on both sides.
    await mkStake("root", { principalACF: 999n * E18, stakeTimestamp: WINDOW_START - 1 });
    await mkStake("root", { principalACF: 777n * E18, stakeTimestamp: SNAP });

    await runTeamRewardEpoch(EPOCH);

    const epoch = (await RewardPhase2Epoch.findOne({ ...KEY, epochId: EPOCH }))!;
    // 500 (withdrawn) + 300 (BOND) + 200 (DAO) = 1000; the pre-window and boundary stakes excluded.
    assert.equal(epoch.networkContributionACF, (1_000n * E18).toString());
    assert.equal(epoch.networkContributionUSD6, (1_000n * USD).toString());
  });

  it("28. an unranked leader earns no global reward", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkStake("L", { principalACF: 10_000n * E18 });
    await mkUser("d", "L");
    await mkStake("d", { principalACF: 10_000n * E18, stakeTimestamp: WINDOW_START + 1 });

    await runTeamRewardEpoch(EPOCH);
    const entry = (await team("L"))!;
    assert.equal(entry.globalAudit.rankNumber, 0);
    assert.equal(entry.globalRewardACF, "0");
  });

  it("29. a zero denominator yields zero for everyone, without throwing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkStake("L", { principalACF: 100n * E18 });        // created long before the window
    for (let i = 0; i < 2; i++) {
      await mkUser(`d${i}`, "L");
      await mkStake(`d${i}`, { principalACF: 2_500n * E18 });
    }
    const r = await runTeamRewardEpoch(EPOCH);
    assert.equal(r.networkContributionACF, "0");
    assert.equal((await team("L"))!.globalRewardACF, "0");
    assert.equal((await snap("L"))!.rank, 1, "rank still resolves");
  });
});

// ════════════════════════════════ PHASE 1 SOURCE OF TRUTH ════

describe("Phase 1 is the source of truth", () => {
  it("30. a stake at the boundary with NO Phase 1 entry fails the epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkStake("root", { principalACF: 100n * E18, skipEntry: true });

    await assert.rejects(runTeamRewardEpoch(EPOCH),
      (e: unknown) => e instanceof MissingRewardEntryError
        && /no Phase 1 reward entry/.test((e as Error).message));
    assert.equal((await RewardPhase2Epoch.findOne({ ...KEY, epochId: EPOCH }))!.status, "FAILED");
  });

  it("31. a post-boundary stake with no entry does NOT fail the epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    // Created after the boundary and never settled by Phase 1 — excluded by the gate first.
    await mkStake("root", {
      principalACF: 100n * E18, stakeTimestamp: SNAP + 1, skipEntry: true,
    });
    const r = await runTeamRewardEpoch(EPOCH);
    assert.equal(r.status, "CALCULATED");
  });

  it("32. mutable Stake.active is never consulted", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    // Phase 1 says the position was ACTIVE at the boundary; the row's current flag says false,
    // because it was withdrawn afterwards. Phase 1's verdict must win.
    await mkStake("L", { principalACF: 100n * E18, verdict: "ACTIVE" });
    await Stake.collection.updateOne({ stakeId: "1" }, { $set: { active: false } });

    await runTeamRewardEpoch(EPOCH);
    assert.equal((await snap("L"))!.selfStakeACF, (100n * E18).toString(),
      "the historical verdict, not the current flag");
  });

  it("33. a same-second create-and-withdraw needs no withdrawal metadata", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    // withdrawnBlockTimestamp is deliberately absent; Phase 1's pinned read already decided.
    await mkStake("L", { principalACF: 100n * E18, verdict: "WITHDRAWN" });
    await Stake.collection.updateOne({ stakeId: "1" },
      { $unset: { withdrawnBlockTimestamp: "", withdrawnBlockNumber: "" } });

    await runTeamRewardEpoch(EPOCH);
    assert.equal((await snap("L"))!.selfStakeACF, "0", "WITHDRAWN alone is sufficient");
  });
});

// ════════════════════════ previousRank (audit metadata only) ════

describe("previousRank metadata", () => {
  const settle = async (epochId: number) => {
    await mkPhase1("CALCULATED", epochId);
    return runTeamRewardEpoch(epochId);
  };
  const rankAt = async (epochId: number, userId: string) =>
    UserRankSnapshot.findOne({ ...KEY, epochId, userId });

  /** A Nova-qualified leader: self $100, team $5,000, 2 active directs. */
  const buildNova = async () => {
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkStake("L", { principalACF: 100n * E18 });
    for (let i = 0; i < 2; i++) {
      await mkUser(`d${i}`, "L");
      await mkStake(`d${i}`, { principalACF: 2_500n * E18 });
    }
  };
  /** Copies Phase 1 entries forward so a later epoch sees the same stake state. */
  const carryEntries = async (from: number, to: number) => {
    for (const row of await StakeRewardEntry.find({ ...KEY, epochId: from }).lean()) {
      const { _id, ...rest } = row as Record<string, unknown>;
      await StakeRewardEntry.collection.insertOne({
        ...rest, epochId: to, snapshotAt: snapshotAtOf(to),
      } as never);
    }
  };

  it("46a. previousRank comes from the prior CALCULATED epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await buildNova();
    await settle(EPOCH);
    assert.equal((await rankAt(EPOCH, "L"))!.rank, 1);
    assert.equal((await rankAt(EPOCH, "L"))!.previousRank, null, "nothing settled before it");

    await carryEntries(EPOCH, EPOCH + 1);
    await settle(EPOCH + 1);
    assert.equal((await rankAt(EPOCH + 1, "L"))!.previousRank, 1);
  });

  it("46b. a FAILED intervening epoch is skipped in favour of the last CALCULATED one", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await buildNova();
    await settle(EPOCH);                                     // CALCULATED, rank 1

    // EPOCH+1 fails, leaving partial snapshots with a deliberately wrong rank behind.
    await mkPhase1("CALCULATED", EPOCH + 1);
    await RewardPhase2Epoch.create({
      ...KEY, epochId: EPOCH + 1, status: "FAILED",
      snapshotAt: snapshotAtOf(EPOCH + 1), priceE18: P1.toString(),
    });
    await UserRankSnapshot.collection.insertOne({
      ...KEY, epochId: EPOCH + 1, userId: "L", rank: 9, rankName: "Monarch",
      rateE6: "900000", epochCapUSD6: "0", previousRank: null,
      selfStakeACF: "0", selfStakeUSD6: "0", teamStakeACF: "0", teamStakeUSD6: "0",
      activeDirects: 0, directCount: 0, l1StakeACF: "0",
      maxDownlineRank: 0, downlineQualifiers: 0, priceE18: P1.toString(),
    } as never);

    await carryEntries(EPOCH, EPOCH + 2);
    await settle(EPOCH + 2);

    assert.equal((await rankAt(EPOCH + 2, "L"))!.previousRank, 1,
      "must come from EPOCH (CALCULATED), not the FAILED EPOCH+1 rank of 9");
  });

  it("46c. only FAILED/PROCESSING prior epochs leaves previousRank null", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await buildNova();
    await RewardPhase2Epoch.create({
      ...KEY, epochId: EPOCH - 1, status: "FAILED",
      snapshotAt: snapshotAtOf(EPOCH - 1), priceE18: P1.toString(),
    });
    await RewardPhase2Epoch.create({
      ...KEY, epochId: EPOCH - 2, status: "PROCESSING",
      snapshotAt: snapshotAtOf(EPOCH - 2), priceE18: P1.toString(),
    });
    await settle(EPOCH);
    assert.equal((await rankAt(EPOCH, "L"))!.previousRank, null);
    assert.equal((await rankAt(EPOCH, "L"))!.rank, 1, "the current rank is unaffected");
  });

  it("46d. rank downgrades regardless of previousRank", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await buildNova();
    await settle(EPOCH);
    assert.equal((await rankAt(EPOCH, "L"))!.rank, 1);

    // The directs withdraw, so the team collapses.
    await mkPhase1("CALCULATED", EPOCH + 1);
    for (const row of await StakeRewardEntry.find({ ...KEY, epochId: EPOCH }).lean()) {
      const { _id, ...rest } = row as Record<string, unknown>;
      await StakeRewardEntry.collection.insertOne({
        ...rest, epochId: EPOCH + 1, snapshotAt: snapshotAtOf(EPOCH + 1),
        rewardACF: "0", rewardEligible: false, ineligibleReason: "WITHDRAWN",
      } as never);
    }
    await runTeamRewardEpoch(EPOCH + 1);

    const after = (await rankAt(EPOCH + 1, "L"))!;
    assert.equal(after.rank, 0, "recomputed from scratch and fell");
    assert.equal(after.previousRank, 1, "the old rank is kept only as metadata");
  });
});

// ════════════════════════════════ BIDIRECTIONAL INTEGRITY ════

describe("entry <-> stake integrity", () => {
  /** Inserts a Phase 1 reward entry with NO corresponding Stake row. */
  const orphanEntry = async (stakeId: string, principalACF: bigint) => {
    await StakeRewardEntry.collection.insertOne({
      chainId: 80002, stakingContractAddress: LOW, stakeId, epochId: EPOCH,
      userId: "root", externalEOA: `0x${"7".repeat(40)}`, source: "DIRECT", poolId: 1,
      principalACF: principalACF.toString(), compoundBaseACF: principalACF.toString(),
      rewardACF: "0", cumulativeEarnedACF: "0",
      rateApplied: "2500", rateDenominator: "1000000",
      rewardEligible: true, ineligibleReason: null, snapshotAt: SNAP,
    } as never);
  };

  it("47. THE CERTIFICATION FAILURE — an orphaned reward entry fails the epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    // 500,000 ACF: silently ignoring this would materially change rank qualification.
    await orphanEntry("99", 500_000n * E18);
    assert.equal(await Stake.countDocuments({}), 0, "no Stake row backs the entry");

    await assert.rejects(runTeamRewardEpoch(EPOCH),
      (e: unknown) => e instanceof MissingStakeError
        && /have no corresponding Stake record/.test((e as Error).message)
        && /\b99\b/.test((e as Error).message));

    assert.equal((await RewardPhase2Epoch.findOne({ ...KEY, epochId: EPOCH }))!.status, "FAILED");
    assert.equal(await TeamRewardEntry.countDocuments({ ...KEY, epochId: EPOCH }), 0);
    assert.equal(await UserRankSnapshot.countDocuments({ ...KEY, epochId: EPOCH }), 0);
  });

  it("48. an orphan is caught even alongside otherwise valid stakes", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("a", "root");
    await mkStake("a", { principalACF: 100n * E18, rewardACF: 10n * E18 });
    await orphanEntry("777", 500_000n * E18);

    await assert.rejects(runTeamRewardEpoch(EPOCH), MissingStakeError);
    assert.equal((await RewardPhase2Epoch.findOne({ ...KEY, epochId: EPOCH }))!.status, "FAILED");
  });

  it("49. both directions are reported with their own error type", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    // STAKE -> ENTRY missing is a different failure from ENTRY -> STAKE missing.
    await mkStake("root", { principalACF: 100n * E18, skipEntry: true });
    await assert.rejects(runTeamRewardEpoch(EPOCH), MissingRewardEntryError);
  });

  it("50. a duplicate entry identity fails rather than picking one row", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkStake("root", { principalACF: 100n * E18 });
    // Only reachable by bypassing the unique index, which is what the raw driver does here
    // after dropping it — the point is that corrupt data fails loudly.
    await StakeRewardEntry.collection.dropIndexes();
    await StakeRewardEntry.collection.insertOne({
      chainId: 80002, stakingContractAddress: LOW, stakeId: "1", epochId: EPOCH,
      userId: "root", externalEOA: `0x${"7".repeat(40)}`, source: "DIRECT", poolId: 1,
      principalACF: (999n * E18).toString(), compoundBaseACF: "0", rewardACF: "0",
      cumulativeEarnedACF: "0", rateApplied: "2500", rateDenominator: "1000000",
      rewardEligible: true, ineligibleReason: null, snapshotAt: SNAP,
    } as never);

    await assert.rejects(runTeamRewardEpoch(EPOCH),
      (e: unknown) => e instanceof DuplicateStakeIdentityError);
    await StakeRewardEntry.init();          // restore the index for later tests
  });
});

// ═══════════════════════════════════════ PHASE BOUNDARY / RETRY ════

describe("phase boundary, locking and retry", () => {
  for (const status of ["PENDING", "PROCESSING", "FAILED"]) {
    it(`34-${status}. a Phase 1 epoch that is ${status} is refused`, async (t) => {
      if (!connected) return t.skip("no MONGODB_TEST_URI");
      await mkPhase1(status);
      await mkUser("root", null);
      await assert.rejects(runTeamRewardEpoch(EPOCH), Phase1NotSettledError);
      assert.equal(await RewardPhase2Epoch.countDocuments({}), 0, "no lease is taken");
    });
  }

  it("35. a missing Phase 1 epoch is refused", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("root", null);
    await assert.rejects(runTeamRewardEpoch(EPOCH), Phase1NotSettledError);
  });

  it("36. FINALIZED is accepted", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1("FINALIZED");
    await mkUser("root", null);
    assert.equal((await runTeamRewardEpoch(EPOCH)).status, "CALCULATED");
  });

  it("37. every graph user gets exactly one TeamRewardEntry, including all-zero users", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    for (const id of ["a", "b", "c"]) await mkUser(id, "root");

    const r = await runTeamRewardEpoch(EPOCH);
    assert.equal(r.graphNodes, 4);
    assert.equal(await TeamRewardEntry.countDocuments({ ...KEY, epochId: EPOCH }), 4);
    assert.equal(await UserRankSnapshot.countDocuments({ ...KEY, epochId: EPOCH }), 4);
    for (const id of ["root", "a", "b", "c"]) {
      const entry = (await team(id))!;
      assert.equal(entry.teamRewardACF, "0");
      assert.equal(entry.levelRewardACF, "0");
    }
  });

  it("38. teamRewardACF always equals level + rank + global", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkStake("L", { principalACF: 100n * E18 });
    for (let i = 0; i < 2; i++) {
      await mkUser(`d${i}`, "L");
      await mkStake(`d${i}`, {
        principalACF: 2_500n * E18, rewardACF: 50n * E18, stakeTimestamp: WINDOW_START + 1,
      });
    }
    await runTeamRewardEpoch(EPOCH);
    for (const entry of await TeamRewardEntry.find({ ...KEY, epochId: EPOCH })) {
      assert.equal(
        BigInt(entry.teamRewardACF),
        BigInt(entry.levelRewardACF) + BigInt(entry.rankRewardACF) + BigInt(entry.globalRewardACF),
        entry.userId,
      );
    }
  });

  it("39. re-running a settled epoch is a no-op", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("a", "root");
    await mkStake("a", { principalACF: 1n * E18, rewardACF: 100n * E18 });

    const first = await runTeamRewardEpoch(EPOCH);
    const second = await runTeamRewardEpoch(EPOCH);
    assert.equal(first.status, "CALCULATED");
    assert.equal(second.status, "SKIPPED");
    assert.equal(await TeamRewardEntry.countDocuments({ ...KEY, epochId: EPOCH }), 2);
    assert.equal(await LevelRewardCredit.countDocuments({ ...KEY, epochId: EPOCH }), 1);
  });

  it("40. two concurrent workers settle an epoch exactly once", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("a", "root");
    await mkStake("a", { principalACF: 1n * E18, rewardACF: 100n * E18 });

    const [x, y] = await Promise.all([runTeamRewardEpoch(EPOCH), runTeamRewardEpoch(EPOCH)]);
    const calculated = [x, y].filter((r) => r.status === "CALCULATED");
    assert.equal(calculated.length, 1);
    assert.equal(await TeamRewardEntry.countDocuments({ ...KEY, epochId: EPOCH }), 2);
    assert.equal(await LevelRewardCredit.countDocuments({ ...KEY, epochId: EPOCH }), 1);
  });

  it("41. an expired lease is reclaimable", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await RewardPhase2Epoch.create({
      ...KEY, epochId: EPOCH, status: "PROCESSING",
      leaseExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
      snapshotAt: SNAP, priceE18: P1.toString(),
    });
    assert.equal((await runTeamRewardEpoch(EPOCH)).status, "CALCULATED");
  });

  it("42. a retry recomputes identical values after a partial write", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("a", "root");
    await mkStake("a", { principalACF: 1n * E18, rewardACF: 100n * E18 });

    await runTeamRewardEpoch(EPOCH);
    const before = (await team("root"))!.toObject();
    const creditsBefore = await LevelRewardCredit.countDocuments({ ...KEY, epochId: EPOCH });

    // Force a rerun of the same epoch.
    await RewardPhase2Epoch.updateOne({ ...KEY, epochId: EPOCH }, { $set: { status: "FAILED" } });
    const again = await runTeamRewardEpoch(EPOCH);

    assert.equal(again.status, "CALCULATED");
    const after = (await team("root"))!.toObject();
    assert.equal(after.teamRewardACF, before.teamRewardACF);
    assert.equal(String(after._id), String(before._id), "the original row is kept, not replaced");
    assert.equal(await LevelRewardCredit.countDocuments({ ...KEY, epochId: EPOCH }), creditsBefore);
  });

  it("43. a persisted row that DIVERGES from recomputation fails loudly", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("a", "root");
    await mkStake("a", { principalACF: 1n * E18, rewardACF: 100n * E18 });
    await runTeamRewardEpoch(EPOCH);

    // Tamper with an immutable row, then rerun.
    await UserRankSnapshot.collection.updateOne(
      { ...KEY, epochId: EPOCH, userId: "root" }, { $set: { selfStakeACF: "123456" } },
    );
    await RewardPhase2Epoch.updateOne({ ...KEY, epochId: EPOCH }, { $set: { status: "FAILED" } });

    await assert.rejects(runTeamRewardEpoch(EPOCH),
      (e: unknown) => e instanceof RowVerificationError
        && /selfStakeACF expected/.test((e as Error).message));
    // The divergent row is reported, never overwritten.
    assert.equal(
      (await UserRankSnapshot.findOne({ ...KEY, epochId: EPOCH, userId: "root" }))!.selfStakeACF,
      "123456",
    );
    assert.equal((await RewardPhase2Epoch.findOne({ ...KEY, epochId: EPOCH }))!.status, "FAILED");
  });

  it("44. a missing row prevents CALCULATED", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("a", "root");
    await runTeamRewardEpoch(EPOCH);

    // Delete a row and rerun: the read-back must notice.
    await TeamRewardEntry.collection.deleteOne({ ...KEY, epochId: EPOCH, userId: "a" });
    await RewardPhase2Epoch.updateOne({ ...KEY, epochId: EPOCH }, { $set: { status: "FAILED" } });
    const r = await runTeamRewardEpoch(EPOCH);
    // The rerun reinserts it, so the epoch completes with the full set.
    assert.equal(r.status, "CALCULATED");
    assert.equal(await TeamRewardEntry.countDocuments({ ...KEY, epochId: EPOCH }), 2);
  });

  for (const [label, mutate] of [
    ["rankAudit", { "rankAudit.differentialRateE6": "999999" }],
    ["globalAudit", { "globalAudit.selfStakeACF": "424242" }],
    ["levelAudit.perLevel", { "levelAudit.perLevel.0.amountACF": "1" }],
  ] as const) {
    it(`44-${label}. a divergent nested audit object fails the retry`, async (t) => {
      if (!connected) return t.skip("no MONGODB_TEST_URI");
      await mkPhase1();
      await mkUser("root", null);
      await mkUser("a", "root");
      await mkStake("a", { principalACF: 1n * E18, rewardACF: 100n * E18 });
      await runTeamRewardEpoch(EPOCH);

      const before = (await team("root"))!.toObject();
      await TeamRewardEntry.collection.updateOne(
        { ...KEY, epochId: EPOCH, userId: "root" }, { $set: mutate as never },
      );
      await RewardPhase2Epoch.updateOne({ ...KEY, epochId: EPOCH }, { $set: { status: "FAILED" } });

      await assert.rejects(runTeamRewardEpoch(EPOCH),
        (e: unknown) => e instanceof RowVerificationError
          && new RegExp(label.split(".")[0]!).test((e as Error).message));

      // Reported, never repaired.
      const after = (await team("root"))!.toObject();
      assert.equal(String(after._id), String(before._id));
      assert.equal((await RewardPhase2Epoch.findOne({ ...KEY, epochId: EPOCH }))!.status, "FAILED");
    });
  }

  it("44-identical. identical nested audits retry idempotently", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1();
    await mkUser("root", null);
    await mkUser("a", "root");
    await mkStake("a", { principalACF: 1n * E18, rewardACF: 100n * E18 });
    await runTeamRewardEpoch(EPOCH);
    const before = (await team("root"))!.toObject();

    await RewardPhase2Epoch.updateOne({ ...KEY, epochId: EPOCH }, { $set: { status: "FAILED" } });
    const again = await runTeamRewardEpoch(EPOCH);

    assert.equal(again.status, "CALCULATED", "untouched audit objects must not diverge");
    const after = (await team("root"))!.toObject();
    assert.equal(String(after._id), String(before._id));
  });

  it("45. catch-up runs oldest first and halts on the first failure", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("root", null);
    await mkPhase1("CALCULATED", EPOCH);
    await mkPhase1("CALCULATED", EPOCH + 1);
    await mkPhase1("CALCULATED", EPOCH + 2);
    // Epoch+1 has a boundary-era stake with no entry, so it must fail.
    await mkStake("root", {
      principalACF: 1n * E18, stakeTimestamp: snapshotAtOf(EPOCH + 1) - 10, skipEntry: true,
    });

    const { processed, stoppedAt } = await catchUpTeamRewardEpochs();
    assert.equal(stoppedAt, EPOCH + 1, "halts at the failure, does not skip to EPOCH+2");
    assert.deepEqual(processed.map((p) => p.epochId), [EPOCH]);
    assert.equal(await RewardPhase2Epoch.countDocuments({ status: "CALCULATED" }), 1);
  });

  it("46. catch-up ignores epochs Phase 1 has not settled", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("root", null);
    await mkPhase1("CALCULATED", EPOCH);
    await mkPhase1("FAILED", EPOCH + 1);
    const { processed, stoppedAt } = await catchUpTeamRewardEpochs();
    assert.equal(stoppedAt, null);
    assert.deepEqual(processed.map((p) => p.epochId), [EPOCH]);
  });
});

/**
 * DAO staking reward propagating into Team, from epoch 41463.
 *
 * The rule changes WHICH staking rewards feed Level and Rank, and nothing else. These prove both
 * halves: that the new epoch includes DAO, and that an older epoch replayed today still excludes
 * it — the two settlement checkpoints already finalized on chain depend on the second.
 */
describe("DAO team propagation", () => {
  const NEW = DAO_TEAM_PROPAGATION_START_EPOCH;          // 41463
  const OLD = DAO_TEAM_PROPAGATION_START_EPOCH - 1;      // 41462
  const teamAt = (epochId: number, userId: string) =>
    TeamRewardEntry.findOne({ ...KEY, epochId, userId });
  const snapAt = (epochId: number, userId: string) =>
    UserRankSnapshot.findOne({ ...KEY, epochId, userId });

  it("19. the rule is chosen by epoch id, never by a clock", () => {
    assert.equal(teamPropagationRuleForEpoch(NEW), "ALL_SOURCES");
    assert.equal(teamPropagationRuleForEpoch(OLD), "REGULAR_ONLY");
    assert.equal(teamPropagationRuleForEpoch(NEW + 10_000), "ALL_SOURCES");
    // The already-settled epochs must keep their meaning.
    for (const settled of [41_459, 41_460, 41_461, 41_462]) {
      assert.equal(teamPropagationRuleForEpoch(settled), "REGULAR_ONLY", `epoch ${settled}`);
    }
  });

  it("20. epoch 41462 settles with REGULAR_ONLY propagation", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // The direct rule and the propagation rule are independent constants: this epoch settles
    // under the configured direct rule while DAO propagation is still excluded.
    assert.equal(directRuleForEpoch(OLD, 1), "REGISTERED_EOA", "the test cutover is epoch 1");
    assert.equal(teamPropagationRuleForEpoch(OLD), "REGULAR_ONLY", "DAO still excluded");

    await mkPhase1("CALCULATED", OLD);
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkUser("x", "L");
    await mkStake("x", { principalACF: 1n * E18, rewardACF: 100n * E18, source: "DAO", epochId: OLD });

    await runTeamRewardEpoch(OLD);
    assert.equal((await teamAt(OLD, "L"))!.levelRewardACF, "0", "DAO excluded at 41462");
    const epoch = await RewardPhase2Epoch.findOne({ ...KEY, epochId: OLD });
    assert.equal(epoch!.teamPropagationRule, "REGULAR_ONLY");
  });

  it("21. epoch 41463 settles with ALL_SOURCES propagation", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1("CALCULATED", NEW);
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkUser("x", "L");
    await mkStake("x", { principalACF: 1n * E18, rewardACF: 100n * E18, source: "DAO", epochId: NEW });

    await runTeamRewardEpoch(NEW);
    // 100 x 10% at L1 — the same formula the DIRECT and BOND rewards always used.
    assert.equal((await teamAt(NEW, "L"))!.levelRewardACF, (10n * E18).toString());
    const epoch = await RewardPhase2Epoch.findOne({ ...KEY, epochId: NEW });
    assert.equal(epoch!.teamPropagationRule, "ALL_SOURCES");
  });

  it("22. DIRECT, BOND and DAO each enter the base exactly once", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // The decisive arithmetic: 10 + 20 + 30 must be 60, not 30 and not 90.
    await mkPhase1("CALCULATED", NEW);
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkUser("x", "L");
    await mkStake("x", { principalACF: 1n * E18, rewardACF: 10n * E18, source: "DIRECT", epochId: NEW });
    await mkStake("x", { principalACF: 1n * E18, rewardACF: 20n * E18, source: "BOND", epochId: NEW });
    await mkStake("x", { principalACF: 1n * E18, rewardACF: 30n * E18, source: "DAO", epochId: NEW });

    await runTeamRewardEpoch(NEW);
    const credit = await LevelRewardCredit.findOne({
      ...KEY, epochId: NEW, beneficiaryUserId: "L", sourceUserId: "x",
    });
    assert.equal(credit!.sourcePropagationSelfRewardACF, (60n * E18).toString(), "60, once each");
    assert.equal(credit!.sourceRegularSelfRewardACF, (30n * E18).toString(), "DIRECT+BOND");
    assert.equal(credit!.sourceDAOStakingRewardACF, (30n * E18).toString(), "DAO");
    assert.equal(credit!.rewardACF, (6n * E18).toString(), "10% of 60");
    // And the audit row is self-describing: regular + DAO is the propagation figure.
    assert.equal(
      BigInt(credit!.sourceRegularSelfRewardACF) + BigInt(credit!.sourceDAOStakingRewardACF),
      BigInt(credit!.sourcePropagationSelfRewardACF),
    );
  });

  it("23. the same amounts give the same Level reward whatever the source", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1("CALCULATED", NEW);
    await mkUser("root", null);
    await mkUser("P", "root");
    await mkUser("direct", "P");
    await mkUser("dao", "P");
    await mkStake("direct", { principalACF: 1n * E18, rewardACF: 50n * E18, source: "DIRECT", epochId: NEW });
    await mkStake("dao", { principalACF: 1n * E18, rewardACF: 50n * E18, source: "DAO", epochId: NEW });

    await runTeamRewardEpoch(NEW);
    const fromDirect = await LevelRewardCredit.findOne({
      ...KEY, epochId: NEW, beneficiaryUserId: "P", sourceUserId: "direct" });
    const fromDAO = await LevelRewardCredit.findOne({
      ...KEY, epochId: NEW, beneficiaryUserId: "P", sourceUserId: "dao" });
    assert.equal(fromDAO!.rewardACF, fromDirect!.rewardACF, "source does not change the rate");
    assert.equal(fromDAO!.rateE6, fromDirect!.rateE6);
  });

  it("24. DAO reward reaches L2-L7 where those levels are unlocked", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1("CALCULATED", NEW);
    await mkUser("root", null);
    await mkUser("top", "root");
    // Four onboarded directs unlock all seven levels for `top` under the 41462 rule.
    for (const d of ["d1", "d2", "d3", "d4"]) await mkUser(d, "top");
    await mkUser("deep", "d1");
    await mkStake("deep", { principalACF: 1n * E18, rewardACF: 100n * E18, source: "DAO", epochId: NEW });

    await runTeamRewardEpoch(NEW);
    // `deep` is top's level 2: 100 x 8% = 8.
    const credit = await LevelRewardCredit.findOne({
      ...KEY, epochId: NEW, beneficiaryUserId: "top", sourceUserId: "deep" });
    assert.equal(credit!.relativeLevel, 2);
    assert.equal(credit!.rewardACF, (8n * E18).toString());
  });

  it("25. DAO reward joins Rank TeamRewardBase, and the leader's own never does", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase1("CALCULATED", NEW);
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkUser("x", "L");
    // The leader holds a DAO position too. Their own reward must stay out of their own base.
    await mkStake("L", { principalACF: 1n * E18, rewardACF: 999n * E18, source: "DAO", epochId: NEW });
    await mkStake("x", { principalACF: 1n * E18, rewardACF: 40n * E18, source: "DAO", epochId: NEW });

    await runTeamRewardEpoch(NEW);
    const entry = await teamAt(NEW, "L");
    assert.equal(
      entry!.rankAudit.teamRewardBaseACF, (40n * E18).toString(),
      "the downline's DAO reward, not the leader's own 999",
    );
  });

  it("26. rank qualification is unaffected: it reads principal, not reward", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Identical principal in both epochs; only the propagation rule differs.
    await mkPhase1("CALCULATED", OLD);
    await mkPhase1("CALCULATED", NEW);
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkUser("x", "L");
    await mkStake("L", { principalACF: 100n * E18, source: "DAO", epochId: OLD, alsoEpochs: [NEW] });
    await mkStake("x", {
      principalACF: 900n * E18, rewardACF: 7n * E18, source: "DAO",
      epochId: OLD, alsoEpochs: [NEW],
    });

    await runTeamRewardEpoch(OLD);
    await runTeamRewardEpoch(NEW);
    const before = (await snapAt(OLD, "L"))!;
    const after = (await snapAt(NEW, "L"))!;
    assert.equal(after.selfStakeACF, before.selfStakeACF, "self principal unchanged");
    assert.equal(after.teamStakeACF, before.teamStakeACF, "team principal unchanged");
    assert.equal(after.rank, before.rank, "and therefore the rank");
  });

  it("27. Global is identical under both rules for identical principal", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Global is computed from principal. No propagation flag may reach it.
    await mkPhase1("CALCULATED", OLD);
    await mkPhase1("CALCULATED", NEW);
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkUser("x", "L");
    // Created inside BOTH windows would double-count network contribution, so place them
    // before OLD's window: Global then depends only on principal, which is the point.
    const created = snapshotAtOf(OLD) - 50 * 43_200;
    await mkStake("L", {
      principalACF: 500n * E18, source: "DAO",
      epochId: OLD, alsoEpochs: [NEW], stakeTimestamp: created,
    });
    await mkStake("x", {
      principalACF: 700n * E18, rewardACF: 11n * E18, source: "DAO",
      epochId: OLD, alsoEpochs: [NEW], stakeTimestamp: created,
    });

    await runTeamRewardEpoch(OLD);
    await runTeamRewardEpoch(NEW);
    const before = (await teamAt(OLD, "L"))!;
    const after = (await teamAt(NEW, "L"))!;
    assert.equal(after.globalRewardACF, before.globalRewardACF, "Global unchanged");
    assert.deepEqual(
      JSON.parse(JSON.stringify(after.globalAudit)),
      JSON.parse(JSON.stringify(before.globalAudit)),
      "and every one of its inputs",
    );
    // Level, by contrast, moved — which is what makes the Global equality meaningful.
    assert.notEqual(after.levelRewardACF, before.levelRewardACF);
  });

  it("28. Team reward generated from DAO reward never re-enters Self", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Self lives in StakeRewardEntry; Team in TeamRewardEntry. SystemRevenue reads only the
    // former, so a larger Team output cannot inflate it or recurse into DAO member revenue.
    await mkPhase1("CALCULATED", NEW);
    await mkUser("root", null);
    await mkUser("L", "root");
    await mkUser("x", "L");
    await mkStake("x", { principalACF: 1n * E18, rewardACF: 100n * E18, source: "DAO", epochId: NEW });

    const selfBefore = (await StakeRewardEntry.find({ ...KEY, epochId: NEW }).lean())
      .reduce((sum, r) => sum + BigInt(r.rewardACF), 0n);
    await runTeamRewardEpoch(NEW);
    const selfAfter = (await StakeRewardEntry.find({ ...KEY, epochId: NEW }).lean())
      .reduce((sum, r) => sum + BigInt(r.rewardACF), 0n);

    assert.equal(selfAfter, selfBefore, "Phase 2 writes no Self reward");
    assert.equal(selfAfter, 100n * E18, "still just the DAO staking reward");
    assert.ok((await teamAt(NEW, "L"))!.levelRewardACF !== "0", "while Team did grow");
  });
});
