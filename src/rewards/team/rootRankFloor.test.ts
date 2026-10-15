import "./testenv.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeAggregates } from "./rank.js";
import { globalReward, rankCapUSD6, rankRateE6, RANK_TIERS } from "./policy.js";
import type { AsOfGraph } from "./graph.js";
import type { UserStakeTotals } from "./inputs.js";

/**
 * The ROOT rank floor.
 *
 * A granted minimum rank for the one parentless node, so the platform account earns at a fixed
 * tier from the first epoch rather than qualifying the ordinary way.
 *
 * The property that makes the grant safe is structural, not incidental, and is asserted here:
 * ranks 7-12 qualify on DESCENDANTS' ranks, and the root is nobody's descendant. Raising it
 * therefore cannot move any other user's rank, differential or payout. Nothing else in the
 * table has that property, which is why the floor is scoped to `graph.rootUserId` alone.
 */

const E18 = 10n ** 18n;
const PRICE_E18 = E18;            // 1 ACF = $1, so ACF and USD6 differ only by scale
const TOP = RANK_TIERS.at(-1)!;   // EternalX, rank 12

function graphOf(edges: Record<string, string[]>, rootUserId = "root"): AsOfGraph {
  const parentOf = new Map<string, string | null>([[rootUserId, null]]);
  const childrenOf = new Map<string, string[]>();
  for (const [parent, children] of Object.entries(edges)) {
    childrenOf.set(parent, children);
    for (const child of children) parentOf.set(child, parent);
  }
  const depth = (u: string): number => {
    let d = 0;
    let cur: string | null = u;
    while (cur && parentOf.get(cur)) { cur = parentOf.get(cur)!; d += 1; }
    return d;
  };
  return {
    rootUserId,
    userIds: [...parentOf.keys()],
    parentOf,
    childrenOf,
    bottomUpOrder: [...parentOf.keys()].sort((a, b) => depth(b) - depth(a)),
    registeredAsOf: new Set(parentOf.keys()),
    registrationBasis: "APPLICATION_TIMESTAMP",
  };
}

const stake = (acf: bigint): UserStakeTotals => ({
  ownActiveStakeACF: acf,
  ownRegularSelfACF: 0n,
  ownDAOSelfACF: 0n,
  ownPropagatingSelfACF: 0n,
});

/** Root plus two directs, none of whom qualify for anything on their own numbers. */
const SMALL = () => ({
  graph: graphOf({ root: ["a", "b"], a: ["a1"] }),
  totals: new Map([
    ["root", stake(100n * E18)],
    ["a", stake(50n * E18)],
    ["b", stake(50n * E18)],
    ["a1", stake(50n * E18)],
  ]),
});

describe("ROOT rank floor", () => {
  it("1. without a floor the root ranks on its own numbers, like everyone else", () => {
    const { graph, totals } = SMALL();
    const agg = computeAggregates(graph, totals, PRICE_E18);
    const root = agg.get("root")!;
    assert.equal(root.rank, root.earnedRank, "no grant, so rank IS the earned rank");
    assert.equal(root.rankFloorApplied, false);
  });

  it("2. a floor raises the root to the granted rank and says so", () => {
    const { graph, totals } = SMALL();
    const agg = computeAggregates(graph, totals, PRICE_E18, TOP.n);
    const root = agg.get("root")!;
    assert.equal(root.rank, TOP.n);
    assert.equal(root.rankFloorApplied, true);
    assert.ok(root.earnedRank < TOP.n, "the earned rank is kept beside the grant, not erased");
  });

  it("3. the grant changes NOTHING for any other user — the whole safety argument", () => {
    const a = SMALL();
    const b = SMALL();
    const without = computeAggregates(a.graph, a.totals, PRICE_E18);
    const withFloor = computeAggregates(b.graph, b.totals, PRICE_E18, TOP.n);

    for (const userId of a.graph.userIds) {
      if (userId === a.graph.rootUserId) continue;
      assert.deepEqual(
        withFloor.get(userId),
        without.get(userId),
        `${userId} must be bit-for-bit identical with and without the root grant`,
      );
    }
    // And specifically: no descendant can ever see the root in its downline.
    assert.equal(withFloor.get("a")!.maxDescendantRank, without.get("a")!.maxDescendantRank);
  });

  it("4. the floor is a MINIMUM: a root that earns more keeps what it earned", () => {
    const { graph, totals } = SMALL();
    const agg = computeAggregates(graph, totals, PRICE_E18, 0);
    const earned = agg.get("root")!.earnedRank;
    // A floor below the earned rank must not pull it down.
    const floored = computeAggregates(graph, totals, PRICE_E18, earned > 0 ? earned - 1 : 0);
    assert.equal(floored.get("root")!.rank, earned);
    assert.equal(floored.get("root")!.rankFloorApplied, false, "not a grant when nothing rose");
  });

  it("5. a floor cannot be bought on a non-root node", () => {
    // The same floor, against a graph whose root is someone else: "a" is now an ordinary node
    // and must be untouched, while the new root takes the grant.
    const graph = graphOf({ other: ["root"], root: ["a"] }, "other");
    const totals = new Map([
      ["other", stake(10n * E18)], ["root", stake(100n * E18)], ["a", stake(50n * E18)],
    ]);
    const agg = computeAggregates(graph, totals, PRICE_E18, TOP.n);
    assert.equal(agg.get("other")!.rank, TOP.n, "the graph root takes the grant");
    assert.equal(agg.get("root")!.rankFloorApplied, false, "a node merely NAMED root does not");
    assert.equal(agg.get("a")!.rankFloorApplied, false);
  });

  it("6. the granted rank carries the tier's rate and cap, which is the point of it", () => {
    const { graph, totals } = SMALL();
    const agg = computeAggregates(graph, totals, PRICE_E18, TOP.n);
    assert.equal(rankRateE6(agg.get("root")!.rank), TOP.rateE6);
    assert.equal(rankCapUSD6(agg.get("root")!.rank), TOP.epochCapUSD6);
  });

  it("7. it also switches on Global, which pays 0 at rank 0 and scales linearly after", () => {
    const self = 10_000n * E18;
    const l1 = 100_000n * E18;
    const contribution = 50_000n * E18;
    assert.equal(globalReward(self, l1, 0, contribution), 0n, "unranked earns no Global at all");
    const granted = globalReward(self, l1, TOP.n, contribution);
    assert.equal(granted, globalReward(self, l1, 1, contribution) * BigInt(TOP.n));
    assert.ok(granted > 0n);
  });
});
