import { acfToUsd6, globalReward } from "./policy.js";
import type { NodeAggregate } from "./rank.js";

export interface GlobalOutcome {
  rewardACF: bigint;
  rankNumber: number;
  selfStakeACF: bigint;
  selfStakeUSD6: bigint;
  l1StakeACF: bigint;
  l1StakeUSD6: bigint;
}

/**
 * Global Contribution for one leader.
 *
 * Numerator terms are STOCK — what the leader and their direct children hold right at the
 * boundary. The denominator is FLOW — principal created during the window, network-wide.
 * Mixing the two is the defining mistake of this module, so they arrive from different places
 * on purpose: the stocks from the post-order pass, the flow from the epoch's stake facts.
 *
 * The USD figures are persisted for audit only. The payout is computed from the price-cancelled
 * ACF form, so it never depends on P.
 */
export function computeGlobalReward(
  node: NodeAggregate,
  networkContributionACF: bigint,
  priceE18: bigint,
): GlobalOutcome {
  const rewardACF = globalReward(
    node.ownActiveStakeACF,
    node.l1StakeACF,
    node.rank,
    networkContributionACF,
  );
  return {
    rewardACF,
    rankNumber: node.rank,
    selfStakeACF: node.ownActiveStakeACF,
    selfStakeUSD6: node.selfStakeUSD6,
    l1StakeACF: node.l1StakeACF,
    l1StakeUSD6: acfToUsd6(node.l1StakeACF, priceE18),
  };
}
