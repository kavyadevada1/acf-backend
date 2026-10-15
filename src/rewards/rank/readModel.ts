import { getAddress } from "viem";
import { config } from "../../config.js";
import { RewardPhase2Epoch } from "../../models/RewardPhase2Epoch.js";
import { TeamRewardEntry } from "../../models/TeamRewardEntry.js";
import { UserRankSnapshot } from "../../models/UserRankSnapshot.js";
import { RANK_TIERS, REQUIRED_QUALIFIERS, type DirectRule, type RankTier } from "../team/policy.js";

/**
 * The authenticated user's rank, as Phase 2 actually calculated it.
 *
 * Everything here is read back from `UserRankSnapshot`, written per user per settled epoch.
 * Rank is NEVER recomputed when serving a request: `resolveRank` depends on stake, team volume,
 * active directs and downline qualifiers as they stood at the snapshot, and re-deriving it from
 * today's mutable state would show a rank the protocol never paid on.
 *
 * The tier ladder is projected from `rewards/team/policy.ts`, the same constants the engine
 * ranks with, so the two cannot drift.
 */

/**
 * A settled epoch that is missing this user's snapshot.
 *
 * Phase 2 writes one row per user in the graph it settled, so an absence means the epoch and
 * the snapshot set disagree. Surfaced rather than rendered as Unranked, which would state a
 * rank the protocol never calculated.
 */
export class RankSnapshotMissingError extends Error {
  readonly epochId: number;
  readonly userId: string;

  constructor(epochId: number, userId: string) {
    super(`Phase 2 epoch ${epochId} is settled but has no rank snapshot for ${userId}.`);
    this.name = "RankSnapshotMissingError";
    this.epochId = epochId;
    this.userId = userId;
  }
}

export type RankStatus = "AVAILABLE" | "NOT_YET_CALCULATED";

export interface RequirementProgress {
  current: string;
  required: string;
  met: boolean;
}

export interface QualifierProgress {
  current: number;
  required: number;
  /** The downline rank those qualifiers must hold. */
  requiredRank: number;
  met: boolean;
}

export interface TierView {
  rankNumber: number;
  rankName: string;
  /** The RANK REWARD RATE on a 1e6 denominator — not a staking yield. */
  rateE6: string;
  selfStakeRequirementUSD6: string;
  /**
   * Resolved, not raw. Ranks 7-12 carry null in the table because the requirement is inherited
   * through `requiresRank`; this walks that chain back so each tier states the figure that
   * actually has to be met.
   */
  teamStakeRequirementUSD6: string;
  /** The tier's direct threshold. Compared against the epoch's qualifying count,
   *  which under REGISTERED_EOA is registered directs — not directs holding stake. */
  requiredDirects: number;
  downlineQualifierRequirement: { requiredRank: number; count: number } | null;
  /** The TWELVE-HOUR cap, as stored. Never doubled into a daily figure here. */
  epochCapUSD6: string;
}

export interface CurrentRankView {
  rankNumber: number;
  rankName: string | null;
  rateE6: string;
  epochCapUSD6: string;
  previousRank: number | null;
  selfStakeACF: string;
  selfStakeUSD6: string;
  teamStakeACF: string;
  teamStakeUSD6: string;
  /** Directs holding active stake. Informational: not the qualification basis. */
  activeDirects: number;
  /** Every direct referral. Under REGISTERED_EOA this equals `registeredDirects`. */
  directCount: number;
  /**
   * Directs who had registered at this snapshot. Null on epochs settled under an earlier rule,
   * which did not record it.
   */
  registeredDirects: number | null;
  /**
   * The count that actually qualified this rank, and which rule it came from.
   *
   * Read from the snapshot rather than inferred from the epoch number, so a historical row
   * states its own semantics.
   */
  qualifyingDirects: number;
  directRule: DirectRule;
  /**
   * What established qualification: APPLICATION_TIMESTAMP under REGISTERED_EOA, or the chain
   * block / boundary clock on rows settled under the onboarding rule. Null when not recorded.
   */
  registrationBasis: "APPLICATION_TIMESTAMP" | "BLOCK" | "TIMESTAMP" | null;
  l1StakeACF: string;
  maxDownlineRank: number;
  downlineQualifiers: number;
}

export interface NextRankView {
  rankNumber: number;
  rankName: string;
  rateE6: string;
  epochCapUSD6: string;
  requirements: {
    selfStakeUSD6: RequirementProgress;
    teamStakeUSD6: RequirementProgress;
    /**
     * Progress toward the tier's direct requirement, measured in whatever count this epoch's
     * rule qualifies on. Named for that role: under REGISTERED_EOA it carries registered directs,
     * and calling it `activeDirects` would misreport what it counts.
     */
    qualifyingDirects: RequirementProgress;
    downlineQualifiers: QualifierProgress | null;
  };
}

