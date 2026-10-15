import { levelRate, levelReward, LEVEL_MAX_DEPTH, unlockedLevels } from "./policy.js";
import { uplinesOf, type AsOfGraph } from "./graph.js";
import type { NodeAggregate } from "./rank.js";

/**
 * One Level Income credit, before persistence.
 */
export interface LevelCredit {
  beneficiaryUserId: string;
  sourceUserId: string;
  relativeLevel: number;
  rateE6: bigint;
  /**
   * The source's DIRECT+BOND reward. Meaning fixed across every epoch, so a row settled before
   * DAO propagation and one settled after can be read the same way.
   */
  sourceRegularSelfRewardACF: bigint;
  /** The source's DAO staking reward, whether or not this epoch let it propagate. */
  sourceDAOStakingRewardACF: bigint;
  /**
   * What this credit was actually calculated from. Equals the regular figure under
   * REGULAR_ONLY, and regular + DAO under ALL_SOURCES, so the row states its own basis instead
   * of requiring the reader to know the epoch's rule.
   */
  sourcePropagationSelfRewardACF: bigint;
  rewardACF: bigint;
}

export interface LevelOutcome {
  credits: LevelCredit[];
  /** Per beneficiary: total, and the per-level breakdown for the audit record. */
  totals: Map<string, bigint>;
  perLevel: Map<string, Map<number, { baseACF: bigint; amountACF: bigint; sourceCount: number }>>;
}

/**
 * Level Income, propagated UPWARD from each earner.
 *
 * O(earners x 7) rather than walking every leader's whole downline, and entirely in memory —
 * the parent map and direct counts were already built for Rank, so there is no query in the
 * loop.
 *
 * The base is the downline user's propagating staking reward for this epoch — DIRECT+BOND, and
 * DAO as well from DAO_TEAM_PROPAGATION_START_EPOCH. Before that epoch a DAO position's staking
 * reward stayed with its owner. The recipient needs no stake of their own, and ROOT is not
 * special.
 */
export function computeLevelRewards(
  graph: AsOfGraph,
  aggregates: Map<string, NodeAggregate>,
  /** See computeAggregates: the epoch's rule, not today's. */
): LevelOutcome {
  const credits: LevelCredit[] = [];
  const totals = new Map<string, bigint>();
  const perLevel = new Map<
    string,
    Map<number, { baseACF: bigint; amountACF: bigint; sourceCount: number }>
  >();

  for (const [sourceUserId, node] of aggregates) {
    // Whatever this epoch's rule lets propagate. Derived once at the fold, so Level and Rank
    // cannot disagree about what counts, and a reward cannot be added in twice.
    const source = node.ownPropagatingSelfACF;
    if (source <= 0n) continue;

    for (const { userId: beneficiaryUserId, relativeLevel } of
      uplinesOf(graph, sourceUserId, LEVEL_MAX_DEPTH)) {
      const beneficiary = aggregates.get(beneficiaryUserId);
      if (!beneficiary) continue;                       // outside the as-of graph
      // Unlock has NO stake condition: what counts is how many directs had registered by the
      // snapshot. 1 direct unlocks L1, 2 through L2, 3 through L3, 4 or more through L7.
      if (unlockedLevels(beneficiary.registeredDirects) < relativeLevel) continue;

      const rewardACF = levelReward(source, relativeLevel);
      if (rewardACF <= 0n) continue;

      credits.push({
        beneficiaryUserId,
        sourceUserId,
        relativeLevel,
        rateE6: levelRate(relativeLevel),
        sourceRegularSelfRewardACF: node.ownRegularSelfACF,
        sourceDAOStakingRewardACF: node.ownDAOSelfACF,
        sourcePropagationSelfRewardACF: source,
        rewardACF,
      });

      totals.set(beneficiaryUserId, (totals.get(beneficiaryUserId) ?? 0n) + rewardACF);

      const byLevel = perLevel.get(beneficiaryUserId) ?? new Map();
      const bucket = byLevel.get(relativeLevel) ??
        { baseACF: 0n, amountACF: 0n, sourceCount: 0 };
      bucket.baseACF += source;
      bucket.amountACF += rewardACF;
      bucket.sourceCount += 1;
      byLevel.set(relativeLevel, bucket);
      perLevel.set(beneficiaryUserId, byLevel);
    }
  }

  // Deterministic ordering so a rerun inserts identical rows in identical order.
  credits.sort((a, b) =>
    a.beneficiaryUserId.localeCompare(b.beneficiaryUserId) ||
    a.sourceUserId.localeCompare(b.sourceUserId) ||
    a.relativeLevel - b.relativeLevel);

  return { credits, totals, perLevel };
}
