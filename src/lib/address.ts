import { getAddress } from "viem";
import { HttpError } from "./errors.js";

/**
 * Canonical storage and lookup form for an external EOA: validated, then lowercased.
 *
 * Mongoose's `lowercase: true` normalises values on write but NOT query filters, so every
 * read must pass the filter through here too or the unique index is silently missed and
 * `0xAbC...` becomes a second user alongside `0xabc...`.
 */
export function normalizeEOA(input: unknown): string {
  if (typeof input !== "string") {
    throw new HttpError(400, "INVALID_ADDRESS", "externalEOA must be a string.");
  }
  try {
    return getAddress(input.trim()).toLowerCase(); // getAddress validates shape and checksum
  } catch {
    throw new HttpError(400, "INVALID_ADDRESS", "externalEOA is not a valid address.");
  }
}
