import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { assertDisposable, TEST_ROOT_EOA } from "./testenv.ts";

const TEST_URI = process.env.MONGODB_TEST_URI;

const { loadAsOfGraph, uplinesOf, GraphIntegrityError, GraphTooLargeError } =
  await import("./graph.js");
const { computeAggregates } = await import("./rank.js");
const { resolveRank, QUALIFIER_THRESHOLDS, REQUIRED_QUALIFIERS, acfToUsd6, USD } =
  await import("./policy.js");
const { User } = await import("../../models/User.js");
import type { UserStakeTotals } from "./inputs.ts";

const E18 = 10n ** 18n;
const P1 = E18;
const SNAPSHOT = 1_771_200_000;              // a fixed, far-past boundary

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await User.init();
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => { if (connected) await User.deleteMany({}); });

let seq = 0;
/** Creates a user with an explicit parent and registration time. */
const mkUser = async (
  userId: string,
  parent: string | null,
  createdAtSec = SNAPSHOT - 86_400,
  eoa?: string,
) => {
  seq += 1;
  await User.collection.insertOne({
    userId,
    externalEOA: eoa ?? `0x${seq.toString(16).padStart(40, "0")}`,
    referralCode: `ACF-${userId.toUpperCase()}`,
    referredByUserId: parent,
    createdAt: new Date(createdAtSec * 1000),
    updatedAt: new Date(createdAtSec * 1000),
  } as never);
};
const mkRoot = (createdAtSec = SNAPSHOT - 200_000) =>
  mkUser("root", null, createdAtSec, TEST_ROOT_EOA);

const noStake: UserStakeTotals =
  { ownActiveStakeACF: 0n, ownRegularSelfACF: 0n, ownDAOSelfACF: 0n, ownPropagatingSelfACF: 0n };

