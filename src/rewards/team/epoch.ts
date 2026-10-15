import { getAddress } from "viem";
import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";
import { RewardEpoch } from "../../models/RewardEpoch.js";
import { RewardPhase2Epoch } from "../../models/RewardPhase2Epoch.js";
import { UserRankSnapshot } from "../../models/UserRankSnapshot.js";
import { User } from "../../models/User.js";
import { TeamRewardEntry } from "../../models/TeamRewardEntry.js";
import { LevelRewardCredit } from "../../models/LevelRewardCredit.js";
import { windowStartOf, snapshotAtOf } from "../policy.js";
import { loadAsOfGraph } from "./graph.js";
import { foldByUser, loadEpochStakeFacts } from "./inputs.js";
import { computeAggregates } from "./rank.js";
import { computeLevelRewards } from "./level.js";
import { computeGlobalReward } from "./global.js";
import {
  acfToUsd6, applyRankCap, differentialRateE6, grossRankReward, levelRate,
  rankCapUSD6, rankName, rankRateE6, unlockedLevels, directRuleForEpoch,
  teamPropagationRuleForEpoch,
} from "./policy.js";
import { diffFields, persistAndVerify } from "./verify.js";

const key = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
});

export class Phase1NotSettledError extends Error {
  readonly code = "PHASE1_NOT_SETTLED";
  constructor(epochId: number, status: string | null) {
    super(
      `Team Reward epoch ${epochId} cannot run: the Phase 1 staking epoch is ` +
        `${status ?? "missing"}, not CALCULATED or FINALIZED.`,
    );
    this.name = "Phase1NotSettledError";
  }
}

export interface TeamEpochResult {
  epochId: number;
  status: "CALCULATED" | "SKIPPED";
  graphNodes: number;
  levelCredits: number;
  totalLevelACF: string;
  totalRankACF: string;
  totalGlobalACF: string;
  totalTeamACF: string;
  networkContributionACF: string;
}

/**
 * Settles Level, Rank and Global for one twelve-hour epoch.
 *
 * The single calculation path: the worker, the catch-up sweep and the manual command all call
 * this, so there is no second implementation to drift.
 *
 * Every input is historical and immutable — Phase 1's reward rows, immutable stake creation
 * data, the as-of referral graph, and the price and boundary Phase 1 already froze. So this is
 * fully deterministic: re-running it a year later reproduces the same numbers, which is what
 * makes RECOMPUTE + VERIFY a safe retry strategy.
 *
 * Phase 2 performs NO chain reads and never consults mutable state.
 */
