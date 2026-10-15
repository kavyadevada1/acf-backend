import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One row per user per epoch: Team = Level + Rank + Global.
 *
 * EVERY user in the epoch's as-of referral graph gets a row, including users whose three
 * amounts are all zero. That makes Phase 3's read deterministically one row per user, and
 * makes "I earned nothing" distinguishable from "the epoch never considered me".
 *
 * Team rewards do NOT compound — only Phase 1 staking rewards do.
 */
const perLevel = new Schema(
  {
    level: { type: Number, required: true },
    rateE6: { type: String, required: true },
    baseACF: { type: String, required: true },
    amountACF: { type: String, required: true },
    sourceCount: { type: Number, required: true },
  },
  { _id: false },
);

const TeamRewardEntrySchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    epochId: { type: Number, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },

    levelRewardACF: { type: String, required: true, immutable: true },
    rankRewardACF: { type: String, required: true, immutable: true },
    globalRewardACF: { type: String, required: true, immutable: true },
    /** level + rank + global. Stored because it is what Phase 3 and the APIs read. */
    teamRewardACF: { type: String, required: true, immutable: true },

    levelAudit: {
      type: new Schema(
        {
                unlockedLevels: { type: Number, required: true },
          directCount: { type: Number, required: true },
          /** Directs registered at the snapshot. Absent on rows settled under an earlier rule. */
          registeredDirects: { type: Number, min: 0 },
          /** The count `unlockedLevels` was computed from under this epoch's rule. */
          qualifyingDirects: { type: Number, min: 0 },
          perLevel: { type: [perLevel], default: [] },
        },
        { _id: false },
      ),
      required: true,
      immutable: true,
    },

    rankAudit: {
      type: new Schema(
        {
                leaderRank: { type: Number, required: true },
          leaderRateE6: { type: String, required: true },
          highestDownlineRank: { type: Number, required: true },
          highestDownlineRateE6: { type: String, required: true },
          differentialRateE6: { type: String, required: true },
          teamRewardBaseACF: { type: String, required: true },
          grossACF: { type: String, required: true },
          epochCapUSD6: { type: String, required: true },
          capped: { type: Boolean, required: true },
        },
        { _id: false },
      ),
      required: true,
      immutable: true,
    },

    globalAudit: {
      type: new Schema(
        {
                rankNumber: { type: Number, required: true },
          selfStakeACF: { type: String, required: true },
          selfStakeUSD6: { type: String, required: true },
          l1StakeACF: { type: String, required: true },
          l1StakeUSD6: { type: String, required: true },
          networkContributionACF: { type: String, required: true },
          networkContributionUSD6: { type: String, required: true },
          priceE18: { type: String, required: true },
        },
        { _id: false },
      ),
      required: true,
      immutable: true,
    },
  },
  { timestamps: true, versionKey: false, strict: true },
);

TeamRewardEntrySchema.index(
  { chainId: 1, stakingContractAddress: 1, epochId: 1, userId: 1 },
  { unique: true },
);
TeamRewardEntrySchema.index({ userId: 1, epochId: -1 });

export type TeamRewardEntryDocument = InferSchemaType<typeof TeamRewardEntrySchema>;
export const TeamRewardEntry = model("TeamRewardEntry", TeamRewardEntrySchema);
