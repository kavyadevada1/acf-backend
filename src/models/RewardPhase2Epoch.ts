import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Phase 2 (Team Reward) status for one twelve-hour epoch.
 *
 * Deliberately a SEPARATE record from Phase 1's RewardEpoch. Phase 1's status means "the
 * staking arithmetic finished"; conflating the two would let a Team Reward failure cast doubt
 * on an already-correct staking epoch, or vice versa. Phase 3 reads Phase 2 rows only when
 * this says CALCULATED.
 */
const RewardPhase2EpochSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    epochId: { type: Number, required: true, immutable: true },

    status: {
      type: String,
      required: true,
      enum: ["PENDING", "PROCESSING", "CALCULATED", "FAILED"],
      default: "PENDING",
    },
    leaseExpiresAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String, default: null },
    startedAt: { type: Date, default: null },
    calculatedAt: { type: Date, default: null },

    /** Copied from Phase 1 and never re-derived: one epoch, one boundary, one price. */
    snapshotAt: { type: Number, required: true },
    snapshotBlockNumber: { type: Number, default: null },
    priceE18: { type: String, required: true },

    /**
     * Which staking rewards this epoch let propagate into Level and Rank.
     *
     * REGULAR_ONLY for epochs before DAO_TEAM_PROPAGATION_START_EPOCH, ALL_SOURCES from it.
     * Not `required`: rows settled before the rule existed predate the field and are left
     * exactly as they were. Absent means "not recorded", and replay derives the rule from the
     * epoch id rather than from this field, so a missing value changes nothing.
     */
    teamPropagationRule: { type: String, enum: ["REGULAR_ONLY", "ALL_SOURCES"], immutable: true },

    /** Gross new principal in [windowStart, snapshotAt). The Global denominator. */
    networkContributionACF: { type: String, default: null },
    networkContributionUSD6: { type: String, default: null },

    graphNodes: { type: Number, default: null },
    usersProcessed: { type: Number, default: null },

    totalLevelACF: { type: String, default: "0" },
    totalRankACF: { type: String, default: "0" },
    totalGlobalACF: { type: String, default: "0" },
    totalTeamACF: { type: String, default: "0" },
  },
  { timestamps: true, versionKey: false, strict: true },
);

// One Phase 2 epoch per deployment. The primary duplicate-execution guard.
RewardPhase2EpochSchema.index(
  { chainId: 1, stakingContractAddress: 1, epochId: 1 },
  { unique: true },
);
RewardPhase2EpochSchema.index({ status: 1, epochId: 1 });

export type RewardPhase2EpochDocument = InferSchemaType<typeof RewardPhase2EpochSchema>;
export const RewardPhase2Epoch = model("RewardPhase2Epoch", RewardPhase2EpochSchema);
