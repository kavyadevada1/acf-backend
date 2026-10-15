import { assertDisposable, TEST_ROOT_EOA } from "./testenv.ts";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { computeAggregates } from "./rank.js";
import { computeLevelRewards } from "./level.js";
import {
  ONBOARDED_DIRECT_RULE_START_EPOCH,
  DAO_TEAM_PROPAGATION_START_EPOCH,
  directRuleForEpoch,
  teamPropagationRuleForEpoch,
  unlockedLevels,
  LEVEL_RATES,
  RANK_TIERS,
} from "./policy.js";
import type { AsOfGraph } from "./graph.js";
import { foldByUser, type UserStakeTotals } from "./inputs.js";

/**
 * The registered-EOA direct rule.
 *
 * A referral qualifies its referrer from their first successful registration. There is no wallet
 * to create and no stake to hold: the address that authenticated is the protocol identity, so
 * being a registered user and being a qualifying direct are the same fact, read as-of the epoch's
 * snapshot.
 *
 * The tree is untouched by the rule: every registered user keeps its parent and its relative
 * distance, and nobody is compressed out.
 */

const PRICE_E18 = 10n ** 18n; // 1 ACF = $1, so ACF and USD6 differ only by scale
const USD = 1_000_000n;
const NOVA = RANK_TIERS.find((t) => t.n === 1)!;

/**
 * A graph built by hand. `registered` is passed separately from the edges so a test can state a
 * node that is in the tree but not yet qualifying — which the loader cannot actually produce,
 * and that is the point: the aggregation must not assume the two sets coincide.
 */
function graphOf(
  edges: Record<string, string[]>,
  registered: string[],
  rootUserId = "root",
): AsOfGraph {
  const parentOf = new Map<string, string | null>([[rootUserId, null]]);
  const childrenOf = new Map<string, string[]>();
  for (const [parent, children] of Object.entries(edges)) {
    childrenOf.set(parent, children);
    for (const child of children) parentOf.set(child, parent);
  }
  // Children before parents: deepest first by distance to the root.
  const depth = (u: string): number => {
    let d = 0;
    let cur: string | null = u;
    while (cur && parentOf.get(cur)) { cur = parentOf.get(cur)!; d += 1; }
    return d;
  };
  const bottomUpOrder = [...parentOf.keys()].sort((a, b) => depth(b) - depth(a));
  return {
    rootUserId,
    userIds: [...parentOf.keys()],
    parentOf,
    childrenOf,
    bottomUpOrder,
    registeredAsOf: new Set(registered),
    registrationBasis: "APPLICATION_TIMESTAMP",
  };
}

const stake = (acf: bigint): UserStakeTotals => ({
  ownActiveStakeACF: acf,
  ownRegularSelfACF: 0n,
  ownDAOSelfACF: 0n,
  ownPropagatingSelfACF: 0n,
});

/** Own stake plus a self reward, so this user is a Level Income source. */
const earning = (acf: bigint, reward: bigint): UserStakeTotals => ({
  ownActiveStakeACF: acf,
  ownRegularSelfACF: reward,
  ownDAOSelfACF: 0n,
  // No DAO position here, so the propagating total is the regular one under either rule.
  ownPropagatingSelfACF: reward,
});

