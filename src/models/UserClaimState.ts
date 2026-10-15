import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * A cache of Withdrawal.alreadyClaimed(user), and the checkpoint it resolves to.
 *
 * Deliberately MUTABLE, and deliberately not financial truth: the chain is. Every update is
 * derived from a contract read, never from a frontend-supplied amount or a submitted
 * transaction, so a user cannot talk the backend into retiring rewards they did not claim.
 *
 * This is the watermark compounding reads, which is what lets claim detection work without
 * event logs — the configured RPC caps eth_getLogs at a 10-block range, so a log-based
 * watermark would make financial correctness depend on infrastructure we do not control.
 */
const UserClaimStateSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    withdrawalAddress: { type: String, required: true, immutable: true, lowercase: true },
    userId: { type: String, required: true, immutable: true },

    externalEOA: { type: String, required: true, lowercase: true },

    /** Exactly what the contract reports. */
    alreadyClaimedACF: { type: String, required: true, default: "0" },
    /** The checkpoint whose combined cumulative equals alreadyClaimedACF. Null when nothing. */
    highestClaimedCheckpointId: { type: Number, default: null },

    lastReconciledBlock: { type: Number, default: null },
    lastReconciledAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, strict: true },
);

UserClaimStateSchema.index({ chainId: 1, withdrawalAddress: 1, userId: 1 }, { unique: true });
UserClaimStateSchema.index(
  { chainId: 1, withdrawalAddress: 1, externalEOA: 1 },
  { unique: true },
);

export type UserClaimStateDocument = InferSchemaType<typeof UserClaimStateSchema>;
export const UserClaimState = model("UserClaimState", UserClaimStateSchema);
