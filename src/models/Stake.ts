import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One confirmed StakeCreated position.
 *
 * The chain is authoritative; this is an indexed read model. It is NOT guaranteed-complete
 * chain history: a browser closed between confirmation and sync leaves a gap, which a later
 * indexer milestone will backfill into this same collection. Reward calculations must not
 * assume completeness until then.
 */
const StakeSchema = new Schema(
  {
    /** chainId:txHash:logIndex — unique per log, and the key a future indexer will upsert on. */
    eventId: { type: String, required: true, unique: true, immutable: true },

    chainId: { type: Number, required: true, immutable: true },
    /** Stake IDs restart per deployment, so identity is only unique together with this. */
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    stakeId: { type: String, required: true, immutable: true }, // uint256, lossless as a string

    userId: { type: String, required: true, immutable: true },
    externalEOA: { type: String, required: true, immutable: true, lowercase: true },

    poolId: { type: Number, required: true, immutable: true },
    /** Base units, 18 decimals. A Number would lose precision above ~9.0e15. */
    principalACF: { type: String, required: true, immutable: true },
    source: { type: String, required: true, enum: ["DIRECT", "BOND", "DAO"], immutable: true },

    /**
     * The pool's ROI when this position was created. HISTORICAL CONTEXT ONLY — never the
     * ongoing reward rate. Pool ROI changes, and the reward job snapshots the pool's current
     * rate at each epoch start instead.
     */
    poolDailyROIAtCreation: { type: String, required: true, immutable: true },

    stakeTimestamp: { type: Date, required: true, immutable: true },
    unlockTimestamp: { type: Date, required: true, immutable: true },

    /**
     * Mirrors the contract. A MATURED stake is still active and still earning — only
     * withdrawal ends it. Maturity must never be rendered as expired or completed.
     */
    active: { type: Boolean, required: true, default: true },

    /**
     * When the BACKEND NOTICED the withdrawal — not when it happened on chain.
     *
     * Reconciliation runs on a schedule, so this can lag the real event by hours. It is an
     * operational breadcrumb and must never be used as a financial timestamp. For that, use
     * withdrawnBlockTimestamp below.
     */
    withdrawnAt: { type: Date, default: null },
    withdrawTxHash: { type: String, default: null, lowercase: true },

    /**
     * The actual on-chain withdrawal boundary, recovered by binary search over historical
     * contract state and immutable once established.
     *
     * This is the financial timestamp: a position counts as active for an epoch when
     * withdrawnBlockTimestamp is null or strictly greater than that epoch's snapshotAt.
     * Null means either still active, or withdrawn before the recovery path existed and not
     * yet backfilled.
     */
    withdrawnBlockNumber: { type: Number, default: null },
    withdrawnBlockTimestamp: { type: Number, default: null },

    txHash: { type: String, required: true, immutable: true, lowercase: true },
    blockNumber: { type: Number, required: true, immutable: true },
    logIndex: { type: Number, required: true, immutable: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

// Identity is the triple, not stakeId alone: another chain or deployment reuses the same ids.
StakeSchema.index(
  { chainId: 1, stakingContractAddress: 1, stakeId: 1 },
  { unique: true },
);
StakeSchema.index({ userId: 1, stakeTimestamp: -1 });
StakeSchema.index({ externalEOA: 1, active: 1 });

export type StakeDocument = InferSchemaType<typeof StakeSchema>;
export const Stake = model("Stake", StakeSchema);