describe("registered-EOA rule — Level unlock", () => {
  it("1. a registered direct counts with no stake of its own", () => {
    const graph = graphOf({ root: ["leader"], leader: ["d1"] }, ["root", "leader", "d1"]);
    const totals = new Map([["leader", stake(0n)], ["d1", stake(0n)]]);
    const agg = computeAggregates(graph, totals, PRICE_E18);
    assert.equal(agg.get("leader")!.registeredDirects, 1);
    assert.equal(unlockedLevels(agg.get("leader")!.registeredDirects), 1);
  });

  it("2. a direct with zero stakes still qualifies its referrer", () => {
    const graph = graphOf({ root: ["leader"], leader: ["d1", "d2"] },
      ["root", "leader", "d1", "d2"]);
    // Nobody in the downline holds anything at all.
    const totals = new Map([["leader", stake(0n)], ["d1", stake(0n)], ["d2", stake(0n)]]);
    const agg = computeAggregates(graph, totals, PRICE_E18);
    assert.equal(agg.get("leader")!.activeDirects, 0, "no direct holds an active stake");
    assert.equal(agg.get("leader")!.registeredDirects, 2);
    assert.equal(unlockedLevels(2), 2, "two registered directs unlock through L2");
  });

  it("3. the unlock ladder is 1->L1, 2->L2, 3->L3, 4+->L7", () => {
    assert.equal(unlockedLevels(0), 0);
    assert.equal(unlockedLevels(1), 1);
    assert.equal(unlockedLevels(2), 2);
    assert.equal(unlockedLevels(3), 3);
    // Four unlocks all seven at once; there is no 5/6/7 tier.
    assert.equal(unlockedLevels(4), LEVEL_RATES.length);
    assert.equal(unlockedLevels(9), LEVEL_RATES.length);
  });

  it("4. a direct not registered as of the snapshot does not count", () => {
    // d2 is in the tree but outside registeredAsOf: the aggregation must not count it.
    const graph = graphOf({ root: ["leader"], leader: ["d1", "d2"] }, ["root", "leader", "d1"]);
    const totals = new Map([["leader", stake(0n)], ["d1", stake(0n)], ["d2", stake(0n)]]);
    const agg = computeAggregates(graph, totals, PRICE_E18);
    assert.equal(agg.get("leader")!.directCount, 2, "both are still directs");
    assert.equal(agg.get("leader")!.registeredDirects, 1, "only one qualifies");
    assert.equal(unlockedLevels(agg.get("leader")!.registeredDirects), 1);
  });
});

describe("registered-EOA rule — Rank qualification", () => {
  it("5. two registered directs satisfy Nova's direct requirement with NO stake among them", () => {
    assert.equal(NOVA.requiredDirects, 2, "Nova requires two directs");
    // The stake requirements are untouched by this rule, so they are met from elsewhere in the
    // downline: a grandchild carries the team stake and BOTH directs hold nothing at all.
    const graph = graphOf({ root: ["leader"], leader: ["d1", "d2"], d1: ["g1"] },
      ["root", "leader", "d1", "d2", "g1"]);
    const acf = (usd6: bigint) => usd6 * (10n ** 18n) / USD;
    const totals = new Map([
      ["leader", stake(acf(NOVA.selfUSD6))],
      ["d1", stake(0n)],
      ["d2", stake(0n)],
      ["g1", stake(acf(NOVA.teamUSD6!))],
    ]);
    const leader = computeAggregates(graph, totals, PRICE_E18).get("leader")!;

    assert.equal(leader.activeDirects, 0, "the direct requirement is NOT active stake");
    assert.equal(leader.registeredDirects, 2, "it is registration");
    assert.ok(leader.registeredDirects >= NOVA.requiredDirects, "so the requirement is met");
    // Nova is reached on zero staking directs, which the old rule could never have produced.
    assert.equal(leader.rank, NOVA.n, `reached rank ${leader.rank}`);
  });

  it("6. qualifyingDirects is the registered count, never the active-stake count", () => {
    const graph = graphOf({ root: ["leader"], leader: ["d1", "d2", "d3"] },
      ["root", "leader", "d1", "d2", "d3"]);
    const totals = new Map([
      ["leader", stake(0n)],
      ["d1", stake(5n * 10n ** 18n)],   // one direct does hold stake
      ["d2", stake(0n)],
      ["d3", stake(0n)],
    ]);
    const leader = computeAggregates(graph, totals, PRICE_E18).get("leader")!;
    assert.equal(leader.activeDirects, 1, "only one direct holds stake");
    assert.equal(leader.registeredDirects, 3, "but all three qualify");
    assert.notEqual(leader.registeredDirects, leader.activeDirects);
  });
});

describe("the tree is not restructured", () => {
  it("7. an unqualified parent is skipped as a direct, and its child stays at relative level 2", () => {
    // A is in the tree but not registered as of the snapshot. E is A's child.
    const graph = graphOf({ root: ["leader"], leader: ["A"], A: ["E"] },
      ["root", "leader", "E"]);
    const totals = new Map([
      ["leader", stake(0n)],
      ["A", stake(0n)],
      ["E", earning(0n, 1_000n)],
    ]);
    const agg = computeAggregates(graph, totals, PRICE_E18);
    // The leader has one direct, A, which does not qualify.
    assert.equal(agg.get("leader")!.directCount, 1);
    assert.equal(agg.get("leader")!.registeredDirects, 0);
    // E is still at relative level 2 from the leader: not compressed up into A's place.
    assert.ok(graph.parentOf.get("E") === "A", "E keeps its parent");
    assert.ok(graph.childrenOf.get("leader")!.includes("A"), "A keeps its place");
    assert.equal(graph.userIds.includes("A"), true, "A is not removed from the graph");
  });

  it("8. a leader with four registered directs unlocks all seven levels", () => {
    const graph = graphOf({ root: ["leader"], leader: ["d1", "d2", "d3", "d4"] },
      ["root", "leader", "d1", "d2", "d3", "d4"]);
    const totals = new Map([["leader", stake(0n)],
      ["d1", stake(0n)], ["d2", stake(0n)], ["d3", stake(0n)], ["d4", stake(0n)]]);
    const leader = computeAggregates(graph, totals, PRICE_E18).get("leader")!;
    assert.equal(leader.registeredDirects, 4);
    assert.equal(unlockedLevels(leader.registeredDirects), 7);
  });
});

