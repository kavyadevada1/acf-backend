import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One user's rank and every input that produced it, for one epoch.
 *
 * Rank is recomputed from scratch each epoch and may FALL, so the inputs matter as much as the
 * answer: "why did I drop a rank?" is unanswerable from the rank alone. `previousRank` is
 * support metadata and is never an input to qualification.
 *
 * USD amounts are USDT base units (1e6), the same unit the rank cap uses, so one conversion
 * serves qualification, caps and audit.
 */
const UserRankSnapshotSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    epochId: { type: Number, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },

    /** 0 = unranked. Never implicitly promoted to Nova. */
    rank: { type: Number, required: true, immutable: true },
    rankName: { type: String, default: null, immutable: true },
    rateE6: { type: String, required: true, immutable: true },
    epochCapUSD6: { type: String, required: true, immutable: true },
    previousRank: { type: Number, default: null, immutable: true },

    /**
     * True when this rank was GRANTED by the ROOT rank floor rather than earned.
     *
     * Recorded per epoch so a settled row explains itself: the floor lives on a mutable user
     * document, and without this an auditor could not tell a granted rank from an earned one,
     * nor detect that the grant changed between a settlement and a replay.
     */
    rankFloorApplied: { type: Boolean, default: false, immutable: true },

    selfStakeACF: { type: String, required: true, immutable: true },
    selfStakeUSD6: { type: String, required: true, immutable: true },
    teamStakeACF: { type: String, required: true, immutable: true },
    teamStakeUSD6: { type: String, required: true, immutable: true },
    activeDirects: { type: Number, required: true, immutable: true },
    directCount: { type: Number, required: true, immutable: true },

    /**
     * Directs who had registered at this epoch's snapshot, with no wallet and no stake condition.
     *
     * Not `required`: rows settled under an earlier rule predate the field and are left exactly
     * as they were settled. Absent means "not recorded", never zero.
     */
    registeredDirects: { type: Number, min: 0, immutable: true },

    /**
     * Which count qualified this rank, stored so a historical row states its own semantics
     * instead of depending on today's configuration. ACTIVE_STAKE and ONBOARDED are retained for
     * rows settled under those rules; REGISTERED_EOA is what the current build writes.
     */
    directRule: {
      type: String,
      enum: ["ACTIVE_STAKE", "ONBOARDED", "REGISTERED_EOA"],
      immutable: true,
    },

    /**
     * What established registration. APPLICATION_TIMESTAMP: the user's own registration instant,
     * which is an application fact with no chain equivalent. BLOCK and TIMESTAMP are retained for
     * rows whose onboarding was decided against a chain block or boundary clock.
     */
    registrationBasis: {
      type: String,
      enum: ["APPLICATION_TIMESTAMP", "BLOCK", "TIMESTAMP"],
      immutable: true,
    },
    l1StakeACF: { type: String, required: true, immutable: true },
    maxDownlineRank: { type: Number, required: true, immutable: true },
    downlineQualifiers: { type: Number, required: true, immutable: true },
    priceE18: { type: String, required: true, immutable: true },
  },
  { timestamps: true, versionKey: false, strict: true },
);

UserRankSnapshotSchema.index(
  { chainId: 1, stakingContractAddress: 1, epochId: 1, userId: 1 },
  { unique: true },
);
UserRankSnapshotSchema.index({ userId: 1, epochId: -1 });
UserRankSnapshotSchema.index({ epochId: 1, rank: -1 });

export type UserRankSnapshotDocument = InferSchemaType<typeof UserRankSnapshotSchema>;
export const UserRankSnapshot = model("UserRankSnapshot", UserRankSnapshotSchema);
