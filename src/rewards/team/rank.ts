import { acfToUsd6, QUALIFIER_THRESHOLDS, REQUIRED_QUALIFIERS, resolveRank } from "./policy.js";
import type { AsOfGraph } from "./graph.js";
import type { UserStakeTotals } from "./inputs.js";

/**
 * Everything the post-order pass derives for one user, for one epoch.
 */
export interface NodeAggregate {
  userId: string;
  ownActiveStakeACF: bigint;
  subtreeActiveStakeACF: bigint;
  ownRegularSelfACF: bigint;
  subtreeRegularSelfACF: bigint;
  /** This node's own DAO staking reward, carried for the Level credit's audit row. */
  ownDAOSelfACF: bigint;
  /** This node's own propagating reward under the epoch's rule. Level reads this. */
  ownPropagatingSelfACF: bigint;
  /**
   * The propagating staking reward in this node's whole subtree, itself included.
   *
   * `teamRewardBaseACF` is this minus the leader's own, which is what excludes a leader's own
   * reward — DAO or otherwise — from their own Rank base.
   */
  subtreePropagatingSelfACF: bigint;
  /** As-of children, regardless of stake. Level unlock reads this. */
  directCount: number;
  /** As-of children with any active-at-snapshot principal. Kept for audit and Global. */
  activeDirects: number;
  /**
   * As-of children who had registered at the snapshot — no wallet to create, no stake required.
   * This is what Level unlock and the Rank direct requirement read. Equal to `directCount` for a
   * graph the loader built, since graph membership IS registration; they are counted separately
   * so the rule is explicit rather than an accident of the query.
   */
  registeredDirects: number;
  /** Direct children's own active principal. Global reads this. */
  l1StakeACF: bigint;
  /** Strict descendants at rank >= threshold, capped at REQUIRED_QUALIFIERS. */
  qualifiersAtOrAbove: Map<number, number>;
  maxDescendantRank: number;
  /** subtree - own. Excludes the leader's own principal. */
  teamStakeACF: bigint;
  /** subtree - own. Excludes the leader's own staking reward. */
  teamRewardBaseACF: bigint;
  selfStakeUSD6: bigint;
  teamStakeUSD6: bigint;
  /** The rank that applies. Equals `earnedRank` for every user except a granted root. */
  rank: number;
  /** What the inputs alone qualified for, kept so a grant is always visible beside it. */
  earnedRank: number;
  /** True only when the ROOT floor raised this node above what it earned. */
  rankFloorApplied: boolean;
}

const ZERO: UserStakeTotals = {
  ownActiveStakeACF: 0n, ownRegularSelfACF: 0n, ownDAOSelfACF: 0n, ownPropagatingSelfACF: 0n,
};

/**
 * Computes every user's aggregates and rank in ONE bottom-up pass.
 *
 * This is exact without iteration, and the reason is worth stating:
 *
 *   - ranks 1-6 depend only on the leader's own numbers (self, team, activeDirects), and team
 *     depends on descendants' STAKE, not on their ranks;
 *   - ranks 7-12 additionally depend on {rank(d) : d is a strict descendant};
 *   - nothing depends on an ancestor's or a sibling's rank.
 *
 * So the dependency relation points strictly descendant -> ancestor. The as-of graph is a
 * validated single-rooted acyclic tree, and `bottomUpOrder` places every child before its
 * parent, so when a node is reached every value it needs is already final. The doc's
 * fixed-point resolver is therefore unnecessary here; it exists only as a test oracle.
 *
 * O(n) with constant state per node: four sums, one max, and six counters capped at 2.
 */
