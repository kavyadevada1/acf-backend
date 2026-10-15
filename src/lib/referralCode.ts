import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — avoids transcription errors
const BODY_LENGTH = 8;
export const REFERRAL_CODE_PATTERN = /^ACF-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

/**
 * Unguessable per-user referral code. 32^8 ≈ 1.1e12 values, so collisions are rare, but
 * `referralCode` carries a unique index and the caller retries on a duplicate key.
 */
export function generateReferralCode(): string {
  const bytes = randomBytes(BODY_LENGTH);
  let body = "";
  for (let i = 0; i < BODY_LENGTH; i++) {
    body += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return `ACF-${body}`;
}