describe("an unqualified ancestor does not block its descendants", () => {
  // root -> Leader -> A -> E. A is in the tree but not registered as of the snapshot; E earns.
  const graph = graphOf(
    { root: ["Leader"], Leader: ["A", "B"], A: ["E"] },
    ["root", "Leader", "B", "E"],
  );
  const totals = new Map<string, UserStakeTotals>([
    ["Leader", stake(0n)],
    ["A", stake(0n)],
    ["B", stake(0n)],
    ["E", earning(0n, 10_000n)],
  ]);
  const agg = computeAggregates(graph, totals, PRICE_E18);

  it("Leader counts 1 registered direct and unlocks 1 level", () => {
    assert.equal(agg.get("Leader")!.directCount, 2, "A and B are both directs");
    assert.equal(agg.get("Leader")!.registeredDirects, 1, "only B qualifies");
    assert.equal(unlockedLevels(1), 1);
  });

  it("E stays at relative level 2 from Leader — no compression, not removed", () => {
    assert.equal(graph.parentOf.get("E"), "A");
    assert.equal(graph.parentOf.get("A"), "Leader");
    assert.ok(graph.userIds.includes("A"));
  });

  it("A itself still earns level 1 from E, despite not qualifying anyone", () => {
    // Not qualifying as someone else's direct says nothing about A's own unlock: A has one
    // registered direct of its own only if E is registered, which it is.
    const level = computeLevelRewards(graph, agg);
    const toA = level.totals.get("A");
    assert.ok(toA !== undefined, "A receives Level Income");
    assert.equal(toA, (10_000n * LEVEL_RATES[0]!) / 1_000_000n);
  });

  it("the graph passed to level rewards still contains the unqualified node", () => {
    const level = computeLevelRewards(graph, agg);
    assert.ok(level.totals instanceof Map);
    assert.equal(graph.userIds.includes("A"), true);
  });
});

describe("DAO team propagation is pinned to one epoch", () => {
  it("the start epoch is 41463, which begins 2026-10-05 12:00:00 UTC", () => {
    // Pinned to the literal, not to itself. Tests written relative to the constant move with it,
    // so only an absolute assertion catches the activation being shifted by an epoch — and an
    // epoch here is twelve hours of settlements under the wrong rule.
    assert.equal(DAO_TEAM_PROPAGATION_START_EPOCH, 41_463);
    assert.equal(
      new Date(DAO_TEAM_PROPAGATION_START_EPOCH * 43_200 * 1000).toISOString(),
      "2026-10-05T12:00:00.000Z",
    );
  });

  it("every already-settled epoch keeps the exclusion", () => {
    for (const settled of [41_459, 41_460, 41_461, 41_462]) {
      assert.equal(teamPropagationRuleForEpoch(settled), "REGULAR_ONLY", `epoch ${settled}`);
    }
    assert.equal(teamPropagationRuleForEpoch(41_463), "ALL_SOURCES");
  });

  it("the propagating total adds each source exactly once", () => {
    // 10 DIRECT + 20 BOND + 30 DAO must be 60 under ALL_SOURCES and 30 under REGULAR_ONLY.
    const facts = [
      { stakeId: "1", userId: "u", source: "DIRECT" as const, principalACF: 0n,
        activeAtSnapshot: true, regularSelfACF: 10n, daoSelfACF: 0n, stakeTimestamp: 0 },
      { stakeId: "2", userId: "u", source: "BOND" as const, principalACF: 0n,
        activeAtSnapshot: true, regularSelfACF: 20n, daoSelfACF: 0n, stakeTimestamp: 0 },
      { stakeId: "3", userId: "u", source: "DAO" as const, principalACF: 0n,
        activeAtSnapshot: true, regularSelfACF: 0n, daoSelfACF: 30n, stakeTimestamp: 0 },
    ];
    assert.equal(foldByUser(facts, "ALL_SOURCES").get("u")!.ownPropagatingSelfACF, 60n);
    assert.equal(foldByUser(facts, "REGULAR_ONLY").get("u")!.ownPropagatingSelfACF, 30n);
    // The components keep their own fixed meanings under both rules.
    for (const rule of ["ALL_SOURCES", "REGULAR_ONLY"] as const) {
      const t = foldByUser(facts, rule).get("u")!;
      assert.equal(t.ownRegularSelfACF, 30n, "DIRECT+BOND, always");
      assert.equal(t.ownDAOSelfACF, 30n, "DAO, always");
    }
  });
});

