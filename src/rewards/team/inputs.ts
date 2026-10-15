import { Stake } from "../../models/Stake.js";
import { TEAM_PROPAGATION_ALL_SOURCES, type TeamPropagationRule } from "./policy.js";
import { StakeRewardEntry } from "../../models/StakeRewardEntry.js";
import type { StakeSource } from "../policy.js";

/**
 * Phase 2's view of a stake, derived entirely from Phase 1's immutable epoch output.
 *
 * Phase 2 performs NO chain reads and consults NO mutable state. Phase 1 already decided each
 * position's state at `snapshotBlockNumber` with a pinned read, verified its principal, pool,
 * source and beneficiary against the chain, and proved the row persisted. Re-deriving any of
 * that here would create a second financial truth that could drift from the first.
 */

/** STAKE -> ENTRY: a position existed at the boundary but Phase 1 never settled it. */
export class MissingRewardEntryError extends Error {
  readonly code = "MISSING_REWARD_ENTRY";
  constructor(stakeIds: string[], epochId: number) {
    super(
      `${stakeIds.length} stake(s) existed at epoch ${epochId}'s boundary but have no Phase 1 ` +
        `reward entry: ${stakeIds.slice(0, 10).join(", ")}. Phase 1 guarantees one entry per ` +
        "such stake for a CALCULATED epoch, so this is corrupt financial state.",
    );
    this.name = "MissingRewardEntryError";
  }
}

/**
 * ENTRY -> STAKE: a Phase 1 reward row whose canonical Stake record is gone.
 *
 * The opposite direction, and deliberately its own error so the direction is never ambiguous.
 * Phase 1 builds entries BY iterating Stake rows and nothing deletes them, so an entry without
 * its stake cannot arise legitimately. Ignoring it would drop that position's principal from
 * Self, Team, L1 and activeDirects — silently lowering a rank, and with it Rank and Global
 * income — while the epoch still declared itself calculated.
 */
export class MissingStakeError extends Error {
  readonly code = "MISSING_STAKE";
  constructor(stakeIds: string[], epochId: number) {
    super(
      `${stakeIds.length} Phase 1 reward entr(ies) for epoch ${epochId} have no corresponding ` +
        `Stake record: ${stakeIds.slice(0, 10).join(", ")}. A reward entry cannot legitimately ` +
        "exist without its canonical stake, so this is corrupt financial state.",
    );
    this.name = "MissingStakeError";
  }
}

/**
 * The same stake id appearing twice where a unique index makes that impossible.
 *
 * Unreachable through normal writes. If corrupt data produces it, picking one row arbitrarily
 * would decide someone's qualification by insertion order.
 */
export class DuplicateStakeIdentityError extends Error {
  readonly code = "DUPLICATE_STAKE_IDENTITY";
  constructor(collection: string, stakeId: string, epochId: number) {
    super(
      `${collection} contains more than one row for stake ${stakeId} at epoch ${epochId}. ` +
        "Refusing to choose between duplicate financial records.",
    );
    this.name = "DuplicateStakeIdentityError";
  }
}

export interface StakeFact {
  stakeId: string;
  userId: string;
  source: StakeSource;
  /** Chain-verified by Phase 1 for every stake that existed at the boundary. */
  principalACF: bigint;
  /** State AT snapshotAt, from Phase 1's pinned read. */
  activeAtSnapshot: boolean;
  /**
   * This epoch's DIRECT+BOND reward. Zero for DAO positions.
   *
   * Its meaning is FIXED and does not vary by epoch. The propagation rule is applied downstream,
   * at the fold, so a historical row and a current one mean the same thing by this name.
   */
  regularSelfACF: bigint;
  /**
   * This epoch's DAO reward.
   *
   * Whether it reaches Level and Rank depends on the epoch's propagation rule — see
   * `teamPropagationRuleForEpoch`. It is always the owner's Self reward and always compounds for
   * them, in both rules.
   */
  daoSelfACF: bigint;
  stakeTimestamp: number;
}

export interface EpochStakeFacts {
  /** Only positions that existed at the boundary. */
  facts: StakeFact[];
  /** Gross principal created in [windowStart, snapshotAt), regardless of later withdrawal. */
  networkContributionACF: bigint;
}

type Key = { chainId: number; stakingContractAddress: string };

/**
 * Reads Phase 1's settled epoch and interprets it.
 *
 *   stakeTimestamp > snapshotAt   excluded, EVEN IF an entry exists — a position created after
 *                                 the boundary may already have been discovered and carry a
 *                                 TOO_YOUNG row, but it was never part of this epoch
 *   no entry                      corrupt state, fail loudly
 *   WITHDRAWN                     inactive at the boundary
 *   TOO_YOUNG                     ACTIVE at the boundary, just too new to earn — it still
 *                                 counts as principal for rank and global qualification
 *   rewardEligible                active at the boundary
 */