describe("as-of graph validation", () => {
  it("1. the configured ROOT is accepted as the sole parentless node", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    await mkUser("alice", "root");
    await mkUser("bob", "alice");

    const g = await loadAsOfGraph(SNAPSHOT);
    assert.equal(g.rootUserId, "root");
    assert.equal(g.userIds.length, 3);
    assert.deepEqual(g.childrenOf.get("root"), ["alice"]);
    assert.deepEqual(g.childrenOf.get("alice"), ["bob"]);
  });

  it("2. a user registered AFTER the boundary is excluded", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    await mkUser("alice", "root", SNAPSHOT - 10);
    await mkUser("late", "root", SNAPSHOT + 1);

    const g = await loadAsOfGraph(SNAPSHOT);
    assert.deepEqual(g.userIds.sort(), ["alice", "root"]);
    assert.deepEqual(g.childrenOf.get("root"), ["alice"], "the late child must not appear");
  });

  it("3. a user registered EXACTLY at the boundary is included", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    await mkUser("edge", "root", SNAPSHOT);
    const g = await loadAsOfGraph(SNAPSHOT);
    assert.ok(g.userIds.includes("edge"));
  });

  it("4. the graph is rooted at the parentless user, whatever wallet it holds", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // The logical root is identified by TREE POSITION, so Phase 2 does not care which wallet it
    // answers to — and a ROOT EOA rotation therefore cannot disturb the graph at all. This used
    // to assert a mismatch against a configured ROOT address; there is no such address now, and
    // the invariant that remains is the shape one, covered here and in case 5.
    await mkUser("root", null, SNAPSHOT - 200_000, TEST_ROOT_EOA);
    await mkUser("child", "root", SNAPSHOT - 100_000);
    const before = await loadAsOfGraph(SNAPSHOT);

    // Rebind the root's wallet exactly as rootSync does, then reload: identical graph.
    await User.collection.updateOne(
      { userId: "root" },
      { $set: { externalEOA: "0x00000000000000000000000000000000000000b1" } },
    );
    const after = await loadAsOfGraph(SNAPSHOT);
    assert.deepEqual(after.userIds.slice().sort(), before.userIds.slice().sort());
    assert.deepEqual(after.parentOf, before.parentOf);
  });

  it("5. two parentless users fail", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    await mkUser("second-root", null);
    await assert.rejects(loadAsOfGraph(SNAPSHOT), GraphIntegrityError);
  });

  it("6. no ROOT record at all fails", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await assert.rejects(loadAsOfGraph(SNAPSHOT),
      (e: unknown) => /has no user record/.test((e as Error).message));
  });

  it("7. a ROOT that registered after the boundary fails", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot(SNAPSHOT + 100);
    await assert.rejects(loadAsOfGraph(SNAPSHOT),
      (e: unknown) => /after this epoch's boundary/.test((e as Error).message));
  });

  it("8. an orphan whose parent is outside the as-of set fails", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    await mkUser("parent", "root", SNAPSHOT + 50);   // registered after the boundary
    await mkUser("child", "parent", SNAPSHOT - 50);  // but the child registered before it
    await assert.rejects(loadAsOfGraph(SNAPSHOT),
      (e: unknown) => /absent from the as-of graph/.test((e as Error).message));
  });

  it("9. a cycle fails rather than looping", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    await mkUser("a", "b");
    await mkUser("b", "a");                          // mutual parents, detached from ROOT
    await assert.rejects(loadAsOfGraph(SNAPSHOT),
      (e: unknown) => e instanceof GraphIntegrityError
        && /not reachable from ROOT/.test((e as Error).message));
  });

  it("10. the node ceiling fails loudly and never truncates", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    for (let i = 0; i < 5; i++) await mkUser(`u${i}`, "root");
    const original = process.env.REWARD_PHASE2_MAX_GRAPH_NODES;
    try {
      // The ceiling is read from config at import time, so assert the error shape directly.
      const { config } = await import("../../config.js");
      const saved = config.phase2MaxGraphNodes;
      Object.defineProperty(config, "phase2MaxGraphNodes", { value: 3, configurable: true });
      await assert.rejects(loadAsOfGraph(SNAPSHOT),
        (e: unknown) => e instanceof GraphTooLargeError
          && /over the configured ceiling/.test((e as Error).message));
      Object.defineProperty(config, "phase2MaxGraphNodes", { value: saved, configurable: true });
    } finally {
      process.env.REWARD_PHASE2_MAX_GRAPH_NODES = original;
    }
  });

  it("11. a deep chain resolves without recursion limits", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    let parent = "root";
    for (let i = 0; i < 300; i++) {
      await mkUser(`d${i}`, parent);
      parent = `d${i}`;
    }
    const g = await loadAsOfGraph(SNAPSHOT);
    assert.equal(g.userIds.length, 301);
    // Every child precedes its parent in the bottom-up order.
    const position = new Map(g.bottomUpOrder.map((u, i) => [u, i]));
    for (const [child, p] of g.parentOf) {
      if (p === null) continue;
      assert.ok(position.get(child)! < position.get(p)!, `${child} must precede ${p}`);
    }
  });

  it("12. uplines walk at most the requested depth and stop at ROOT", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    let parent = "root";
    for (let i = 0; i < 10; i++) { await mkUser(`n${i}`, parent); parent = `n${i}`; }
    const g = await loadAsOfGraph(SNAPSHOT);

    const seven = uplinesOf(g, "n9", 7);
    assert.equal(seven.length, 7, "capped at seven");
    assert.deepEqual(seven.map((u) => u.userId), ["n8", "n7", "n6", "n5", "n4", "n3", "n2"]);
    assert.deepEqual(seven.map((u) => u.relativeLevel), [1, 2, 3, 4, 5, 6, 7]);

    // A shallow user yields only the ancestors that exist.
    assert.equal(uplinesOf(g, "n0", 7).length, 1);
    assert.equal(uplinesOf(g, "root", 7).length, 0);
  });
});

