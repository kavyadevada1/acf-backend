import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One confirmed SwapExecuted log.
 *
 * Amounts are stored as DECIMAL STRINGS in base units, never as Numbers: an 18-decimal ACF
 * amount is ~9.1e19, far beyond Number.MAX_SAFE_INTEGER (~9.0e15), so a numeric field would
 * silently corrupt the value — and these feed reward calculations later.
 */
const SwapSchema = new Schema(
  {
    /**
     * chainId:txHash:logIndex — globally unique for a log, and the SAME key the blockchain
     * indexer will use, so it can later upsert into this collection without duplicates.
     */
    eventId: { type: String, required: true, unique: true, immutable: true },

    userId: { type: String, required: true, immutable: true },
    externalEOA: { type: String, required: true, immutable: true, lowercase: true },

    direction: { type: String, required: true, enum: ["BUY", "SELL"], immutable: true },

    acfAmount: { type: String, required: true, immutable: true },
    grossUSDT: { type: String, required: true, immutable: true },
    sellFeeUSDT: { type: String, required: true, immutable: true },
    /** gross − fee. BUY always equals gross, because BUY carries no protocol fee. */
    netUSDT: { type: String, required: true, immutable: true },

    blockNumber: { type: Number, required: true, immutable: true },
    txHash: { type: String, required: true, immutable: true, lowercase: true },
    logIndex: { type: Number, required: true, immutable: true },
    blockTimestamp: { type: Date, required: true, immutable: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

SwapSchema.index({ userId: 1, blockNumber: -1 });
SwapSchema.index({ externalEOA: 1, blockNumber: -1 });

export type SwapDocument = InferSchemaType<typeof SwapSchema>;
export const Swap = model("Swap", SwapSchema);
