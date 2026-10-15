import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One pending sign-in challenge per address. Strictly single-use: the challenge is consumed
 * by an atomic delete AFTER the signature verifies (see auth/service.ts), so an invalid
 * signature does not burn a legitimate user's challenge, while two concurrent valid requests
 * cannot both succeed.
 */
const AuthChallengeSchema = new Schema(
  {
    externalEOA: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    nonce: { type: String, required: true },
    message: { type: String, required: true },
    // TTL: MongoDB removes expired challenges on its own.
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { versionKey: false },
);

export type AuthChallengeDocument = InferSchemaType<typeof AuthChallengeSchema>;
export const AuthChallenge = model("AuthChallenge", AuthChallengeSchema);