export interface LatestRankRewardView {
  /** Paid for the epoch, after the cap. */
  rankRewardACF: string;
  /** Before the cap. Equal to the paid amount when the cap did not bite. */
  grossRankRewardACF: string;
  capped: boolean;
  epochCapUSD6: string;
}

export interface RankReadModel {
  status: RankStatus;
  epoch: { epochId: number; snapshotAt: number | null; priceE18: string } | null;
  currentRank: CurrentRankView | null;
  nextRank: NextRankView | null;
  latestReward: LatestRankRewardView | null;
  tiers: TierView[];
}

const key = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
});

/**
 * The team requirement a tier actually imposes.
 *
 * Ranks 1-6 state it directly. Ranks 7-12 store null and inherit it by requiring the rank below
 * them, which chains back to Master's figure — so the requirement is resolved here rather than
 * left for a caller to reconstruct.
 */
function resolvedTeamRequirement(tier: RankTier): bigint {
  let current: RankTier | undefined = tier;
  while (current && current.teamUSD6 === null) {
    const required: number | null = current.requiresRank;
    if (required === null) return 0n;
    current = RANK_TIERS.find((t) => t.n === required);
  }
  return current?.teamUSD6 ?? 0n;
}

export const TIERS: TierView[] = RANK_TIERS.map((tier) => ({
  rankNumber: tier.n,
  rankName: tier.name,
  rateE6: tier.rateE6.toString(),
  selfStakeRequirementUSD6: tier.selfUSD6.toString(),
  teamStakeRequirementUSD6: resolvedTeamRequirement(tier).toString(),
  requiredDirects: tier.requiredDirects,
  downlineQualifierRequirement:
    tier.requiresRank === null
      ? null
      : { requiredRank: tier.requiresRank, count: REQUIRED_QUALIFIERS },
  epochCapUSD6: tier.epochCapUSD6.toString(),
}));

const progress = (current: bigint, required: bigint): RequirementProgress => ({
  current: current.toString(),
  required: required.toString(),
  // `>=`, matching the policy: landing exactly on a threshold qualifies.
  met: current >= required,
});

export async function getRankReadModel(userId: string): Promise<RankReadModel> {
  const k = key();

  // The most recent epoch Phase 2 actually settled. PENDING, PROCESSING and FAILED epochs are
  // not truth and are never read from.
  const epoch = await RewardPhase2Epoch.findOne(
    { ...k, status: "CALCULATED" },
    { epochId: 1, snapshotAt: 1, priceE18: 1 },
  ).sort({ epochId: -1 }).lean();

  if (!epoch) {
    return {
      status: "NOT_YET_CALCULATED",
      epoch: null, currentRank: null, nextRank: null, latestReward: null,
      tiers: TIERS,
    };
  }

  const snapshot = await UserRankSnapshot.findOne({ ...k, epochId: epoch.epochId, userId }).lean();
  if (!snapshot) {
    // Phase 2 writes a snapshot for every user in the graph it settled. A settled epoch with no
    // row for this user means the two disagree about who exists, which is an integrity failure
    // rather than an unranked user.
    throw new RankSnapshotMissingError(epoch.epochId, userId);
  }

  // The row states which rule settled it, so a historical snapshot keeps reporting the count it
  // was actually qualified on rather than being reinterpreted under today's rule.
  const directRule: DirectRule =
    snapshot.directRule === "REGISTERED_EOA" ? "REGISTERED_EOA"
      : snapshot.directRule === "ONBOARDED" ? "ONBOARDED"
        : "ACTIVE_STAKE";
  const qualifyingDirects =
    directRule === "REGISTERED_EOA" ? (snapshot.registeredDirects ?? 0)
      : directRule === "ONBOARDED" ? (snapshot.registeredDirects ?? 0)
        : snapshot.activeDirects;

  const currentRank: CurrentRankView = {
    rankNumber: snapshot.rank,
    rankName: snapshot.rankName ?? null,
    rateE6: snapshot.rateE6,
    epochCapUSD6: snapshot.epochCapUSD6,
    previousRank: snapshot.previousRank ?? null,
    selfStakeACF: snapshot.selfStakeACF,
    selfStakeUSD6: snapshot.selfStakeUSD6,
    teamStakeACF: snapshot.teamStakeACF,
    teamStakeUSD6: snapshot.teamStakeUSD6,
    activeDirects: snapshot.activeDirects,
    directCount: snapshot.directCount,
    registeredDirects: snapshot.registeredDirects ?? null,
    qualifyingDirects,
    directRule,
    registrationBasis: snapshot.registrationBasis ?? null,
    l1StakeACF: snapshot.l1StakeACF,
    maxDownlineRank: snapshot.maxDownlineRank,
    downlineQualifiers: snapshot.downlineQualifiers,
  };

  // Rank 0 is a real state, so the next tier for an unranked user is Nova.
  const nextTier = RANK_TIERS.find((t) => t.n === snapshot.rank + 1) ?? null;
  const nextRank: NextRankView | null = nextTier
    ? {
        rankNumber: nextTier.n,
        rankName: nextTier.name,
        rateE6: nextTier.rateE6.toString(),
        epochCapUSD6: nextTier.epochCapUSD6.toString(),
        requirements: {
          selfStakeUSD6: progress(BigInt(snapshot.selfStakeUSD6), nextTier.selfUSD6),
          teamStakeUSD6: progress(BigInt(snapshot.teamStakeUSD6), resolvedTeamRequirement(nextTier)),
          // Whichever count this epoch qualified on — never directCount, which has no
          // qualifying role under the epoch's rule. `nextTier.requiredDirects` is the THRESHOLD,
          // a different thing from a user's count.
          qualifyingDirects: progress(BigInt(qualifyingDirects), BigInt(nextTier.requiredDirects)),
          downlineQualifiers:
            nextTier.requiresRank === null
              ? null
              : {
                  current: snapshot.downlineQualifiers,
                  required: REQUIRED_QUALIFIERS,
                  requiredRank: nextTier.requiresRank,
                  met: snapshot.downlineQualifiers >= REQUIRED_QUALIFIERS,
                },
        },
      }
    : null;

  // The rank reward for that same epoch. Absent for a user Phase 2 wrote no team entry for.
  const entry = await TeamRewardEntry.findOne(
    { ...k, epochId: epoch.epochId, userId },
    { rankRewardACF: 1, rankAudit: 1 },
  ).lean();
  const audit = entry?.rankAudit as Record<string, unknown> | undefined;

  return {
    status: "AVAILABLE",
    epoch: {
      epochId: epoch.epochId,
      snapshotAt: epoch.snapshotAt ?? null,
      priceE18: snapshot.priceE18,
    },
    currentRank,
    nextRank,
    latestReward: entry
      ? {
          rankRewardACF: entry.rankRewardACF,
          // Gross and cap are in DIFFERENT units — ACF and USD6 — and are deliberately not
          // combined into a ratio here. Comparing them needs the epoch price and the locked
          // conversion; the honest report is the two figures and whether the cap bit.
          grossRankRewardACF: String(audit?.grossACF ?? entry.rankRewardACF),
          capped: Boolean(audit?.capped ?? false),
          epochCapUSD6: String(audit?.epochCapUSD6 ?? snapshot.epochCapUSD6),
        }
      : null,
    tiers: TIERS,
  };
}

