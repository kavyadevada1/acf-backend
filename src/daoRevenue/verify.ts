/**
 * Read-back verification for DAO revenue rows.
 *
 * Mirrors the Phase 2/3 discipline: after persisting, every row is read back and compared field
 * by field. A divergent immutable row is REPORTED, never repaired — overwriting financial
 * history would hide the very corruption this detects.
 *
 * It exists because `insertMany(ordered: false)` cannot be trusted to report what it skipped:
 * a duplicate sets a top-level code 11000 while a validation-rejected row appears in no error
 * channel at all. The only reliable question is "what is actually in the database now".
 */

export class DAORevenueRowError extends Error {
  readonly code = "DAO_REVENUE_ROW_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "DAORevenueRowError";
  }
}

/** Fields compared on a member entry. Every one is financial or identity-critical. */
export const MEMBER_ENTRY_FIELDS = [
  "userId", "externalEOA",
  "activeContributionUSDT6", "totalEligibleContributionUSDT6", "activeContributionCount",
  "memberRevenueRateE6", "systemRevenueUSD6", "daoRevenuePoolUSD6", "priceE18",
  "memberRevenueUSD6", "memberRevenueACF", "batchIndex",
] as const;

/** Fields compared on the epoch row. */
export const EPOCH_FIELDS = [
  "windowStart", "snapshotAt", "snapshotBlockNumber", "priceE18",
  "systemRegularSelfACF", "systemDAOStakeRewardACF", "systemSelfRewardACF", "systemRevenueUSD6",
  "revenueEnabledAtSnapshot", "silverMinimumUSDT6", "goldMinimumUSDT6", "memberRevenueRateE6",
  "configBlockNumber", "configLogIndex",
  "daoRevenuePoolUSD6", "totalEligibleContributionUSDT6",
  "totalMemberRevenueUSD6", "totalMemberRevenueACF", "roundingDustUSD6",
  "marketingRateE6", "marketingCollector", "marketingRevenueUSD6", "marketingRevenueACF",
  "totalObligationACF", "memberRoot",
  "eligibleMembers", "batchCount", "manifestHash",
] as const;

/**
 * Compares a persisted row against what was computed.
 *
 * Normalises to strings so a stored "5" and a computed 5 compare equal — the question is
 * whether the value is right, not which driver boxed it.
 */
export function assertRowMatches(
  label: string,
  stored: Record<string, unknown>,
  expected: Record<string, unknown>,
  fields: readonly string[],
): void {
  const mismatches: string[] = [];
  for (const field of fields) {
    const a = normalise(stored[field]);
    const b = normalise(expected[field]);
    if (a !== b) mismatches.push(`${field} expected ${b}, stored ${a}`);
  }
  if (mismatches.length > 0) {
    throw new DAORevenueRowError(
      `${label} diverges from the calculated value: ${mismatches.join("; ")}. ` +
        "Immutable financial history is never repaired; this needs investigation.",
    );
  }
}

function normalise(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return value.toString();
  return String(value);
}
