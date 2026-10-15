import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One confirmed BondPurchased event.
 *
 * The chain is authoritative; this is an indexed read model. Every monetary field is a
 * base-unit string: USDT has 6 decimals and ACF 18, and an 18-decimal amount exceeds
 * Number.MAX_SAFE_INTEGER.
 */
const BondPurchaseSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, immutable: true },

    chainId: { type: Number, required: true, immutable: true },
    bondContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    purchaseId: { type: String, required: true, immutable: true },

    userId: { type: String, required: true, immutable: true },
    externalEOA: { type: String, required: true, immutable: true, lowercase: true },

    offerId: { type: String, required: true, immutable: true },
    /** Small deliberate identifier; safe as a number. */
    poolId: { type: Number, required: true, immutable: true },

    usdtPaid: { type: String, required: true, immutable: true },
    discountUsed: { type: String, required: true, immutable: true },
    executionPriceE18: { type: String, required: true, immutable: true },
    acfStaked: { type: String, required: true, immutable: true },

    /**
     * Resolves into the Stake collection's {chainId, stakingContractAddress, stakeId}.
     * linkedStakeId alone is not unique — stake ids restart per deployment.
     */
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    linkedStakeId: { type: String, required: true, immutable: true },

    txHash: { type: String, required: true, immutable: true, lowercase: true },
    blockNumber: { type: Number, required: true, immutable: true },
    logIndex: { type: Number, required: true, immutable: true },
    blockTimestamp: { type: Date, required: true, immutable: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

// bondFaceValueUSD is deliberately NOT stored: it is reproducible from usdtPaid and
// discountUsed, and a rounded copy would drift from the values it was derived from.

BondPurchaseSchema.index(
  { chainId: 1, bondContractAddress: 1, purchaseId: 1 },
  { unique: true },
);
BondPurchaseSchema.index({ userId: 1, blockTimestamp: -1 });
BondPurchaseSchema.index({ linkedStakeId: 1 });

export type BondPurchaseDocument = InferSchemaType<typeof BondPurchaseSchema>;
export const BondPurchase = model("BondPurchase", BondPurchaseSchema);
