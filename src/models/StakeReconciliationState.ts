import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * High-water mark for canonical stake discovery, one document per staking deployment.
 *
 * Reward correctness must not depend on a browser having called /staking/sync. The contract's
 * own sequential ids are walked from this cursor, so a stake whose browser closed is still
 * found and still earns.
 *
 * Scoped by deployment: stake ids restart per contract, so mixing two would corrupt identity.
 */
const StakeReconciliationStateSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },

    /** Next stake id never yet read from chain. Stake ids start at 1. Lossless string. */
    nextStakeIdProcessed: { type: String, required: true, default: "1" },

    lastReconciledAt: { type: Date, default: null },
    lastDiscoveredCount: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, strict: true },
);

StakeReconciliationStateSchema.index(
  { chainId: 1, stakingContractAddress: 1 },
  { unique: true },
);

export type StakeReconciliationStateDocument = InferSchemaType<typeof StakeReconciliationStateSchema>;
export const StakeReconciliationState = model("StakeReconciliationState", StakeReconciliationStateSchema);