describe("policy versioning: the cutover is configured, never guessed", () => {
  const START = 50_000; // a stand-in cutover, passed explicitly

  it("9. the rule is selected by epoch and cutover, not by a clock", () => {
    assert.equal(directRuleForEpoch(START, START), "REGISTERED_EOA");
    assert.equal(directRuleForEpoch(START + 1_000, START), "REGISTERED_EOA");
    // Called twice with the same inputs, a year apart, it must answer the same thing.
    assert.equal(directRuleForEpoch(START, START), directRuleForEpoch(START, START));
  });

  it("10. the boundary is inclusive: the cutover epoch itself settles under the new rule", () => {
    assert.equal(directRuleForEpoch(START, START), "REGISTERED_EOA");
    assert.notEqual(directRuleForEpoch(START - 1, START), "REGISTERED_EOA");
  });

  it("11. historical rules are still selectable below the cutover", () => {
    // Their semantics are preserved as a record; epoch.ts refuses to SETTLE them, because the
    // smart-wallet facts they were derived from no longer exist.
    assert.equal(directRuleForEpoch(ONBOARDED_DIRECT_RULE_START_EPOCH, START), "ONBOARDED");
    assert.equal(directRuleForEpoch(ONBOARDED_DIRECT_RULE_START_EPOCH - 1, START), "ACTIVE_STAKE");
    assert.equal(directRuleForEpoch(41_459, START), "ACTIVE_STAKE");
  });

  it("12. a cutover at or below the first epoch makes every epoch REGISTERED_EOA", () => {
    // Which is the intended pre-launch configuration: one rule, from the first clean epoch.
    for (const epochId of [1, 2, 41_462, 99_999]) {
      assert.equal(directRuleForEpoch(epochId, 1), "REGISTERED_EOA", `epoch ${epochId}`);
    }
  });

  it("13. the audit counts are all retained, so a row explains itself", () => {
    const graph = graphOf({ root: ["leader"], leader: ["d1", "d2"] },
      ["root", "leader", "d1", "d2"]);
    const totals = new Map([["leader", stake(0n)],
      ["d1", stake(7n * 10n ** 18n)], ["d2", stake(0n)]]);
    const n = computeAggregates(graph, totals, PRICE_E18).get("leader")!;
    // Three distinct counts, each meaning something different, none inferred from the others.
    assert.equal(n.directCount, 2, "every direct referral");
    assert.equal(n.activeDirects, 1, "those holding active stake, informational only");
    assert.equal(n.registeredDirects, 2, "those registered as of the snapshot");
  });
});

