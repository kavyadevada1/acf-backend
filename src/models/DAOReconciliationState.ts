import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Sequential-discovery progress for DAO contributions, one document per USER per deployment.
 *
 * Its ONLY job is to remember which contribution IDs have already been checked FOR THIS USER,
 * so a reconciliation pass fetches just the new ones instead of re-reading every id on every
 * request.
 *
 * Scoped per user, not per deployment, because a pass only persists rows belonging to the
 * caller. A single global cursor would let one user's read advance past another user's
 * contribution — read but never stored — leaving it undiscoverable forever.
 *
 * Explicitly NOT an activity source of truth: whether a contribution is still active is always
 * re-read from Staking.
 */
const DAOReconciliationStateSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    daoContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    /** The user's own address, which this cursor belongs to. */
    externalEOA: { type: String, required: true, immutable: true, lowercase: true },

    /** Next contribution id never yet fetched. Contribution ids start at 1. Lossless string. */
    nextContributionIdProcessed: { type: String, required: true, default: "1" },

    lastReconciledAt: { type: Date, required: false },
    lastReconciledBlock: { type: String, required: false },
  },
  { timestamps: true, versionKey: false, strict: true },
);

DAOReconciliationStateSchema.index(
  { chainId: 1, daoContractAddress: 1, externalEOA: 1 },
  { unique: true },
);

export type DAOReconciliationStateDocument = InferSchemaType<typeof DAOReconciliationStateSchema>;
export const DAOReconciliationState = model("DAOReconciliationState", DAOReconciliationStateSchema);
