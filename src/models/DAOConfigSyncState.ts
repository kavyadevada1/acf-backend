import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * How far the DAO configuration log has been scanned.
 *
 * Separate from DAOConfigHistory because that collection only grows when an EVENT is found, and
 * configuration events are rare — two in the contract's whole life so far. Resuming from the
 * newest event row therefore re-scans the entire history on every run, which at a 10-block log
 * window costs one request per ten blocks of chain time and grows without bound.
 *
 * This records the last block actually examined, so a run only looks at what is new.
 */
const DAOConfigSyncStateSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    daoContractAddress: { type: String, required: true, immutable: true, lowercase: true },

    /** Highest block whose logs have been read. Advances even when no event was found. */
    lastScannedBlock: { type: Number, required: true },
    lastScannedAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

DAOConfigSyncStateSchema.index(
  { chainId: 1, daoContractAddress: 1 },
  { unique: true },
);

export type DAOConfigSyncStateDocument = InferSchemaType<typeof DAOConfigSyncStateSchema>;
export const DAOConfigSyncState = model("DAOConfigSyncState", DAOConfigSyncStateSchema);
