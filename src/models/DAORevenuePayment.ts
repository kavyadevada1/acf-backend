import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One confirmed DAORevenuePaid event, reconciled from chain.
 *
 * Separate from DAORevenueMemberEntry on purpose: the obligation is immutable history, while
 * payment is discovered state. The chain is authoritative — `paid[epochId][user]` and the event
 * decide whether a member has been paid, never a local boolean, so a crash between a confirmed
 * transfer and this row costs nothing.
 */
const DAORevenuePaymentSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    distributorAddress: { type: String, required: true, immutable: true, lowercase: true },
    epochId: { type: Number, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },

    /** The address the event says received the ACF, which is also what was submitted. */
    externalEOA: { type: String, required: true, immutable: true, lowercase: true },

    expectedAmountACF: { type: String, required: true, immutable: true },
    amountPaidACF: { type: String, required: true, immutable: true },

    txHash: { type: String, required: true, immutable: true, lowercase: true },
    logIndex: { type: Number, required: true, immutable: true },
    blockNumber: { type: Number, required: true, immutable: true },
    blockTimestamp: { type: Number, required: true, immutable: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

DAORevenuePaymentSchema.index(
  { chainId: 1, distributorAddress: 1, epochId: 1, userId: 1 },
  { unique: true },
);
DAORevenuePaymentSchema.index(
  { chainId: 1, distributorAddress: 1, txHash: 1, logIndex: 1 },
  { unique: true },
);

export type DAORevenuePaymentDocument = InferSchemaType<typeof DAORevenuePaymentSchema>;
export const DAORevenuePayment = model("DAORevenuePayment", DAORevenuePaymentSchema);
