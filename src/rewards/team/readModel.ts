import { getAddress } from "viem";
import { config } from "../../config.js";
import { RewardPhase2Epoch } from "../../models/RewardPhase2Epoch.js";
import { TeamRewardEntry } from "../../models/TeamRewardEntry.js";

/**
 * The authenticated user's EARNED Team reward breakdown, projected from Phase 2's rows.
 *
 * Deliberately not responsible for published or claimable state — that is `/rewards/summary`,
 * which reads the finalized checkpoint. This endpoint answers "what did I earn and how was it
 * worked out", which is what the Global Pool page needs.
 *
 * Every audit figure is the value Phase 2 ACTUALLY USED for that epoch, read back from the
 * immutable row. Nothing is recomputed from current chain state: a historical epoch's personal
 * coefficient was derived from stakes and a price as they were then, and re-deriving it today
 * would show a number that was never paid.
 *
 * A user with nothing published can still have earned Team reward — Level Income is deferred, not
 * forfeited — so this never returns zero merely because nothing is published yet.
 */

export interface GlobalAuditView {
  rankNumber: number;
  selfStakeACF: string;
  selfStakeUSD6: string;
  l1StakeACF: string;
  l1StakeUSD6: string;
  networkContributionACF: string;
  networkContributionUSD6: string;
  priceE18: string;
}

export interface TeamEpochView {
  epochId: number;
  snapshotAt: number | null;
  levelACF: string;
  rankACF: string;
  globalACF: string;
  totalTeamACF: string;
  globalAudit: GlobalAuditView | null;
}

export interface TeamRewardReadModel {
  lifetime: {
    levelACF: string;
    rankACF: string;
    globalACF: string;
    totalTeamACF: string;
    epochCount: number;
  };
  latestEpoch: TeamEpochView | null;
}

const key = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
});

export async function getTeamRewards(userId: string): Promise<TeamRewardReadModel> {
  const k = key();

  // Settled epochs only, so a half-written Phase 2 epoch cannot inflate a lifetime total.
  const settled = await RewardPhase2Epoch.find(
    { ...k, status: "CALCULATED" }, { epochId: 1, snapshotAt: 1 },
  ).lean();
  const snapshotByEpoch = new Map(settled.map((e) => [e.epochId, e.snapshotAt ?? null]));

  const rows = await TeamRewardEntry.find(
    { ...k, userId, epochId: { $in: [...snapshotByEpoch.keys()] } },
  ).sort({ epochId: 1 }).lean();

  let level = 0n;
  let rank = 0n;
  let global = 0n;
  for (const r of rows) {
    level += BigInt(r.levelRewardACF);
    rank += BigInt(r.rankRewardACF);
    global += BigInt(r.globalRewardACF);
  }

  const latest = rows.at(-1) ?? null;
  const audit = latest?.globalAudit as Record<string, unknown> | undefined;

  return {
    lifetime: {
      levelACF: level.toString(),
      rankACF: rank.toString(),
      globalACF: global.toString(),
      totalTeamACF: (level + rank + global).toString(),
      epochCount: rows.length,
    },
    latestEpoch: latest
      ? {
          epochId: latest.epochId,
          snapshotAt: snapshotByEpoch.get(latest.epochId) ?? null,
          levelACF: latest.levelRewardACF,
          rankACF: latest.rankRewardACF,
          globalACF: latest.globalRewardACF,
          totalTeamACF: latest.teamRewardACF,
          globalAudit: audit
            ? {
                rankNumber: Number(audit.rankNumber),
                selfStakeACF: String(audit.selfStakeACF),
                selfStakeUSD6: String(audit.selfStakeUSD6),
                l1StakeACF: String(audit.l1StakeACF),
                l1StakeUSD6: String(audit.l1StakeUSD6),
                networkContributionACF: String(audit.networkContributionACF),
                networkContributionUSD6: String(audit.networkContributionUSD6),
                priceE18: String(audit.priceE18),
              }
            : null,
        }
      : null,
  };
}
