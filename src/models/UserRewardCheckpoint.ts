import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One Merkle leaf: a user's cumulative entitlement as published by one checkpoint.
 *
 * Every field is immutable. These rows ARE the tree — a proof is rebuilt from them on demand
 * and never stored, because the Withdrawal contract keeps only the latest root and the next
 * finalization invalidates every proof issued against the previous one.
 *
 * Identity is the user's own address, because Withdrawal.claim hashes msg.sender and the user
 * signs the claim themselves. Authentication identity and claim identity are the same address,
 * so there is no way to build a leaf nobody can claim.
 */
const UserRewardCheckpointSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    withdrawalAddress: { type: String, required: true, immutable: true, lowercase: true },
    checkpointId: { type: Number, required: true, immutable: true },

    userId: { type: String, required: true, immutable: true },
    externalEOA: { type: String, required: true, immutable: true, lowercase: true },

    /** Earned inside this checkpoint's reward-epoch range. */
    newSelfACF: { type: String, required: true, immutable: true },
    newTeamACF: { type: String, required: true, immutable: true },

    /**
     * Entitlement withheld from an earlier checkpoint and released by this one. Structurally zero
     * now that identity exists from registration: there is no period during which a user can earn
     * without a claimable address. Kept as its own field so that a non-zero value is visible
     * rather than hidden inside a sum.
     */
    deferredReleasedSelfACF: { type: String, required: true, immutable: true },
    deferredReleasedTeamACF: { type: String, required: true, immutable: true },

    cumulativeSelfACF: { type: String, required: true, immutable: true },
    cumulativeTeamACF: { type: String, required: true, immutable: true },
    /** self + team. The value the contract compares against alreadyClaimed. */
    combinedCumulativeACF: { type: String, required: true, immutable: true },

    leafHash: { type: String, required: true, immutable: true, lowercase: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

UserRewardCheckpointSchema.index(
  { chainId: 1, withdrawalAddress: 1, checkpointId: 1, userId: 1 },
  { unique: true },
);
// One leaf per user per checkpoint, enforced by the database rather than only in code.
UserRewardCheckpointSchema.index(
  { chainId: 1, withdrawalAddress: 1, checkpointId: 1, externalEOA: 1 },
  { unique: true },
);
UserRewardCheckpointSchema.index({ chainId: 1, withdrawalAddress: 1, userId: 1, checkpointId: -1 });
// Claim reconciliation matches alreadyClaimed against this exact combined value.
UserRewardCheckpointSchema.index(
  { chainId: 1, withdrawalAddress: 1, externalEOA: 1, combinedCumulativeACF: 1 },
);

export type UserRewardCheckpointDocument = InferSchemaType<typeof UserRewardCheckpointSchema>;
export const UserRewardCheckpoint = model("UserRewardCheckpoint", UserRewardCheckpointSchema);
