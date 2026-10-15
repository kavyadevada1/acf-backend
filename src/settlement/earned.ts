import { RewardEpoch } from "../models/RewardEpoch.js";
import { RewardPhase2Epoch } from "../models/RewardPhase2Epoch.js";
import { StakeRewardEntry } from "../models/StakeRewardEntry.js";
import { TeamRewardEntry } from "../models/TeamRewardEntry.js";

/**
 * Reads what Phase 1 and Phase 2 already settled. Nothing here recomputes a reward.
 *
 * Amounts are $push-ed as strings and summed as bigint in application memory: a Mongo $sum over
 * 18-decimal values would silently round through a BSON double.
 */

type StakeKey = { chainId: number; stakingContractAddress: string };

/** The maximal CONTIGUOUS range of epochs both phases have settled, after `afterEpochId`. */
export async function settledEpochRange(
  k: StakeKey,
  afterEpochId: number | null,
): Promise<{ from: number; through: number; epochIds: number[] } | null> {
  const phase1 = await RewardEpoch.find(
    {
      ...k,
      status: { $in: ["CALCULATED", "FINALIZED"] },
      ...(afterEpochId === null ? {} : { epochId: { $gt: afterEpochId } }),
    },
    { epochId: 1 },
  ).sort({ epochId: 1 }).lean();
  if (phase1.length === 0) return null;

  const phase2 = await RewardPhase2Epoch.find(
    { ...k, status: "CALCULATED", epochId: { $in: phase1.map((e) => e.epochId) } },
    { epochId: 1 },
  ).lean();
  const settled2 = new Set(phase2.map((e) => e.epochId));

  // Strictly contiguous. A gap ends the range so a late-settling epoch still has a checkpoint
  // to belong to; skipping it would leave a hole nothing could ever fill.
  const epochIds: number[] = [];
  let expected: number | null = null;
  for (const e of phase1) {
    if (!settled2.has(e.epochId)) break;
    if (expected !== null && e.epochId !== expected) break;
    epochIds.push(e.epochId);
    expected = e.epochId + 1;
  }
  if (epochIds.length === 0) return null;
  return { from: epochIds[0]!, through: epochIds.at(-1)!, epochIds };
}

export interface EarnedTotals {
  selfACF: bigint;
  teamACF: bigint;
}

const add = (m: Map<string, EarnedTotals>, userId: string, self: bigint, team: bigint) => {
  const t = m.get(userId) ?? { selfACF: 0n, teamACF: 0n };
  t.selfACF += self;
  t.teamACF += team;
  m.set(userId, t);
};

/**
 * Per-user Self and Team earned across an epoch id set, in two bulk aggregations.
 *
 * `userIds` narrows the scan when only a handful of newly-publishable users need their lifetime
 * history — the alternative, one query per user, is what makes deferred release expensive.
 */
export async function earnedByUser(
  k: StakeKey,
  epochFilter: Record<string, unknown>,
  userIds?: string[],
): Promise<Map<string, EarnedTotals>> {
  const scope = userIds === undefined ? {} : { userId: { $in: userIds } };
  if (userIds !== undefined && userIds.length === 0) return new Map();

  const [selfRows, teamRows] = await Promise.all([
    StakeRewardEntry.aggregate<{ _id: string; amounts: string[] }>([
      { $match: { ...k, ...epochFilter, rewardEligible: true, ...scope } },
      { $group: { _id: "$userId", amounts: { $push: "$rewardACF" } } },
    ]),
    TeamRewardEntry.aggregate<{ _id: string; amounts: string[] }>([
      { $match: { ...k, ...epochFilter, ...scope } },
      { $group: { _id: "$userId", amounts: { $push: "$teamRewardACF" } } },
    ]),
  ]);

  const out = new Map<string, EarnedTotals>();
  for (const r of selfRows) {
    add(out, r._id, r.amounts.reduce((s, a) => s + BigInt(a), 0n), 0n);
  }
  for (const r of teamRows) {
    add(out, r._id, 0n, r.amounts.reduce((s, a) => s + BigInt(a), 0n));
  }
  return out;
}

export interface SelfComponent {
  userId: string;
  stakeId: string;
  source: "DIRECT" | "BOND" | "DAO";
  rewardEpochId: number;
  rewardACF: bigint;
}

/** Every non-zero Phase 1 staking reward in scope, for per-stake claim composition. */
export async function selfComponents(
  k: StakeKey,
  epochFilter: Record<string, unknown>,
  userIds?: string[],
): Promise<SelfComponent[]> {
  if (userIds !== undefined && userIds.length === 0) return [];
  const scope = userIds === undefined ? {} : { userId: { $in: userIds } };
  const rows = await StakeRewardEntry.find(
    { ...k, ...epochFilter, rewardEligible: true, rewardACF: { $ne: "0" }, ...scope },
    { userId: 1, stakeId: 1, source: 1, epochId: 1, rewardACF: 1 },
  ).lean();
  return rows
    .map((r) => ({
      userId: r.userId,
      stakeId: r.stakeId,
      source: r.source as SelfComponent["source"],
      rewardEpochId: r.epochId,
      rewardACF: BigInt(r.rewardACF),
    }))
    .filter((c) => c.rewardACF > 0n);
}