export async function loadEpochStakeFacts(
  k: Key,
  epochId: number,
  windowStart: number,
  snapshotAt: number,
): Promise<EpochStakeFacts> {
  // Stake is the existence record; its stakeTimestamp is immutable and is the only field read
  // from it. StakeRewardEntry carries no stakeTimestamp, hence the join.
  const [stakes, entries] = await Promise.all([
    Stake.find({ ...k }, { stakeId: 1, stakeTimestamp: 1 }).lean(),
    StakeRewardEntry.find(
      { ...k, epochId },
      {
        stakeId: 1, userId: 1, source: 1, principalACF: 1,
        rewardACF: 1, rewardEligible: 1, ineligibleReason: 1,
      },
    ).lean(),
  ]);

  // Built explicitly rather than via Map(entries.map(...)), which would silently keep the
  // last of a duplicate pair.
  const stakeTimestampById = new Map<string, number>();
  for (const stake of stakes) {
    if (stakeTimestampById.has(stake.stakeId)) {
      throw new DuplicateStakeIdentityError("Stake", stake.stakeId, epochId);
    }
    stakeTimestampById.set(stake.stakeId, Math.floor(stake.stakeTimestamp.getTime() / 1000));
  }
  const entryByStakeId = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    if (entryByStakeId.has(entry.stakeId)) {
      throw new DuplicateStakeIdentityError("StakeRewardEntry", entry.stakeId, epochId);
    }
    entryByStakeId.set(entry.stakeId, entry);
  }

  // DIRECTION 2, checked BEFORE the per-stake walk: every entry must have its stake. It has to
  // come first, because an orphan is invisible to a loop that iterates stakes.
  const orphanEntries = [...entryByStakeId.keys()].filter((id) => !stakeTimestampById.has(id));
  if (orphanEntries.length > 0) throw new MissingStakeError(orphanEntries, epochId);

  const facts: StakeFact[] = [];
  const missing: string[] = [];
  let networkContributionACF = 0n;

  // DIRECTION 1: every stake that existed at the boundary must have an entry. A stake created
  // AFTER the boundary is excluded first, so it cannot raise a false missing-entry failure.
  for (const stake of stakes) {
    const stakeTimestamp = stakeTimestampById.get(stake.stakeId)!;
    // FIRST gate, before the entry is even consulted.
    if (stakeTimestamp > snapshotAt) continue;

    const entry = entryByStakeId.get(stake.stakeId);
    if (!entry) {
      missing.push(stake.stakeId);
      continue;
    }

    const source = entry.source as StakeSource;
    const principalACF = BigInt(entry.principalACF);
    const rewardACF = BigInt(entry.rewardACF);

    facts.push({
      stakeId: stake.stakeId,
      userId: entry.userId,
      source,
      principalACF,
      activeAtSnapshot: entry.ineligibleReason !== "WITHDRAWN",
      regularSelfACF: source === "DAO" ? 0n : rewardACF,
      daoSelfACF: source === "DAO" ? rewardACF : 0n,
      stakeTimestamp,
    });

    // Gross principal FLOW for this window: no active filter, no netting of withdrawals. A
    // position created and withdrawn inside the same epoch still contributed.
    if (stakeTimestamp >= windowStart && stakeTimestamp < snapshotAt) {
      networkContributionACF += principalACF;
    }
  }

  if (missing.length > 0) throw new MissingRewardEntryError(missing, epochId);

  return { facts, networkContributionACF };
}

export interface UserStakeTotals {
  ownActiveStakeACF: bigint;
  /** DIRECT+BOND staking reward. Fixed meaning, in every epoch. */
  ownRegularSelfACF: bigint;
  /** DAO staking reward. Fixed meaning, in every epoch. */
  ownDAOSelfACF: bigint;
  /**
   * The staking reward that propagates to Level and Rank under THIS epoch's rule.
   *
   * The single canonical value both consumers read. Derived once, here, rather than by Level and
   * Rank each adding up sources for themselves — two places adding the same thing is how a
   * reward comes to be counted twice.
   *
   * Under REGULAR_ONLY it equals ownRegularSelfACF; under ALL_SOURCES it is the sum of the two
   * above. Either way each reward enters exactly once, because the two components are disjoint
   * by construction: a stake has one source.
   */
  ownPropagatingSelfACF: bigint;
}

/**
 * Folds the per-stake facts into per-user totals.
 *
 * Active principal is all three sources under both rules — it always was, which is why Global,
 * computed from principal, is untouched by the propagation rule.
 */
export function foldByUser(
  facts: StakeFact[],
  /** The epoch's rule. Passed in, never derived from a clock. */
  propagationRule: TeamPropagationRule,
): Map<string, UserStakeTotals> {
  const byUser = new Map<string, UserStakeTotals>();
  const propagatesDAO = propagationRule === TEAM_PROPAGATION_ALL_SOURCES;

  for (const f of facts) {
    const t = byUser.get(f.userId) ?? {
      ownActiveStakeACF: 0n,
      ownRegularSelfACF: 0n,
      ownDAOSelfACF: 0n,
      ownPropagatingSelfACF: 0n,
    };
    if (f.activeAtSnapshot) t.ownActiveStakeACF += f.principalACF;
    t.ownRegularSelfACF += f.regularSelfACF;
    t.ownDAOSelfACF += f.daoSelfACF;
    // Regular always; DAO only when the epoch's rule says so. Never both from one fact.
    t.ownPropagatingSelfACF += f.regularSelfACF + (propagatesDAO ? f.daoSelfACF : 0n);
    byUser.set(f.userId, t);
  }
  return byUser;
}
