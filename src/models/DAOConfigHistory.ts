import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One ACFDAO revenue-configuration change, derived from its own event log.
 *
 * Append-only. The contract exposes only `getRevenueConfig()` and `revenueEnabled()`, which
 * return CURRENT state — useless for a historical epoch, because settling reward epoch 41010
 * against a threshold that was raised yesterday would pay the wrong people. Both events carry
 * their values in event DATA rather than as indexed topics, and `initialize()` emits both, so
 * the full history is recoverable from block zero of the contract with no gap.
 *
 * Every row is a complete snapshot of the configuration as of its own block, not a delta: a
 * `RevenueEnabledUpdated` row repeats the thresholds that were in force, so resolving state
 * as-of a block is one descending lookup rather than a replay.
 */
const DAOConfigHistorySchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    daoContractAddress: { type: String, required: true, immutable: true, lowercase: true },

    /** Where this row sits in chain order; the pair is the as-of sort key. */
    blockNumber: { type: Number, required: true, immutable: true },
    logIndex: { type: Number, required: true, immutable: true },
    blockTimestamp: { type: Number, required: true, immutable: true },
    txHash: { type: String, required: true, immutable: true, lowercase: true },

    /** Which event produced this row. INITIALIZE rows come from the constructor-time emits. */
    eventName: {
      type: String, required: true, immutable: true,
      enum: ["RevenueConfigUpdated", "RevenueEnabledUpdated", "MarketingFeeCollectorUpdated"],
    },

    /** USDT base units (6 decimals). A Number is safe here but strings keep one convention. */
    silverMinimumUSDT6: { type: String, required: true, immutable: true },
    goldMinimumUSDT6: { type: String, required: true, immutable: true },
    /** On ACFDAO.PERCENTAGE_DENOMINATOR = 1_000_000. 50_000 = 5%. */
    memberRevenueRateE6: { type: String, required: true, immutable: true },
    /**
     * The marketing allocation rate, on the same 1e6 denominator. 20_000 = 2%.
     *
     * A real payable obligation: the distributor pays this share of the epoch's SystemRevenue to
     * the collector below, funded by Treasury in the same epoch as the member pool.
     */
    marketingRateE6: { type: String, required: true, immutable: true },
    /**
     * The marketing recipient in force at this row, from MarketingFeeCollectorUpdated.
     *
     * Admin-mutable on ACFDAO, so it is recorded historically rather than read live: an epoch
     * calculated against one collector must not be paid to a different one later. The zero
     * address means no collector was known yet at this block — ACFDAO emits the rates before the
     * collector inside `initialize()` — and an epoch resolving to it refuses to calculate.
     */
    marketingCollector: { type: String, required: true, immutable: true, lowercase: true },
    revenueEnabled: { type: Boolean, required: true, immutable: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

// Identity: one row per log. Makes the backfill idempotent under retry.
DAOConfigHistorySchema.index(
  { chainId: 1, daoContractAddress: 1, blockNumber: 1, logIndex: 1 },
  { unique: true },
);
// The as-of query: newest row at or before a snapshot block.
DAOConfigHistorySchema.index(
  { chainId: 1, daoContractAddress: 1, blockNumber: -1, logIndex: -1 },
);

export type DAOConfigHistoryDocument = InferSchemaType<typeof DAOConfigHistorySchema>;
export const DAOConfigHistory = model("DAOConfigHistory", DAOConfigHistorySchema);
