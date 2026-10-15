import { getAddress } from "viem";
import { config } from "../config.js";
import { DAOContribution } from "../models/DAOContribution.js";
import { Stake } from "../models/Stake.js";
import { StakeRewardEntry } from "../models/StakeRewardEntry.js";
import { User } from "../models/User.js";
import { assertInvariant, DAORevenueInvariantError, systemSelfRewardACF } from "./policy.js";
import { contributionActiveAtSnapshot, type ExclusionReason } from "./eligibility.js";

/**
 * Immutable inputs for one DAO revenue epoch, loaded and integrity-checked before any money is
 * computed.
 */

const stakingKey = () => ({
  chainId: config.chainId,
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
});

const daoKey = () => ({
  chainId: config.chainId,
  daoContractAddress: getAddress(config.acfDaoAddress).toLowerCase(),
});

export interface SystemRevenueInput {
  regularSelfACF: bigint;
  daoStakeRewardACF: bigint;
  totalSelfACF: bigint;
}

/**
 * The epoch's Self-type reward base, from two independent computations that must agree.
 *
 * Primary is the Phase 1 aggregate, written once when the epoch reached CALCULATED. The
 * cross-check re-sums the per-stake rows. They are produced by the same loop, so a divergence
 * means the aggregate or the rows were altered after settlement — and either way the base of
 * every member's payout is unsafe.
 *
 * Level, Rank and Global live in TeamRewardEntry, a different collection, so they are
 * structurally excluded rather than filtered. Claim state is not consulted at all: this
 * measures reward GENERATED in the window, which a later claim cannot change.
 */
export async function loadSystemRevenue(
  epochId: number,
  aggregate: { totalRegularSelfACF: string; totalDAOStakeACF: string },
): Promise<SystemRevenueInput> {
  const k = stakingKey();
  const regularSelfACF = BigInt(aggregate.totalRegularSelfACF);
  const daoStakeRewardACF = BigInt(aggregate.totalDAOStakeACF);
  const primary = systemSelfRewardACF(regularSelfACF, daoStakeRewardACF);

  const rows = await StakeRewardEntry.find({ ...k, epochId }, { rewardACF: 1, source: 1 }).lean();
  const independent = rows.reduce((sum, row) => sum + BigInt(row.rewardACF), 0n);

  if (independent !== primary) {
    throw new DAORevenueInvariantError(
      `Epoch ${epochId} system revenue disagrees: RewardEpoch totals give ${primary} ACF ` +
        `(regular ${regularSelfACF} + DAO ${daoStakeRewardACF}) but the ${rows.length} ` +
        `StakeRewardEntry rows sum to ${independent}. Refusing to price DAO revenue on an ` +
        "unverified base.",
    );
  }

  // The split itself is cross-checked, so a mislabelled source cannot move value between the
  // two recorded components while leaving the total intact.
  const daoFromRows = rows
    .filter((row) => row.source === "DAO")
    .reduce((sum, row) => sum + BigInt(row.rewardACF), 0n);
  if (daoFromRows !== daoStakeRewardACF) {
    throw new DAORevenueInvariantError(
      `Epoch ${epochId} DAO-source reward disagrees: aggregate says ${daoStakeRewardACF} but ` +
        `source=DAO rows sum to ${daoFromRows}.`,
    );
  }

  return { regularSelfACF, daoStakeRewardACF, totalSelfACF: primary };
}

export interface ActiveContributionsResult {
  /** Per user, the summed recorded USDT of contributions active at the snapshot. */
  byUser: Map<string, { activeUSDT6: bigint; count: number }>;
  considered: number;
  active: number;
  excluded: Record<ExclusionReason, number>;
}

/**
 * Every DAO contribution, resolved to active-or-not AS OF the epoch snapshot.
 *
 * Bidirectional integrity: every contribution must link to a Stake, and every contribution that
 * existed by the snapshot must have a Phase 1 entry for the epoch. A contribution is never
 * silently omitted — it is active, excluded for a named reason, or the epoch fails.
 *
 * The weight is `usdtContributed`, immutable and recorded at contribution time. It is never
 * recomputed from ACF principal at any price: a 5,000 USDT contribution carries a 5,000 USDT
 * weight however far ACF has moved.
 */