export function computeAggregates(
  graph: AsOfGraph,
  totals: Map<string, UserStakeTotals>,
  priceE18: bigint,
  /**
   * Which direct count qualifies a rank, decided by the epoch and passed in rather than read
   * from a clock: an epoch replayed years later must settle under the rule it was settled under.
   * `directRuleForEpoch(epochId, cutover)` is the only intended source.
   */
  /**
   * A granted minimum rank for `graph.rootUserId` ALONE. 0 means no grant.
   *
   * Passed in rather than read here so this pass stays pure and replayable. It is deliberately
   * scoped to the root: ranks 7-12 qualify on DESCENDANTS' ranks, and the root is nobody's
   * descendant, so raising it cannot change any other user's rank, differential or payout. The
   * same guarantee does not hold for any other node, which is why no other node may be granted.
   */
  rootRankFloor = 0,
): Map<string, NodeAggregate> {
  const out = new Map<string, NodeAggregate>();

  for (const userId of graph.bottomUpOrder) {
    const own = totals.get(userId) ?? ZERO;
    const children = graph.childrenOf.get(userId) ?? [];

    let subtreeActiveStakeACF = own.ownActiveStakeACF;
    let subtreeRegularSelfACF = own.ownRegularSelfACF;
    let subtreePropagatingSelfACF = own.ownPropagatingSelfACF;
    let l1StakeACF = 0n;
    let activeDirects = 0;
    let registeredDirects = 0;
    let maxDescendantRank = 0;
    const qualifiersAtOrAbove = new Map<number, number>(
      QUALIFIER_THRESHOLDS.map((r) => [r, 0]),
    );

    for (const childId of children) {
      // Guaranteed present: bottomUpOrder puts every child before its parent.
      const child = out.get(childId)!;

      subtreeActiveStakeACF += child.subtreeActiveStakeACF;
      subtreeRegularSelfACF += child.subtreeRegularSelfACF;
      subtreePropagatingSelfACF += child.subtreePropagatingSelfACF;
      l1StakeACF += child.ownActiveStakeACF;
      if (child.ownActiveStakeACF > 0n) activeDirects += 1;
      // Registration alone, as-of the snapshot. Every child in the as-of graph satisfies it by
      // construction; counting it explicitly keeps the rule assertable rather than implied.
      if (graph.registeredAsOf.has(childId)) registeredDirects += 1;

      if (child.rank > maxDescendantRank) maxDescendantRank = child.rank;
      if (child.maxDescendantRank > maxDescendantRank) {
        maxDescendantRank = child.maxDescendantRank;
      }

      for (const threshold of QUALIFIER_THRESHOLDS) {
        // The child's own rank plus the qualifiers inside the child's subtree. `>=` so a
        // higher rank satisfies a lower requirement: a Quantum counts toward "at least Master".
        const fromChild = (child.qualifiersAtOrAbove.get(threshold) ?? 0) +
          (child.rank >= threshold ? 1 : 0);
        const running = (qualifiersAtOrAbove.get(threshold) ?? 0) + fromChild;
        // Capped: only ">= 2" is ever asked, so counting further is wasted work.
        qualifiersAtOrAbove.set(threshold, running > REQUIRED_QUALIFIERS ? REQUIRED_QUALIFIERS : running);
      }
    }

    const teamStakeACF = subtreeActiveStakeACF - own.ownActiveStakeACF;
    // The downline's propagating reward, with the leader's own subtracted. Under ALL_SOURCES
    // that includes DAO positions throughout the downline — and still excludes the leader's own
    // DAO reward, exactly as it excludes their own DIRECT and BOND.
    const teamRewardBaseACF = subtreePropagatingSelfACF - own.ownPropagatingSelfACF;
    const selfStakeUSD6 = acfToUsd6(own.ownActiveStakeACF, priceE18);
    const teamStakeUSD6 = acfToUsd6(teamStakeACF, priceE18);

    const earnedRank = resolveRank({
      selfStakeUSD6,
      teamStakeUSD6,
      qualifyingDirects: registeredDirects,
      qualifiersAtOrAbove,
    });
    // `Math.max`, never an assignment: a root that has genuinely earned more keeps it.
    const granted = userId === graph.rootUserId && rootRankFloor > earnedRank;
    const rank = granted ? rootRankFloor : earnedRank;

    out.set(userId, {
      userId,
      ownActiveStakeACF: own.ownActiveStakeACF,
      subtreeActiveStakeACF,
      ownRegularSelfACF: own.ownRegularSelfACF,
      subtreeRegularSelfACF,
      ownDAOSelfACF: own.ownDAOSelfACF,
      ownPropagatingSelfACF: own.ownPropagatingSelfACF,
      subtreePropagatingSelfACF,
      directCount: children.length,
      activeDirects,
      registeredDirects,
      l1StakeACF,
      qualifiersAtOrAbove,
      maxDescendantRank,
      teamStakeACF,
      teamRewardBaseACF,
      selfStakeUSD6,
      teamStakeUSD6,
      rank,
      earnedRank,
      rankFloorApplied: granted,
    });
  }

  return out;
}

/**
 * The highest rank anywhere below a leader, all depths, no leg logic.
 *
 * Already accumulated by the pass; exposed separately because the Rank differential reads it
 * and the name is what the specification uses.
 */
export const highestDownlineRank = (node: NodeAggregate): number => node.maxDescendantRank;
