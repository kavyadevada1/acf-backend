import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One twelve-hour reward window.
 *
 * An epoch settles the window that JUST COMPLETED: running at 12:00 UTC settles
 * [00:00, 12:00). `epochId` is derived arithmetically from the boundary, so a restart, a
 * catch-up run and a manual invocation all agree on which window they are processing.
 *
 * CALCULATED means the staking arithmetic finished for every stake. FINALIZED is reserved for
 * the later Merkle/on-chain settlement phase and is never set here — marking an epoch finalized
 * because the maths completed would claim a settlement that has not happened.
 */
const RewardEpochSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    /** snapshotAt / 43200. Deterministic, monotonic, derivable from any instant. */
    epochId: { type: Number, required: true, immutable: true },

    /** Unix seconds. The settled window is [windowStart, snapshotAt). */
    windowStart: { type: Number, required: true, immutable: true },
    snapshotAt: { type: Number, required: true, immutable: true },

    status: {
      type: String,
      required: true,
      enum: ["PENDING", "PROCESSING", "CALCULATED", "FAILED", "FINALIZED"],
      default: "PENDING",
    },

    /** Set while PROCESSING so a worker killed mid-epoch does not own it forever. */
    leaseExpiresAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String, default: null },

    /**
     * The block this epoch's chain state is read at: the highest block whose timestamp is
     * <= snapshotAt.
     *
     * Immutable financial audit data once set. Every reward-critical read for the epoch — stake
     * state, pool ROI, price — is pinned here, so a withdrawal, an admin ROI change or a price
     * move after the boundary cannot alter a settled epoch, and a retry days later reproduces
     * the same numbers. Resolved once; never re-resolved.
     */
    snapshotBlockNumber: { type: Number, default: null },
    snapshotBlockTimestamp: { type: Number, default: null },

    /**
     * The one price used for every USD conversion in this epoch. Phase 1 does no USD maths,
     * but a later phase cannot reconstruct the price this window was settled at.
     */
    priceE18: { type: String, default: null },
    priceBlockNumber: { type: Number, default: null },
    priceBlockTimestamp: { type: Number, default: null },

    /** Immutable per-pool rates for this epoch. DIRECT/BOND price against these, never creation-time. */
    poolROISnapshot: {
      type: [
        {
          _id: false,
          poolId: { type: Number, required: true },
          currentDailyRewardRate: { type: String, required: true },
          lockDuration: { type: Number, required: true },
          active: { type: Boolean, required: true },
        },
      ],
      default: [],
    },

    stakesProcessed: { type: Number, required: true, default: 0 },
    stakesRewarded: { type: Number, required: true, default: 0 },
    /** Base-unit strings: an 18-decimal total exceeds Number.MAX_SAFE_INTEGER. */
    totalRegularSelfACF: { type: String, required: true, default: "0" },
    totalDAOStakeACF: { type: String, required: true, default: "0" },

    startedAt: { type: Date, default: null },
    calculatedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, strict: true },
);

// One epoch per deployment. This is the primary duplicate-execution guard.
RewardEpochSchema.index(
  { chainId: 1, stakingContractAddress: 1, epochId: 1 },
  { unique: true },
);
RewardEpochSchema.index({ status: 1, epochId: 1 });

export type RewardEpochDocument = InferSchemaType<typeof RewardEpochSchema>;
export const RewardEpoch = model("RewardEpoch", RewardEpochSchema);
