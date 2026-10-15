import { Schema, model, type InferSchemaType } from "mongoose";

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/; // lowercase only — see lib/address.ts

const UserSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, immutable: true },

    /**
     * The user's own wallet, and the single identity the protocol knows them by: authentication,
     * referral ownership, every position, every reward leaf and every payout. The application
     * creates no wallet on their behalf, so there is no second address to reconcile against.
     */
    externalEOA: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      lowercase: true,
      trim: true,
      match: ADDRESS_PATTERN,
    },

    referralCode: { type: String, required: true, unique: true, immutable: true },

    /**
     * null means the user registered without a referral code — a valid root of the referral
     * forest, not an incomplete record. `immutable` plus `$setOnInsert` at the only write site
     * are two independent guards: changing this would retroactively rewrite who earned
     * Level and Rank rewards.
     */
    referredByUserId: { type: String, default: null, immutable: true },

    /**
     * A granted MINIMUM rank, honoured ONLY for the logical referral ROOT.
     *
     * Rank is otherwise recomputed from stake and directs every epoch and is never stored; this
     * is a grant, not a cached rank. The epoch pass applies it solely to `graph.rootUserId`, so
     * setting it on any other account has no effect on any payout — the guard is there precisely
     * so a stray write cannot buy a rank.
     *
     * 0 means no grant. Mutable by design: the grant is a business decision that may change,
     * and every epoch records whether it was applied on that epoch's own rank snapshot.
     */
    rankFloor: { type: Number, default: 0, min: 0 },
  },
  // `timestamps` gives createdAt on insert only — mongoose never rewrites it on update, and the
  // sole creation site (auth/service.ts) uses $setOnInsert. Phase 2 reads it as the registration instant that
  // decides direct qualification, so its stability is a financial property, not a convenience.
  { timestamps: true, versionKey: false, strict: true },
);

UserSchema.index({ referredByUserId: 1 }); // direct referrals

export type UserDocument = InferSchemaType<typeof UserSchema>;
export const User = model("User", UserSchema);