describe("post-order pass matches a slower oracle", () => {
  /**
   * The specification's iterative fixed-point resolver, implemented ONLY here.
   *
   * Production uses a single bottom-up pass; this repeats full passes until nothing changes.
   * Both must agree, which is what justifies the faster implementation.
   */
  function oracleRanks(
    userIds: string[],
    childrenOf: Map<string, string[]>,
    totals: Map<string, UserStakeTotals>,
    priceE18: bigint,
  ): Map<string, number> {
    const descendantsOf = new Map<string, string[]>();
    const collect = (u: string): string[] => {
      if (descendantsOf.has(u)) return descendantsOf.get(u)!;
      const out: string[] = [];
      for (const c of childrenOf.get(u) ?? []) { out.push(c, ...collect(c)); }
      descendantsOf.set(u, out);
      return out;
    };
    for (const u of userIds) collect(u);

    const ownStake = (u: string) => totals.get(u)?.ownActiveStakeACF ?? 0n;
    const subtreeStake = (u: string): bigint =>
      ownStake(u) + (descendantsOf.get(u) ?? []).reduce((s, d) => s + ownStake(d), 0n);

    const ranks = new Map<string, number>(userIds.map((u) => [u, 0]));
    for (let pass = 0; pass < 24; pass++) {
      let changed = false;
      for (const u of userIds) {
        const descendants = descendantsOf.get(u) ?? [];
        const q = new Map<number, number>();
        for (const r of QUALIFIER_THRESHOLDS) {
          const n = descendants.filter((d) => (ranks.get(d) ?? 0) >= r).length;
          q.set(r, Math.min(n, REQUIRED_QUALIFIERS));
        }
        const next = resolveRank({
          selfStakeUSD6: acfToUsd6(ownStake(u), priceE18),
          teamStakeUSD6: acfToUsd6(subtreeStake(u) - ownStake(u), priceE18),
          qualifyingDirects: (childrenOf.get(u) ?? []).filter((c) => ownStake(c) > 0n).length,
          qualifiersAtOrAbove: q,
        });
        if (next !== ranks.get(u)) { ranks.set(u, next); changed = true; }
      }
      if (!changed) break;
    }
    return ranks;
  }

  it("13. a six-deep Master chain resolves identically in one pass", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    // root -> l1 -> l2 -> ... -> l6, each heavily staked with 7+ staked directs.
    let parent = "root";
    const leaders = ["l1", "l2", "l3", "l4", "l5", "l6"];
    for (const l of leaders) { await mkUser(l, parent); parent = l; }
    // Give every leader enough staked directs to clear Master's 7.
    for (const l of ["root", ...leaders]) {
      for (let i = 0; i < 8; i++) await mkUser(`${l}-d${i}`, l);
    }

    const g = await loadAsOfGraph(SNAPSHOT);
    const totals = new Map<string, UserStakeTotals>();
    for (const u of g.userIds) {
      // Leaders hold a large self stake; the padding directs hold a little so they count.
      const isLeader = u === "root" || leaders.includes(u);
      totals.set(u, {
        ownActiveStakeACF: isLeader ? 100_000n * E18 : 30_000n * E18,
        ownRegularSelfACF: 0n,
        ownDAOSelfACF: 0n,
        ownPropagatingSelfACF: 0n,
      });
    }

    const mine = computeAggregates(g, totals, P1);
    const oracle = oracleRanks(g.userIds, g.childrenOf, totals, P1);

    for (const u of g.userIds) {
      assert.equal(mine.get(u)!.rank, oracle.get(u),
        `${u}: one-pass gave ${mine.get(u)!.rank}, oracle gave ${oracle.get(u)}`);
    }
    // And the chain really does climb above Master.
    assert.ok(mine.get("root")!.rank >= 7, `root reached ${mine.get("root")!.rank}`);
  });

  it("14. a wide random tree resolves identically", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    const ids = ["root"];
    for (let i = 0; i < 60; i++) {
      const parent = ids[i % ids.length]!;
      const id = `w${i}`;
      await mkUser(id, parent);
      ids.push(id);
    }
    const g = await loadAsOfGraph(SNAPSHOT);
    const totals = new Map<string, UserStakeTotals>();
    for (const [i, u] of g.userIds.entries()) {
      totals.set(u, {
        ownActiveStakeACF: BigInt((i * 977) % 30_000) * E18,
        ownRegularSelfACF: 0n,
        ownDAOSelfACF: 0n,
        ownPropagatingSelfACF: 0n,
      });
    }
    const mine = computeAggregates(g, totals, P1);
    const oracle = oracleRanks(g.userIds, g.childrenOf, totals, P1);
    for (const u of g.userIds) {
      assert.equal(mine.get(u)!.rank, oracle.get(u), `${u}`);
    }
  });

  it("15. aggregates are exact: team excludes self, L1 counts only children", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    await mkUser("a", "root");
    await mkUser("b", "a");
    await mkUser("c", "b");                  // depth 3, beyond L1

    const g = await loadAsOfGraph(SNAPSHOT);
    const totals = new Map<string, UserStakeTotals>([
      ["root", { ownActiveStakeACF: 10n * E18, ownRegularSelfACF: 1n * E18, ownDAOSelfACF: 0n, ownPropagatingSelfACF: 1n * E18 }],
      ["a", { ownActiveStakeACF: 20n * E18, ownRegularSelfACF: 2n * E18, ownDAOSelfACF: 0n, ownPropagatingSelfACF: 2n * E18 }],
      ["b", { ownActiveStakeACF: 30n * E18, ownRegularSelfACF: 3n * E18, ownDAOSelfACF: 0n, ownPropagatingSelfACF: 3n * E18 }],
      ["c", { ownActiveStakeACF: 40n * E18, ownRegularSelfACF: 4n * E18, ownDAOSelfACF: 0n, ownPropagatingSelfACF: 4n * E18 }],
    ]);
    const agg = computeAggregates(g, totals, P1);

    const rootAgg = agg.get("root")!;
    assert.equal(rootAgg.subtreeActiveStakeACF, 100n * E18);
    assert.equal(rootAgg.teamStakeACF, 90n * E18, "excludes root's own 10");
    assert.equal(rootAgg.l1StakeACF, 20n * E18, "only 'a', not b or c");
    assert.equal(rootAgg.directCount, 1);
    assert.equal(rootAgg.teamRewardBaseACF, 9n * E18, "2+3+4, excluding root's own 1");

    const aAgg = agg.get("a")!;
    assert.equal(aAgg.teamStakeACF, 70n * E18);
    assert.equal(aAgg.l1StakeACF, 30n * E18);
    assert.equal(aAgg.teamRewardBaseACF, 7n * E18);

    const cAgg = agg.get("c")!;
    assert.equal(cAgg.teamStakeACF, 0n, "a leaf has no team");
    assert.equal(cAgg.teamRewardBaseACF, 0n);
  });

  it("16. activeDirects counts only children with active principal", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    await mkUser("staked", "root");
    await mkUser("unstaked", "root");

    const g = await loadAsOfGraph(SNAPSHOT);
    const agg = computeAggregates(g, new Map([
      ["staked", { ownActiveStakeACF: 5n * E18, ownRegularSelfACF: 0n, ownDAOSelfACF: 0n, ownPropagatingSelfACF: 0n }],
      ["unstaked", noStake],
    ]), P1);

    const root = agg.get("root")!;
    assert.equal(root.directCount, 2, "Level unlock counts both");
    assert.equal(root.activeDirects, 1, "Rank counts only the staked one");
    assert.equal(root.l1StakeACF, 5n * E18);
  });

  it("17. qualifier counts are capped at two and span the whole downline", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkRoot();
    // Four Master-capable leaders stacked in ONE leg, to prove legs are irrelevant.
    let parent = "root";
    for (const id of ["m1", "m2", "m3", "m4"]) { await mkUser(id, parent); parent = id; }
    for (const l of ["root", "m1", "m2", "m3", "m4"]) {
      for (let i = 0; i < 8; i++) await mkUser(`${l}-p${i}`, l);
    }
    const g = await loadAsOfGraph(SNAPSHOT);
    const totals = new Map<string, UserStakeTotals>();
    for (const u of g.userIds) {
      totals.set(u, {
        ownActiveStakeACF: 200_000n * E18,
        ownRegularSelfACF: 0n, ownDAOSelfACF: 0n, ownPropagatingSelfACF: 0n,
      });
    }
    const agg = computeAggregates(g, totals, P1);
    const root = agg.get("root")!;
    for (const threshold of QUALIFIER_THRESHOLDS) {
      assert.ok(root.qualifiersAtOrAbove.get(threshold)! <= REQUIRED_QUALIFIERS,
        `threshold ${threshold} must be capped at ${REQUIRED_QUALIFIERS}`);
    }
    assert.equal(root.qualifiersAtOrAbove.get(6), 2, "same-leg qualifiers count");
  });
});
