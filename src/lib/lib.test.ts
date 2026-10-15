import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeEOA } from "./address.js";
import { HttpError } from "./errors.js";
import { REFERRAL_CODE_PATTERN, generateReferralCode } from "./referralCode.js";

const CHECKSUMMED = "0xd0b78357bF0C537eCb5B5cE7814B5A1689eE81A8";
const LOWERCASED = CHECKSUMMED.toLowerCase();

describe("normalizeEOA", () => {
  it("lowercases a checksummed address", () => {
    assert.equal(normalizeEOA(CHECKSUMMED), LOWERCASED);
  });

  it("is idempotent, so mixed case can never create a second user", () => {
    assert.equal(normalizeEOA(LOWERCASED), LOWERCASED);
    assert.equal(normalizeEOA(CHECKSUMMED.toUpperCase().replace("0X", "0x")), LOWERCASED);
  });

  it("trims surrounding whitespace", () => {
    assert.equal(normalizeEOA(`  ${CHECKSUMMED}  `), LOWERCASED);
  });

  it("rejects malformed input with INVALID_ADDRESS", () => {
    // The 32-hex-char value the frontend previously fabricated is not a valid address.
    for (const bad of ["0x7A3F48bCe91295D0182C0E51b72a91B2", "not-an-address", "0x", "", 42, null, undefined]) {
      assert.throws(
        () => normalizeEOA(bad),
        (error: unknown) => error instanceof HttpError && error.code === "INVALID_ADDRESS" && error.status === 400,
        `expected rejection for ${String(bad)}`,
      );
    }
  });
});

describe("generateReferralCode", () => {
  it("matches the documented format", () => {
    assert.match(generateReferralCode(), REFERRAL_CODE_PATTERN);
  });

  it("excludes visually ambiguous characters", () => {
    const body = generateReferralCode().slice(4);
    for (const char of ["I", "O", "0", "1"]) assert.ok(!body.includes(char));
  });

  it("produces 1000 distinct codes", () => {
    const codes = new Set(Array.from({ length: 1000 }, generateReferralCode));
    assert.equal(codes.size, 1000);
  });
});
