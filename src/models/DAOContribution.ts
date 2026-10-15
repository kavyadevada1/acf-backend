import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One confirmed DAOContributionCreated event.
 *
 * The chain is authoritative; this is an indexed read model. Every monetary field is a
 * base-unit string: USDT has 6 decimals and ACF 18, and an 18-decimal amount exceeds
 * Number.MAX_SAFE_INTEGER.
 *
 * Deliberately NOT stored:
 *  - membershipTier: derived per request from the sum of ACTIVE contributions against the
 *    contract's CURRENT thresholds. A stored copy would go stale the moment either changes.
 *  - an `active` flag: Staking is the authority. Activity is re-read from chain, never cached
 *    as business truth.
 */
const DAOContributionSchema = new Schema(
  {
    /**
     * Receipt-derived identity. NOT immutable: reconciliation discovers a contribution from
     * contract storage, where no receipt exists, and writes a synthetic id. A later /dao/sync
     * has the real receipt and upgrades it. The protocol identity below is what stays fixed.
     */
    eventId: { type: String, required: true, unique: true },

    chainId: { type: Number, required: true, immutable: true },
    daoContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    contributionId: { type: String, required: true, immutable: true },

    userId: { type: String, required: true, immutable: true },
    externalEOA: { type: String, required: true, immutable: true, lowercase: true },

    usdtContributed: { type: String, required: true, immutable: true },
    acfStaked: { type: String, required: true, immutable: true },
    /** Emitted only in the event; reconciliation stores "0" until a sync supplies it. */
    executionPriceE18: { type: String, required: true },

    /** The canonical DAO pool at the time of contribution; small deliberate id, safe as a number. */
    daoPoolId: { type: Number, required: true, immutable: true },

    /**
     * Resolves into the Stake collection's {chainId, stakingContractAddress, stakeId}.
     * stakeId alone is not unique — stake ids restart per deployment.
     */
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    stakeId: { type: String, required: true, immutable: true },

    // All four are receipt-derived, so reconciliation can only write placeholders. A sync
    // replaces them with the real values; they are deliberately not immutable for that reason.
    txHash: { type: String, required: true, lowercase: true },
    blockNumber: { type: Number, required: true },
    logIndex: { type: Number, required: true },
    blockTimestamp: { type: Date, required: true },

    /**
     * Cached chain activity, refreshed on every read. NOT business truth on its own: it exists
     * so a contribution already proven inactive can be skipped, since withdrawal is terminal in
     * ACFStaking (active goes true -> false and has no inverse).
     */
    lastKnownActive: { type: Boolean, required: true, default: true },
    lastActivityCheckAt: { type: Date, required: false },
  },
  { timestamps: true, versionKey: false, strict: true },
);

DAOContributionSchema.index(
  { chainId: 1, daoContractAddress: 1, contributionId: 1 },
  { unique: true },
);
DAOContributionSchema.index({ userId: 1, blockTimestamp: -1 });
DAOContributionSchema.index({ externalEOA: 1 });
DAOContributionSchema.index({ stakeId: 1 });

export type DAOContributionDocument = InferSchemaType<typeof DAOContributionSchema>;
export const DAOContribution = model("DAOContribution", DAOContributionSchema);
