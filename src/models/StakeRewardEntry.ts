import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One immutable reward row per stake per epoch.
 *
 * Deliberately not a mutable "current balance": compounding, auditing and the later claim
 * mapping all need to know what was earned when, at which rate, from which base. A single
 * accumulator answers none of those and cannot be re-derived once overwritten.
 *
 * Rows are written only by a successfully completing epoch, and read back only from epochs
 * whose RewardEpoch.status is CALCULATED — so a half-written epoch can never feed a later
 * compound base.
 */
const StakeRewardEntrySchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    stakeId: { type: String, required: true, immutable: true },
    epochId: { type: Number, required: true, immutable: true },

    userId: { type: String, required: true, immutable: true },
    externalEOA: { type: String, required: true, immutable: true, lowercase: true },
    source: { type: String, required: true, enum: ["DIRECT", "BOND", "DAO"], immutable: true },
    poolId: { type: Number, required: true, immutable: true },

    /** All base-unit strings. ACF has 18 decimals. */
    principalACF: { type: String, required: true, immutable: true },
    compoundBaseACF: { type: String, required: true, immutable: true },
    rewardACF: { type: String, required: true, immutable: true },
    /** Running total of this stake's earned reward, through and including this epoch. */
    cumulativeEarnedACF: { type: String, required: true, immutable: true },

    /** The exact rate used, kept so a payout can be re-derived years later. */
    rateApplied: { type: String, required: true, immutable: true },
    rateDenominator: { type: String, required: true, immutable: true },

    /**
     * Skipped stakes are recorded too, with rewardACF "0" and a reason. Absence of a row would
     * be ambiguous — unprocessed and ineligible would look identical.
     */
    rewardEligible: { type: Boolean, required: true, immutable: true },
    ineligibleReason: { type: String, default: null, immutable: true },

    snapshotAt: { type: Number, required: true, immutable: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

// The idempotency guarantee: a re-run cannot double-pay, because the insert collides.
StakeRewardEntrySchema.index(
  { chainId: 1, stakingContractAddress: 1, stakeId: 1, epochId: 1 },
  { unique: true },
);
// Phase 2 reads per user per epoch, split by source.
StakeRewardEntrySchema.index({ userId: 1, epochId: 1, source: 1 });
// Phase 2 reads EVERY entry for one epoch. The unique index above begins with stakeId and
// cannot serve that query. Additive only; no Phase 1 field or semantic changes.
StakeRewardEntrySchema.index({ chainId: 1, stakingContractAddress: 1, epochId: 1 });
StakeRewardEntrySchema.index({ stakeId: 1, epochId: -1 });

export type StakeRewardEntryDocument = InferSchemaType<typeof StakeRewardEntrySchema>;
export const StakeRewardEntry = model("StakeRewardEntry", StakeRewardEntrySchema);