/**
 * RANK CHANGES, not promotions.
 *
 * `resolveRank` is a pure function of each epoch's inputs and is written fresh every epoch;
 * `previousRank` is recorded for reference and never clamps the result. A member who withdraws
 * stake, or whose direct goes inactive, drops. Representing this as promotions only would hide
 * demotions, so each row carries a direction.
 *
 * Paginated because rank may oscillate: with no monotonicity there is no bound on how many
 * times it can change.
 */
export type RankDirection = "PROMOTED" | "DEMOTED";

export interface RankChangeRow {
  epochId: number;
  snapshotAt: number | null;
  /** Null on the first snapshot a user ever received. */
  fromRank: number | null;
  toRank: number;
  toRankName: string | null;
  direction: RankDirection;
}

export interface RankHistoryPage {
  rows: RankChangeRow[];
  /** Pass back as `before` to continue. Null on the final page. */
  nextCursor: number | null;
}

export async function getRankHistory(
  userId: string,
  options: { limit?: number; before?: number } = {},
): Promise<RankHistoryPage> {
  const k = key();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

  // Only epochs where the rank actually moved. `$expr` compares the two fields on the row
  // itself, so a first snapshot (previousRank null) counts as a change when the rank is above
  // zero, and a steady rank produces nothing.
  const filter: Record<string, unknown> = {
    ...k,
    userId,
    $expr: { $ne: ["$rank", { $ifNull: ["$previousRank", -1] }] },
  };
  if (options.before !== undefined) filter.epochId = { $lt: options.before };

  const rows = await UserRankSnapshot.find(filter)
    .sort({ epochId: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Epoch boundaries are arithmetic over the id, so no second query is needed for the time.
  const EPOCH_SECONDS = 43_200;

  return {
    rows: page
      .filter((row) => !(row.previousRank == null && row.rank === 0))
      .map((row) => ({
        epochId: row.epochId,
        snapshotAt: row.epochId * EPOCH_SECONDS,
        fromRank: row.previousRank ?? null,
        toRank: row.rank,
        toRankName: row.rankName ?? null,
        direction: row.rank > (row.previousRank ?? 0) ? "PROMOTED" : "DEMOTED",
      })),
    nextCursor: hasMore ? page[page.length - 1]!.epochId : null,
  };
}