describe("loadAsOfGraph: registration decides qualification, as-of the snapshot", () => {
  const TEST_URI = process.env.MONGODB_TEST_URI;
  let connected = false;

  before(async () => {
    if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set"); return; }
    const { default: mongoose } = await import("mongoose");
    await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
    connected = true;
  });
  after(async () => {
    if (!connected) return;
    const { default: mongoose } = await import("mongoose");
    await mongoose.disconnect();
  });

  const BOUNDARY = 50_000 * 43_200;
  let seq = 0;

  /** Seeds a user registered at an exact second. Nothing else decides qualification. */
  async function seed(userId: string, parent: string | null, registeredAtSec: number): Promise<void> {
    const { User } = await import("../../models/User.js");
    seq += 1;
    await User.collection.insertOne({
      userId,
      externalEOA: `0x${seq.toString(16).padStart(40, "0")}`,
      referralCode: `ACF-REG-${seq}`,
      referredByUserId: parent,
      createdAt: new Date(registeredAtSec * 1000),
      updatedAt: new Date(registeredAtSec * 1000),
    } as never);
  }

  async function seedRoot(): Promise<void> {
    const { User } = await import("../../models/User.js");
    await User.collection.insertOne({
      userId: "reg_root",
      externalEOA: TEST_ROOT_EOA.toLowerCase(),
      referralCode: "ACF-REG-ROOT",
      referredByUserId: null,
      createdAt: new Date((BOUNDARY - 1_000_000) * 1000),
      updatedAt: new Date((BOUNDARY - 1_000_000) * 1000),
    } as never);
  }

  it("14-16. before counts, exactly at the boundary counts, after does not", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { User } = await import("../../models/User.js");
    const { loadAsOfGraph } = await import("./graph.js");
    await User.deleteMany({});
    seq = 0;
    await seedRoot();

    await seed("before", "reg_root", BOUNDARY - 60);
    await seed("exactly", "reg_root", BOUNDARY);        // `<=`, so this one qualifies
    await seed("after", "reg_root", BOUNDARY + 60);

    const graph = await loadAsOfGraph(BOUNDARY);
    assert.ok(graph.registeredAsOf.has("before"), "registered a minute earlier");
    assert.ok(graph.registeredAsOf.has("exactly"), "registered ON the boundary second");
    assert.ok(!graph.registeredAsOf.has("after"), "registered after the boundary");
    // And a later epoch sees all three.
    const later = await loadAsOfGraph(BOUNDARY + 43_200);
    for (const id of ["before", "exactly", "after"]) {
      assert.ok(later.registeredAsOf.has(id), `${id} qualifies in the later epoch`);
    }
  });

  it("17. a later registration cannot leak backward into a settled epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { User } = await import("../../models/User.js");
    const { loadAsOfGraph } = await import("./graph.js");
    await User.deleteMany({});
    seq = 0;
    await seedRoot();
    await seed("early", "reg_root", BOUNDARY - 60);

    const before = await loadAsOfGraph(BOUNDARY);
    assert.equal(before.registeredAsOf.size, 2, "root and early");

    // A new direct registers after that epoch closed.
    await seed("late", "reg_root", BOUNDARY + 43_200);
    const replayed = await loadAsOfGraph(BOUNDARY);
    assert.equal(replayed.registeredAsOf.size, 2, "the earlier epoch is unchanged on replay");
    assert.ok(!replayed.registeredAsOf.has("late"));
    assert.ok(!replayed.userIds.includes("late"), "and is not even in that graph");
  });

  it("18. every member of the as-of graph is a qualifying direct, with no stake anywhere", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { User } = await import("../../models/User.js");
    const { loadAsOfGraph } = await import("./graph.js");
    await User.deleteMany({});
    seq = 0;
    await seedRoot();
    for (const id of ["a", "b", "c"]) await seed(id, "reg_root", BOUNDARY - 100);

    const graph = await loadAsOfGraph(BOUNDARY);
    // The rule's defining property: membership and qualification are the same set.
    assert.deepEqual([...graph.registeredAsOf].sort(), [...graph.userIds].sort());
    assert.equal(graph.registrationBasis, "APPLICATION_TIMESTAMP");

    // Three registered directs, no Stake rows at all, unlocks three levels.
    const totals = new Map([["reg_root", stake(0n)]]);
    const root = computeAggregates(graph, totals, PRICE_E18).get("reg_root")!;
    assert.equal(root.registeredDirects, 3);
    assert.equal(root.activeDirects, 0);
    assert.equal(unlockedLevels(root.registeredDirects), 3);
  });

  it("19. an address that never registered is not in the tree and cannot qualify anyone", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { User } = await import("../../models/User.js");
    const { loadAsOfGraph } = await import("./graph.js");
    await User.deleteMany({});
    seq = 0;
    await seedRoot();
    await seed("registered", "reg_root", BOUNDARY - 100);

    const graph = await loadAsOfGraph(BOUNDARY);
    // There is no record of this address anywhere, so there is nothing to qualify.
    assert.ok(!graph.userIds.includes("0x000000000000000000000000000000000000dead"));
    assert.ok(!graph.registeredAsOf.has("0x000000000000000000000000000000000000dead"));
    assert.equal(graph.childrenOf.get("reg_root")!.length, 1, "one direct, not two");
  });
});