export async function loadActiveContributions(
  epochId: number,
  snapshotAt: number,
): Promise<ActiveContributionsResult> {
  const sk = stakingKey();
  const contributions = await DAOContribution.find(daoKey()).lean();

  const byUser = new Map<string, { activeUSDT6: bigint; count: number }>();
  const excluded: Record<ExclusionReason, number> = {
    NOT_YET_CONTRIBUTED: 0,
    WITHDRAWN_AT_OR_BEFORE_SNAPSHOT: 0,
  };
  let active = 0;

  if (contributions.length === 0) {
    return { byUser, considered: 0, active: 0, excluded };
  }

  const stakeIds = [...new Set(contributions.map((c) => c.stakeId))];
  const [stakes, entries] = await Promise.all([
    Stake.find({ ...sk, stakeId: { $in: stakeIds } }).lean(),
    StakeRewardEntry.find({ ...sk, epochId, stakeId: { $in: stakeIds } }).lean(),
  ]);
  const stakeById = new Map(stakes.map((s) => [s.stakeId, s]));
  const entryByStakeId = new Map(entries.map((e) => [e.stakeId, e]));

  for (const contribution of contributions) {
    // A contribution whose stake is unknown is a broken link, not an inactive position: the
    // DAO created the stake atomically inside contribute(), so it must exist.
    const stake = stakeById.get(contribution.stakeId);
    if (!stake) {
      throw new DAORevenueInvariantError(
        `DAO contribution ${contribution.contributionId} links stake ${contribution.stakeId}, ` +
          `which is absent from the Stake collection for ${sk.stakingContractAddress}. ` +
          "Refusing to settle DAO revenue against an unverifiable position.",
      );
    }
    assertInvariant(
      contribution.stakingContractAddress === sk.stakingContractAddress,
      `DAO contribution ${contribution.contributionId} references staking contract ` +
        `${contribution.stakingContractAddress}, not the configured ${sk.stakingContractAddress}.`,
    );

    const entry = entryByStakeId.get(contribution.stakeId);
    const verdict = contributionActiveAtSnapshot(
      {
        contributionId: String(contribution.contributionId),
        stakeId: contribution.stakeId,
        contributionBeneficiary: contribution.externalEOA.toLowerCase(),
        stakeTimestamp: Math.floor(stake.stakeTimestamp.getTime() / 1000),
        stakeExternalEOA: stake.externalEOA.toLowerCase(),
        stakeSource: stake.source,
        entry: entry
          ? {
              source: entry.source,
              rewardEligible: entry.rewardEligible,
              ineligibleReason: entry.ineligibleReason ?? null,
              externalEOA: entry.externalEOA,
            }
          : null,
        withdrawnBlockTimestamp: stake.withdrawnBlockTimestamp ?? null,
      },
      snapshotAt,
    );

    if (!verdict.active) {
      excluded[verdict.reason] += 1;
      continue;
    }

    assertInvariant(
      contribution.userId === stake.userId,
      `DAO contribution ${contribution.contributionId} belongs to user ${contribution.userId} ` +
        `but stake ${contribution.stakeId} belongs to ${stake.userId}.`,
    );

    const usdt = BigInt(contribution.usdtContributed);
    assertInvariant(
      usdt > 0n,
      `DAO contribution ${contribution.contributionId} records a non-positive USDT amount ${usdt}.`,
    );

    const current = byUser.get(contribution.userId) ?? { activeUSDT6: 0n, count: 0 };
    byUser.set(contribution.userId, {
      activeUSDT6: current.activeUSDT6 + usdt,
      count: current.count + 1,
    });
    active += 1;
  }

  return { byUser, considered: contributions.length, active, excluded };
}

export interface MemberIdentity {
  userId: string;
  externalEOA: string;
}

/**
 * Resolves payout identity for each eligible user.
 *
 * `distributeBatch(epochId, users[], amounts[])` takes the member's own address, and the
 * distributor transfers to exactly that address. The argument and the destination are the same
 * value, so there is nothing to resolve and nothing to verify a pair against.
 *
 * A missing address FAILS the epoch rather than falling back to anything: there is no second
 * address that could stand in for it.
 */
export async function loadMemberIdentities(userIds: string[]): Promise<Map<string, MemberIdentity>> {
  if (userIds.length === 0) return new Map();

  const users = await User.find(
    { userId: { $in: userIds } },
    { userId: 1, externalEOA: 1 },
  ).lean();
  const byUserId = new Map(users.map((u) => [u.userId, u]));

  const missing = userIds.filter((id) => !byUserId.has(id));
  if (missing.length > 0) {
    throw new DAORevenueInvariantError(
      `No user record for ${missing.length} eligible DAO member(s): ${missing.slice(0, 10).join(", ")}.`,
    );
  }

  const identities = new Map<string, MemberIdentity>();
  for (const userId of userIds) {
    const user = byUserId.get(userId)!;
    if (!user.externalEOA) {
      throw new DAORevenueInvariantError(
        `Eligible DAO member ${userId} has no address. distributeBatch pays exactly the address ` +
          "it is given, so the epoch cannot be executed.",
      );
    }
    identities.set(userId, { userId, externalEOA: user.externalEOA.toLowerCase() });
  }
  return identities;
}
