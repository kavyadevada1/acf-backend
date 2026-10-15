import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One 12-hour DAO Member Revenue epoch.
 *
 * Aligned 1:1 with the Phase 1 reward epoch — same epochId, window, snapshot and price — so the
 * economics are defined at the reward boundary and cannot drift. DAO revenue is a DIRECT push
 * paid in ACF to members' own wallets; it is not part of the Withdrawal Merkle claim, does not
 * compound, and generates no Level, Rank or Global reward.
 *
 * Identity includes the distributor address because `paid[epochId][user]`, `funded` and
 * `distributed` all live in that contract: a different deployment is a different payment
 * history, and reusing an epochId across them must not collide.
 *
 * Financial fields are immutable once written. Execution fields are deliberately separate and
 * mutable, so retrying a funding or a batch can never touch a calculated obligation.
 */
const DAORevenueEpochSchema = new Schema(
  {
    // ── identity ──────────────────────────────────────────────────────────
    chainId: { type: Number, required: true, immutable: true },
    daoContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    distributorAddress: { type: String, required: true, immutable: true, lowercase: true },
    epochId: { type: Number, required: true, immutable: true },

    /** Recorded so a later audit can prove which deployments produced these numbers. */
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    treasuryAddress: { type: String, required: true, immutable: true, lowercase: true },

    // ── inherited Phase 1 boundary (never recomputed here) ────────────────
    windowStart: { type: Number, required: true, immutable: true },
    snapshotAt: { type: Number, required: true, immutable: true },
    snapshotBlockNumber: { type: Number, required: true, immutable: true },
    /** The epoch's frozen ACF/USDT price. Both conversions use this one value. */
    priceE18: { type: String, required: true, immutable: true },

    // ── system revenue (Self-type staking reward only) ────────────────────
    /** DIRECT + BOND. */
    systemRegularSelfACF: { type: String, required: true, immutable: true },
    /** source = DAO. */
    systemDAOStakeRewardACF: { type: String, required: true, immutable: true },
    /** The sum of the two above; the DAO revenue base. */
    systemSelfRewardACF: { type: String, required: true, immutable: true },
    /** systemSelfRewardACF converted at priceE18, in USDT base units. */
    systemRevenueUSD6: { type: String, required: true, immutable: true },

    // ── DAO configuration AS OF snapshotBlockNumber ───────────────────────
    revenueEnabledAtSnapshot: { type: Boolean, required: true, immutable: true },
    silverMinimumUSDT6: { type: String, required: true, immutable: true },
    goldMinimumUSDT6: { type: String, required: true, immutable: true },
    memberRevenueRateE6: { type: String, required: true, immutable: true },
    /** The marketing rate in force at the snapshot, on the same 1e6 denominator. */
    marketingRateE6: { type: String, required: true, immutable: true },
    /**
     * The marketing recipient in force at the snapshot, pinned here and nowhere else.
     *
     * Recorded rather than read at execution time, because ACFDAO's collector is admin-mutable.
     * This address is what Treasury PINS on the distributor when the epoch is funded, and
     * `payMarketing` then uses the pinned value — so the epoch permanently owns its recipient and
     * a later collector change reaches future epochs only, redirecting nothing and stranding
     * nothing.
     */
    marketingCollector: { type: String, required: true, immutable: true, lowercase: true },
    /** Which config row was resolved, so the as-of decision is reproducible. */
    configBlockNumber: { type: Number, required: true, immutable: true },
    configLogIndex: { type: Number, required: true, immutable: true },

    // ── the pool and what was actually owed ───────────────────────────────
    daoRevenuePoolUSD6: { type: String, required: true, immutable: true },
    totalEligibleContributionUSDT6: { type: String, required: true, immutable: true },
    totalMemberRevenueUSD6: { type: String, required: true, immutable: true },
    /**
     * The EXACT amount to fund and distribute: the sum of per-member floored ACF.
     *
     * Never the theoretical pool. The distributor has no sweep function, so anything funded
     * beyond the sum of payouts is stranded in it permanently.
     */
    totalMemberRevenueACF: { type: String, required: true, immutable: true },
    /** daoRevenuePoolUSD6 - Σ memberRevenueUSD6. Audit only; never funded. */
    roundingDustUSD6: { type: String, required: true, immutable: true },

    // ── the marketing allocation: one recipient, one amount ───────────────
    /** systemRevenueUSD6 x marketingRateE6 / 1e6, floored. A SEPARATE share, not part of the pool. */
    marketingRevenueUSD6: { type: String, required: true, immutable: true },
    /**
     * The exact marketing ACF to fund and pay, converted at the same epoch price as every member
     * amount. Zero when the floored allocation rounds away, in which case nothing is owed and
     * nothing is paid — never funded "just in case", because the distributor has no sweep.
     */
    marketingRevenueACF: { type: String, required: true, immutable: true },
    /**
     * The total the epoch must fund: Σ member ACF + marketing ACF.
     *
     * Stored rather than recomputed so the funded amount, the obligation and the manifest can be
     * compared to one figure. Funding more than this strands ACF in the distributor permanently.
     */
    totalObligationACF: { type: String, required: true, immutable: true },
    eligibleMembers: { type: Number, required: true, immutable: true },
    batchCount: { type: Number, required: true, immutable: true },
    /** Canonical hash of the execution manifest the executor must verify before signing. */
    manifestHash: { type: String, required: true, immutable: true },
    /**
     * Merkle root over leaves binding (epochId, member, amount) — the member commitment.
     *
     * This is what the AUTHORIZER commits on chain and what every member transfer must prove
     * against, so the executor cannot substitute an address or an amount. Zero when no member is
     * owed. Immutable: a different root would be a different set of entitlements.
     */
    memberRoot: { type: String, required: true, immutable: true, lowercase: true },

    // ── mutable execution state ───────────────────────────────────────────
    status: {
      type: String, required: true,
      enum: [
        "CALCULATING", "CALCULATED", "AUTHORIZED", "FUNDING_SUBMITTED", "FUNDED",
        "DISTRIBUTING", "COMPLETED", "FAILED", "NOTHING_TO_DISTRIBUTE",
      ],
      default: "CALCULATING",
    },
    /**
     * Why nothing is owed. Recorded rather than skipped, so a historical epoch cannot be
     * silently reconsidered later under different configuration.
     */
    reason: {
      type: String, default: null,
      enum: [
        "PROGRAM_DISABLED", "NO_SYSTEM_REVENUE", "EMPTY_POOL",
        "NO_ELIGIBLE_MEMBERS", "ALL_SHARES_ROUNDED_TO_ZERO", null,
      ],
    },
    leaseExpiresAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String, default: null },

    fundingTxHash: { type: String, default: null, lowercase: true },
    fundingBlockNumber: { type: Number, default: null },
    fundingBlockTimestamp: { type: Number, default: null },
    /** What the chain says was funded, read back after the receipt. */
    fundedACF: { type: String, default: null },

    paidMembers: { type: Number, required: true, default: 0 },

    /** Evidence that the epoch's payable set was committed on chain, by the authorizer's key. */
    authorizationTxHash: { type: String, default: null, lowercase: true },
    authorizationBlockNumber: { type: Number, default: null },
    authorizedAt: { type: Date, default: null },

    /** What the chain reports paid for marketing; null until reconciled, "0" while unpaid. */
    marketingPaidACF: { type: String, default: null },
    marketingTxHash: { type: String, default: null, lowercase: true },
    marketingBlockNumber: { type: Number, default: null },
    marketingPaidAt: { type: Date, default: null },

    calculatedAt: { type: Date, default: null },
    fundedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, strict: true },
);

DAORevenueEpochSchema.index(
  { chainId: 1, daoContractAddress: 1, distributorAddress: 1, epochId: 1 },
  { unique: true },
);
// Catch-up and executor sweeps: oldest actionable epoch first.
DAORevenueEpochSchema.index({ chainId: 1, distributorAddress: 1, status: 1, epochId: 1 });

export type DAORevenueEpochDocument = InferSchemaType<typeof DAORevenueEpochSchema>;
export const DAORevenueEpoch = model("DAORevenueEpoch", DAORevenueEpochSchema);
