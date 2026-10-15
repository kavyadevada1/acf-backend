import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * The per-stake composition of published cumulative Self.
 *
 * The chain tells us only one combined number per user, which is not enough to know WHICH
 * staking rewards a claim covered — and compounding needs exactly that. Without these rows the
 * only available rule would be "a claim happened, so retire everything", which would destroy
 * rewards earned after the claimed checkpoint was built.
 *
 * Append-only, and each component is published EXACTLY ONCE: the unique key deliberately omits
 * checkpointId, so re-copying history into every later cumulative checkpoint is impossible.
 */
const CheckpointSelfComponentSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    withdrawalAddress: { type: String, required: true, immutable: true, lowercase: true },

    /** The checkpoint that first published this component. */
    checkpointId: { type: Number, required: true, immutable: true },

    userId: { type: String, required: true, immutable: true },
    externalEOA: { type: String, required: true, immutable: true, lowercase: true },

    stakeId: { type: String, required: true, immutable: true },
    source: { type: String, required: true, enum: ["DIRECT", "BOND", "DAO"], immutable: true },
    rewardEpochId: { type: Number, required: true, immutable: true },
    rewardACF: { type: String, required: true, immutable: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

// Each Phase 1 staking reward is represented once, by whichever checkpoint published it first.
CheckpointSelfComponentSchema.index(
  { chainId: 1, stakingContractAddress: 1, withdrawalAddress: 1, stakeId: 1, rewardEpochId: 1 },
  { unique: true },
);
// The compound-reset query.
CheckpointSelfComponentSchema.index(
  { chainId: 1, stakingContractAddress: 1, userId: 1, stakeId: 1, rewardEpochId: 1 },
);
CheckpointSelfComponentSchema.index({ chainId: 1, withdrawalAddress: 1, checkpointId: 1 });

export type CheckpointSelfComponentDocument =
  InferSchemaType<typeof CheckpointSelfComponentSchema>;
export const CheckpointSelfComponent =
  model("CheckpointSelfComponent", CheckpointSelfComponentSchema);
