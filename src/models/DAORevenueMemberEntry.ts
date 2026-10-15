import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One member's immutable DAO revenue obligation for one epoch.
 *
 * Every field is immutable. Payment state lives in DAORevenuePayment so that reconciling a
 * confirmed transfer can never rewrite what was owed.
 *
 * One address, because there is only one role left: `externalEOA` is what goes into
 * `distributeBatch(epochId, users[], amounts[])` AND where the ACF lands. The distributor
 * resolves nothing, so the address the executor submits is the address paid, and there is no
 * pair left to verify.
 */
const DAORevenueMemberEntrySchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    daoContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    distributorAddress: { type: String, required: true, immutable: true, lowercase: true },
    epochId: { type: Number, required: true, immutable: true },

    userId: { type: String, required: true, immutable: true },
    /** The distributeBatch argument, and the payout recipient: the same address. */
    externalEOA: { type: String, required: true, immutable: true, lowercase: true },

    /** Σ recorded USDT of this member's contributions active at the snapshot. Never repriced. */
    activeContributionUSDT6: { type: String, required: true, immutable: true },
    /** The denominator this share was computed against, kept so the weight is reproducible. */
    totalEligibleContributionUSDT6: { type: String, required: true, immutable: true },
    /** How many contributions aggregated into the weight; the ids are queried, not embedded. */
    activeContributionCount: { type: Number, required: true, immutable: true },

    memberRevenueRateE6: { type: String, required: true, immutable: true },
    systemRevenueUSD6: { type: String, required: true, immutable: true },
    daoRevenuePoolUSD6: { type: String, required: true, immutable: true },
    priceE18: { type: String, required: true, immutable: true },

    memberRevenueUSD6: { type: String, required: true, immutable: true },
    /** The exact ACF this member is owed, floored. The payout amount. */
    memberRevenueACF: { type: String, required: true, immutable: true },

    /** Fixed at calculation so a retry reproduces identical batches. */
    batchIndex: { type: Number, required: true, immutable: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

DAORevenueMemberEntrySchema.index(
  { chainId: 1, distributorAddress: 1, epochId: 1, userId: 1 },
  { unique: true },
);
// Deterministic batch retrieval, in the exact order the batch was composed.
DAORevenueMemberEntrySchema.index(
  { chainId: 1, distributorAddress: 1, epochId: 1, batchIndex: 1, externalEOA: 1 },
);
// A member's own revenue history.
DAORevenueMemberEntrySchema.index({ chainId: 1, userId: 1, epochId: -1 });

export type DAORevenueMemberEntryDocument = InferSchemaType<typeof DAORevenueMemberEntrySchema>;
export const DAORevenueMemberEntry = model("DAORevenueMemberEntry", DAORevenueMemberEntrySchema);
