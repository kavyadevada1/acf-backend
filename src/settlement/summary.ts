import { getAddress } from "viem";
import { config } from "../config.js";
import { User } from "../models/User.js";
import { StakeRewardEntry } from "../models/StakeRewardEntry.js";
import { TeamRewardEntry } from "../models/TeamRewardEntry.js";
import { RewardSettlementCheckpoint } from "../models/RewardSettlementCheckpoint.js";
import { UserRewardCheckpoint } from "../models/UserRewardCheckpoint.js";
import { UserClaimState } from "../models/UserClaimState.js";

/**
 * What a user has EARNED versus what is PUBLISHED on chain.
 *
 * A user whose entitlement is not yet published must still see their earned Level Income in
 * full — it is deferred, not forfeited — so this never reports zero just because no leaf exists
 * on chain yet.
 */

export type SummaryStatus = "CLAIMABLE" | "NOTHING_TO_CLAIM";

export interface RewardSummary {
  status: SummaryStatus;
  claimable: boolean;
  reason: string | null;
  earnedSelfACF: string;
  earnedTeamACF: string;
  publishedSelfACF: string;
  publishedTeamACF: string;
  claimedACF: string;
  checkpointId: number | null;
}

export async function getRewardSummary(userId: string): Promise<RewardSummary> {
  const sk = {
    chainId: config.chainId,
    stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
  };
  const settle = {
    chainId: config.chainId,
    withdrawalAddress: getAddress(config.withdrawalAddress).toLowerCase(),
  };

  const [user, selfRows, teamRows] = await Promise.all([
    User.findOne({ userId }, { externalEOA: 1 }).lean(),
    StakeRewardEntry.find({ ...sk, userId, rewardEligible: true }, { rewardACF: 1 }).lean(),
    TeamRewardEntry.find({ ...sk, userId }, { teamRewardACF: 1 }).lean(),
  ]);

  const earnedSelf = selfRows.reduce((s, r) => s + BigInt(r.rewardACF), 0n);
  const earnedTeam = teamRows.reduce((s, r) => s + BigInt(r.teamRewardACF), 0n);

  const latest = await RewardSettlementCheckpoint.findOne({ ...settle, status: "FINALIZED" })
    .sort({ checkpointId: -1 }).lean();
  const published = latest
    ? await UserRewardCheckpoint.findOne({
        ...settle, checkpointId: latest.checkpointId, userId,
      }).lean()
    : null;
  const claimState = await UserClaimState.findOne({ ...settle, userId }).lean();

  const publishedSelf = published ? BigInt(published.cumulativeSelfACF) : 0n;
  const publishedTeam = published ? BigInt(published.cumulativeTeamACF) : 0n;
  const claimed = claimState ? BigInt(claimState.alreadyClaimedACF) : 0n;

  let status: SummaryStatus;
  let reason: string | null = null;
  // There is no "cannot claim yet" state: a user's claim address exists from registration, so
  // the only question is whether a checkpoint has published their entitlement.
  if (published && publishedSelf + publishedTeam > claimed) {
    status = "CLAIMABLE";
  } else {
    status = "NOTHING_TO_CLAIM";
    reason = published ? "FULLY_CLAIMED" : "NOT_YET_PUBLISHED";
  }

  return {
    status,
    claimable: status === "CLAIMABLE",
    reason,
    earnedSelfACF: earnedSelf.toString(),
    earnedTeamACF: earnedTeam.toString(),
    publishedSelfACF: publishedSelf.toString(),
    publishedTeamACF: publishedTeam.toString(),
    claimedACF: claimed.toString(),
    checkpointId: latest?.checkpointId ?? null,
  };
}
