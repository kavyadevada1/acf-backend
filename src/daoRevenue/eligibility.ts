import { DAORevenueInvariantError } from "./policy.js";

/**
 * Was a DAO contribution ACTIVE at a reward epoch's snapshot?
 *
 * This is the single most dangerous question in Phase 4: get it wrong and a withdrawn member is
 * paid, or an active one is skipped, for an epoch that will never recalculate.
 *
 * WHY PHASE 1 IS THE AUTHORITY
 * ----------------------------
 * `ACFDAO.isContributionActive(id)` checks three things — the linked stake is active, owned by
 * the contribution's beneficiary, and source DAO — all at LATEST. That is current state, so it
 * would retroactively void an epoch the position was active throughout, or validate one it was
 * not.
 *
 * Phase 1 already produced the historical equivalent and froze it. For every settled epoch it
 * reads each stake PINNED to that epoch's snapshot block, asserts principal, poolId, source and
 * beneficiary against that read (`assertImmutableFieldsMatch`), and writes one immutable
 * StakeRewardEntry per stake unconditionally — including withdrawn ones, marked WITHDRAWN. That
 * covers all three of the contract's conditions, verified against the chain at the right block.
 * No second historical RPC engine is needed, and none should be built.
 *
 * THE TOO_YOUNG BOUNDARY — LOCKED CORRECTION
 * ------------------------------------------
 * `ineligibleReason === "TOO_YOUNG"` means one of TWO different things in Phase 1:
 *
 *   1. the stake existed at the snapshot but was younger than one epoch, or
 *   2. the stake did not exist at the snapshot block at all.
 *
 * Phase 1 conflates them deliberately and harmlessly — both earn zero — but for DAO revenue
 * they are opposites. Case 1 is an ACTIVE contribution that should be paid; case 2 is a
 * contribution that did not yet exist and must be excluded. `Stake.stakeTimestamp`, which is
 * immutable, separates them. Treating TOO_YOUNG alone as active would pay members for epochs
 * that closed before they joined.
 */

export type ExclusionReason =
  | "NOT_YET_CONTRIBUTED"
  | "WITHDRAWN_AT_OR_BEFORE_SNAPSHOT";

export interface ActivityInput {
  contributionId: string;
  stakeId: string;
  /** Beneficiary recorded on the contribution, lowercase. */
  contributionBeneficiary: string;
  /** Immutable creation time of the linked stake, unix seconds. */
  stakeTimestamp: number;
  /** Lowercase beneficiary on the Stake row. */
  stakeExternalEOA: string;
  stakeSource: string;
  /**
   * The Phase 1 entry for THIS epoch, or null when none exists.
   *
   * Null is only legitimate for a stake created after the snapshot. For one that existed, a
   * missing entry means Phase 1's data for the epoch is incomplete and the epoch must fail.
   */
  entry: {
    source: string;
    rewardEligible: boolean;
    ineligibleReason: string | null;
    externalEOA: string;
  } | null;
  /**
   * Secondary audit metadata. Null is NOT evidence of activity: the Phase 1 backfill that
   * recovers it is best-effort and bounded, so a withdrawn stake can legitimately have none.
   */
  withdrawnBlockTimestamp: number | null;
}

export type ActivityVerdict =
  | { active: true }
  | { active: false; reason: ExclusionReason };

/**
 * Decides activity, and throws rather than guessing when the inputs disagree.
 *
 * A contribution is never silently omitted: either it is active, or it is excluded for a named
 * reason, or the epoch fails.
 */
export function contributionActiveAtSnapshot(
  input: ActivityInput,
  snapshotAt: number,
): ActivityVerdict {
  // ── identity, before anything financial ────────────────────────────────
  if (input.stakeSource !== "DAO") {
    throw new DAORevenueInvariantError(
      `Contribution ${input.contributionId} links stake ${input.stakeId}, whose source is ` +
        `${input.stakeSource}, not DAO. Refusing to weight a non-DAO position.`,
    );
  }
  if (input.stakeExternalEOA !== input.contributionBeneficiary) {
    throw new DAORevenueInvariantError(
      `Contribution ${input.contributionId} beneficiary ${input.contributionBeneficiary} does ` +
        `not match stake ${input.stakeId} beneficiary ${input.stakeExternalEOA}.`,
    );
  }

  // ── did it exist at the boundary? ──────────────────────────────────────
  // This is the TOO_YOUNG disambiguation. It must precede every entry check, because a stake
  // created after the snapshot legitimately has no entry for this epoch.
  if (input.stakeTimestamp > snapshotAt) {
    return { active: false, reason: "NOT_YET_CONTRIBUTED" };
  }

  // ── it existed, so Phase 1 must have recorded a verdict for it ─────────
  if (input.entry === null) {
    throw new DAORevenueInvariantError(
      `Contribution ${input.contributionId} links stake ${input.stakeId}, created at ` +
        `${input.stakeTimestamp} (<= snapshot ${snapshotAt}), but no Phase 1 reward entry ` +
        "exists for this epoch. Phase 1 writes one entry per stake per settled epoch; refusing " +
        "to weight a contribution whose historical state is unknown.",
    );
  }
  if (input.entry.source !== "DAO") {
    throw new DAORevenueInvariantError(
      `Phase 1 entry for stake ${input.stakeId} records source ${input.entry.source}, not DAO.`,
    );
  }
  if (input.entry.externalEOA.toLowerCase() !== input.contributionBeneficiary) {
    throw new DAORevenueInvariantError(
      `Phase 1 entry for stake ${input.stakeId} records beneficiary ` +
        `${input.entry.externalEOA}, not ${input.contributionBeneficiary}.`,
    );
  }

  const withdrawnAtSnapshot = input.entry.ineligibleReason === "WITHDRAWN";

  // ── cross-check against the recovered withdrawal boundary ──────────────
  // Only meaningful when non-null. A disagreement means two immutable records contradict each
  // other about the same block, so neither can be trusted.
  if (input.withdrawnBlockTimestamp !== null) {
    const withdrawnByTimestamp = input.withdrawnBlockTimestamp <= snapshotAt;
    if (withdrawnByTimestamp !== withdrawnAtSnapshot) {
      throw new DAORevenueInvariantError(
        `Stake ${input.stakeId} disagrees about epoch snapshot ${snapshotAt}: Phase 1 says ` +
          `${withdrawnAtSnapshot ? "WITHDRAWN" : "active"} but withdrawnBlockTimestamp ` +
          `${input.withdrawnBlockTimestamp} says ${withdrawnByTimestamp ? "withdrawn" : "active"}.`,
      );
    }
  }

  if (withdrawnAtSnapshot) {
    return { active: false, reason: "WITHDRAWN_AT_OR_BEFORE_SNAPSHOT" };
  }

  // rewardEligible true, or TOO_YOUNG with the stake already in existence. Both are active:
  // maturity and age affect what a stake EARNS, never whether its principal is committed.
  return { active: true };
}
