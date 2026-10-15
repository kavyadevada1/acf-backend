import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One confirmed RewardClaimed event, for audit only.
 *
 * Append-only and OPTIONAL: compound-reset correctness comes from UserClaimState, which is
 * derived from alreadyClaimed(user). A user may claim directly against Withdrawal and never
 * tell the backend; the only thing missing then is this row's metadata — the transaction hash,
 * the USDT fee, the fee zone and the price at execution time.
 */
const RewardClaimSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    withdrawalAddress: { type: String, required: true, immutable: true, lowercase: true },
    txHash: { type: String, required: true, immutable: true, lowercase: true },
    logIndex: { type: Number, required: true, immutable: true },

    userId: { type: String, required: true, immutable: true },
    externalEOA: { type: String, required: true, immutable: true, lowercase: true },
    /** Resolved from the checkpoint that was live at the claim's block, not the current root. */
    checkpointId: { type: Number, required: true, immutable: true },

    claimedACF: { type: String, required: true, immutable: true },
    cumulativeSelfACF: { type: String, required: true, immutable: true },
    cumulativeTeamACF: { type: String, required: true, immutable: true },

    /** The fee is charged in USDT at execution time and never reduces the ACF entitlement. */
    usdtFee: { type: String, required: true, immutable: true },
    claimFeePercentage: { type: String, required: true, immutable: true },
    priceE18: { type: String, required: true, immutable: true },

    blockNumber: { type: Number, required: true, immutable: true },
    blockTimestamp: { type: Number, required: true, immutable: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

RewardClaimSchema.index(
  { chainId: 1, withdrawalAddress: 1, txHash: 1, logIndex: 1 },
  { unique: true },
);
RewardClaimSchema.index({ chainId: 1, withdrawalAddress: 1, userId: 1, blockNumber: -1 });

export type RewardClaimDocument = InferSchemaType<typeof RewardClaimSchema>;
export const RewardClaim = model("RewardClaim", RewardClaimSchema);