export async function runTeamRewardEpoch(epochId: number): Promise<TeamEpochResult> {
  const k = key();

  // Which staking rewards feed Level and Rank in this epoch. Derived from the epoch id alone —
  // never the clock, never the latest settled epoch — so a replay of a pre-41463 epoch
  // reproduces the DAO exclusion it was settled under.
  const propagationRule = teamPropagationRuleForEpoch(epochId);

  // ── 1-2. Phase 1 must have settled this window ──────────────────────────
  const phase1 = await RewardEpoch.findOne({ ...k, epochId });
  if (!phase1 || (phase1.status !== "CALCULATED" && phase1.status !== "FINALIZED")) {
    throw new Phase1NotSettledError(epochId, phase1?.status ?? null);
  }
  const snapshotAt = phase1.snapshotAt ?? snapshotAtOf(epochId);
  const windowStart = phase1.windowStart ?? windowStartOf(epochId);
  const priceE18 = BigInt(phase1.priceE18 ?? "0");
  if (priceE18 <= 0n) {
    throw new Error(`Phase 1 epoch ${epochId} has no usable price; refusing to settle Team Reward.`);
  }

  // ── 3. acquire ───────────────────────────────────────────────────────────
  // Conditional update, not an in-memory mutex: two processes must not both settle one epoch,
  // and a mutex is invisible across instances. An expired lease is reclaimable so a worker
  // killed mid-run does not freeze the epoch.
  const leaseMs = config.phase2LeaseMs;
  const staleBefore = new Date(Date.now() - leaseMs);
  const acquired = await RewardPhase2Epoch.findOneAndUpdate(
    {
      ...k, epochId,
      $or: [
        { status: { $in: ["PENDING", "FAILED"] } },
        { status: "PROCESSING", leaseExpiresAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        status: "PROCESSING",
        leaseExpiresAt: new Date(Date.now() + leaseMs),
        startedAt: new Date(),
        // 4. frozen from Phase 1; never re-derived.
        snapshotAt,
        snapshotBlockNumber: phase1.snapshotBlockNumber ?? null,
        priceE18: priceE18.toString(),
        // Recorded from the outset so the row states the rule it settled under, rather than
        // leaving a reader to infer it from the epoch number and today's constant.
        teamPropagationRule: propagationRule,
      },
      $setOnInsert: { ...k, epochId },
      $inc: { attempts: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).catch((cause: { code?: number }) => {
    if (cause?.code === 11000) return null;      // another worker inserted first
    throw cause;
  });

  if (!acquired) return skipped(k, epochId);
  if (acquired.status === "CALCULATED") return skipped(k, epochId);

  try {
    // ── 5-6. the as-of graph, fully validated ──────────────────────────────
    // The SAME pinned block Phase 1 read every stake at, carried on this epoch's row at step 4.
    // Never looked up again: a second lookup could land on a different head and put the graph's
    // boundary somewhere other than the stake facts' boundary.
    const graph = await loadAsOfGraph(snapshotAt);

    // Which direct-qualification rule this epoch settles under. Derived from the epoch id and the
    // configured cutover, so a replay resolves to the rule the epoch was settled with.
    //
    // Only REGISTERED_EOA is computable by this build. ACTIVE_STAKE and ONBOARDED were derived
    // from application smart-wallet facts that no longer exist, so an epoch below the cutover
    // fails closed here rather than settling every leader at zero qualifying directs — which
    // would silently withhold Level and Rank income from everyone.
    const directRule = directRuleForEpoch(epochId, config.registeredEoaDirectRuleStartEpoch);
    if (directRule !== "REGISTERED_EOA") {
      throw new Error(
        `Epoch ${epochId} resolves to the historical ${directRule} direct rule, which this build ` +
          `cannot compute: it was derived from smart-wallet facts the application no longer holds. ` +
          `REGISTERED_EOA_DIRECT_RULE_START_EPOCH is ${config.registeredEoaDirectRuleStartEpoch}; ` +
          "refusing to settle a pre-cutover epoch.",
      );
    }

    // ── 7-9. Phase 1's settled output, interpreted ─────────────────────────
    const { facts, networkContributionACF } =
      await loadEpochStakeFacts(k, epochId, windowStart, snapshotAt);

    // ── 10-12. per-user totals, then one bottom-up pass for aggregates + ranks ──
    const totals = foldByUser(facts, propagationRule);
    // The grant lives on the ROOT's own user document, not in config: one document an operator
    // can read, and one that a config edit cannot silently change underneath a settled epoch.
    // Whether it was applied is recorded on this epoch's rank snapshot below.
    const rootRankFloor =
      (await User.findOne({ userId: graph.rootUserId }, { rankFloor: 1 }).lean())?.rankFloor ?? 0;
    const aggregates = computeAggregates(graph, totals, priceE18, rootRankFloor);

    // ── 13-14. rank snapshots, persisted and verified field by field ───────
    const previousRanks = await loadPreviousRanks(k, epochId, graph.userIds);
    const snapshotRows = graph.userIds.map((userId) => {
      const n = aggregates.get(userId)!;
      return {
        ...k, epochId, userId,
        rank: n.rank,
        rankName: rankName(n.rank),
        rateE6: rankRateE6(n.rank).toString(),
        epochCapUSD6: rankCapUSD6(n.rank).toString(),
        previousRank: previousRanks.get(userId) ?? null,
        // A granted rank must never be indistinguishable from an earned one in the record.
        rankFloorApplied: n.rankFloorApplied,
        selfStakeACF: n.ownActiveStakeACF.toString(),
        selfStakeUSD6: n.selfStakeUSD6.toString(),
        teamStakeACF: n.teamStakeACF.toString(),
        teamStakeUSD6: n.teamStakeUSD6.toString(),
        activeDirects: n.activeDirects,
        directCount: n.directCount,
        registeredDirects: n.registeredDirects,
        // Which count actually qualified this rank, recorded so a reader never has to infer it
        // from the epoch number.
        directRule,
        // And what established registration: an application fact, never a block lookup.
        registrationBasis: graph.registrationBasis,
        l1StakeACF: n.l1StakeACF.toString(),
        maxDownlineRank: n.maxDescendantRank,
        downlineQualifiers: maxQualifiers(n.qualifiersAtOrAbove),
        priceE18: priceE18.toString(),
      };
    });

    await persistAndVerify(
      "UserRankSnapshot", UserRankSnapshot, { ...k, epochId },
      snapshotRows,
      (row) => (row as { userId: string }).userId,
      (expected, persisted) => diffFields(
        expected as unknown as Record<string, unknown>,
        persisted as unknown as Record<string, unknown>,
        [
          "rank", "rankName", "rateE6", "epochCapUSD6", "rankFloorApplied",
          "selfStakeACF", "selfStakeUSD6", "teamStakeACF", "teamStakeUSD6",
          "activeDirects", "directCount", "registeredDirects", "directRule",
          "registrationBasis", "l1StakeACF",
          "maxDownlineRank", "downlineQualifiers", "priceE18",
        ],
      ),
    );

    // ── 15-18. the three rewards ───────────────────────────────────────────
    const level = computeLevelRewards(graph, aggregates);

    let totalLevel = 0n;
    let totalRank = 0n;
    let totalGlobal = 0n;

    const teamRows = graph.userIds.map((userId) => {
      const n = aggregates.get(userId)!;

      const levelRewardACF = level.totals.get(userId) ?? 0n;

      const leaderRank = n.rank;
      const downlineRank = n.maxDescendantRank;
      const effective = differentialRateE6(leaderRank, downlineRank);
      const gross = grossRankReward(n.teamRewardBaseACF, effective);
      const cap = rankCapUSD6(leaderRank);
      const { payableACF: rankRewardACF, capped } = applyRankCap(gross, cap, priceE18);

      const global = computeGlobalReward(n, networkContributionACF, priceE18);

      totalLevel += levelRewardACF;
      totalRank += rankRewardACF;
      totalGlobal += global.rewardACF;

      const perLevel = [...(level.perLevel.get(userId)?.entries() ?? [])]
        .sort((a, b) => a[0] - b[0])
        .map(([lvl, v]) => ({
          level: lvl,
          rateE6: levelRate(lvl).toString(),
          baseACF: v.baseACF.toString(),
          amountACF: v.amountACF.toString(),
          sourceCount: v.sourceCount,
        }));

      return {
        ...k, epochId, userId,
        levelRewardACF: levelRewardACF.toString(),
        rankRewardACF: rankRewardACF.toString(),
        globalRewardACF: global.rewardACF.toString(),
        teamRewardACF: (levelRewardACF + rankRewardACF + global.rewardACF).toString(),
        levelAudit: {
          unlockedLevels: unlockedLevels(n.registeredDirects),
          directCount: n.directCount,
          registeredDirects: n.registeredDirects,
          // The count `unlockedLevels` was actually computed from, so the audit row is
          // self-explaining rather than requiring the reader to know the epoch's rule.
          qualifyingDirects: n.registeredDirects,
          perLevel,
        },
        rankAudit: {
          leaderRank,
          leaderRateE6: rankRateE6(leaderRank).toString(),
          highestDownlineRank: downlineRank,
          highestDownlineRateE6: rankRateE6(downlineRank).toString(),
          differentialRateE6: effective.toString(),
          teamRewardBaseACF: n.teamRewardBaseACF.toString(),
          grossACF: gross.toString(),
          epochCapUSD6: cap.toString(),
          capped,
        },
        globalAudit: {
          rankNumber: global.rankNumber,
          selfStakeACF: global.selfStakeACF.toString(),
          selfStakeUSD6: global.selfStakeUSD6.toString(),
          l1StakeACF: global.l1StakeACF.toString(),
          l1StakeUSD6: global.l1StakeUSD6.toString(),
          networkContributionACF: networkContributionACF.toString(),
          networkContributionUSD6: acfToUsd6(networkContributionACF, priceE18).toString(),
          priceE18: priceE18.toString(),
        },
      };
    });

    // ── 19-21. persist the fan-out, then one row per user ──────────────────
    const creditRows = level.credits.map((c) => ({
      ...k, epochId,
      beneficiaryUserId: c.beneficiaryUserId,
      sourceUserId: c.sourceUserId,
      relativeLevel: c.relativeLevel,
      rateE6: c.rateE6.toString(),
      sourceRegularSelfRewardACF: c.sourceRegularSelfRewardACF.toString(),
      sourceDAOStakingRewardACF: c.sourceDAOStakingRewardACF.toString(),
      sourcePropagationSelfRewardACF: c.sourcePropagationSelfRewardACF.toString(),
      rewardACF: c.rewardACF.toString(),
    }));

    await persistAndVerify(
      "LevelRewardCredit", LevelRewardCredit, { ...k, epochId },
      creditRows,
      (row) => {
        const r = row as { beneficiaryUserId: string; sourceUserId: string; relativeLevel: number };
        return `${r.beneficiaryUserId}|${r.sourceUserId}|${r.relativeLevel}`;
      },
      (expected, persisted) => diffFields(
        expected as unknown as Record<string, unknown>,
        persisted as unknown as Record<string, unknown>,
        ["rateE6", "sourceRegularSelfRewardACF", "sourceDAOStakingRewardACF",
         "sourcePropagationSelfRewardACF", "rewardACF"],
      ),
    );

    await persistAndVerify(
      "TeamRewardEntry", TeamRewardEntry, { ...k, epochId },
      teamRows,
      (row) => (row as { userId: string }).userId,
      (expected, persisted) => diffFields(
        expected as unknown as Record<string, unknown>,
        persisted as unknown as Record<string, unknown>,
        [
          "levelRewardACF", "rankRewardACF", "globalRewardACF", "teamRewardACF",
          // The audit records were promised immutable too, so a divergence inside one fails
          // the epoch rather than being accepted or overwritten.
          "levelAudit", "rankAudit", "globalAudit",
        ],
      ),
    );

    // ── 22-23. only now is the epoch financial truth ───────────────────────
    const totalTeam = totalLevel + totalRank + totalGlobal;
    await RewardPhase2Epoch.updateOne({ ...k, epochId }, {
      $set: {
        status: "CALCULATED",
        leaseExpiresAt: null,
        lastError: null,
        calculatedAt: new Date(),
        networkContributionACF: networkContributionACF.toString(),
        networkContributionUSD6: acfToUsd6(networkContributionACF, priceE18).toString(),
        graphNodes: graph.userIds.length,
        usersProcessed: teamRows.length,
        totalLevelACF: totalLevel.toString(),
        totalRankACF: totalRank.toString(),
        totalGlobalACF: totalGlobal.toString(),
        totalTeamACF: totalTeam.toString(),
      },
    });

    logger.info("team reward epoch calculated", {
      epochId, graphNodes: graph.userIds.length, levelCredits: creditRows.length,
    });

    return {
      epochId,
      status: "CALCULATED",
      graphNodes: graph.userIds.length,
      levelCredits: creditRows.length,
      totalLevelACF: totalLevel.toString(),
      totalRankACF: totalRank.toString(),
      totalGlobalACF: totalGlobal.toString(),
      totalTeamACF: totalTeam.toString(),
      networkContributionACF: networkContributionACF.toString(),
    };
  } catch (cause) {
    await RewardPhase2Epoch.updateOne({ ...k, epochId }, {
      $set: {
        status: "FAILED",
        leaseExpiresAt: null,
        lastError: (cause as Error).message.slice(0, 500),
      },
    });
    throw cause;
  }
}

/** The largest qualifier count across thresholds — a single audit figure. */
function maxQualifiers(counts: ReadonlyMap<number, number>): number {
  let best = 0;
  for (const v of counts.values()) if (v > best) best = v;
  return best;
}

/**
 * Each user's rank at the most recent PRIOR SETTLED epoch, for support ("why did I drop?").
 *
 * Never a qualification input — `resolveRank` takes only this epoch's own aggregates, and
 * neither the differential nor Global reads it.
 *
 * Deliberately not `epochId - 1`: that epoch may never have run, or may have FAILED and left
 * partial snapshots behind. The source is the newest Phase 2 epoch below this one whose status
 * is CALCULATED, so the figure a user is shown always came from settled history. The current
 * epoch is excluded both by `$lt` and by its own PROCESSING status.
 */
async function loadPreviousRanks(
  k: { chainId: number; stakingContractAddress: string },
  epochId: number,
  userIds: string[],
): Promise<Map<string, number>> {
  const prior = await RewardPhase2Epoch.findOne(
    { ...k, epochId: { $lt: epochId }, status: "CALCULATED" },
    { epochId: 1 },
  ).sort({ epochId: -1 }).lean();
  if (!prior) return new Map();

  const rows = await UserRankSnapshot.find(
    { ...k, epochId: prior.epochId, userId: { $in: userIds } },
    { userId: 1, rank: 1 },
  ).lean();
  return new Map(rows.map((r) => [r.userId, r.rank]));
}

async function skipped(
  k: { chainId: number; stakingContractAddress: string },
  epochId: number,
): Promise<TeamEpochResult> {
  const existing = await RewardPhase2Epoch.findOne({ ...k, epochId });
  return {
    epochId,
    status: "SKIPPED",
    graphNodes: existing?.graphNodes ?? 0,
    levelCredits: 0,
    totalLevelACF: existing?.totalLevelACF ?? "0",
    totalRankACF: existing?.totalRankACF ?? "0",
    totalGlobalACF: existing?.totalGlobalACF ?? "0",
    totalTeamACF: existing?.totalTeamACF ?? "0",
    networkContributionACF: existing?.networkContributionACF ?? "0",
  };
}
