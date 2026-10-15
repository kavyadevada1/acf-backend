import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimFee, ClaimFeeError, feeScaleFor, PERCENTAGE_DENOMINATOR, percentageLabel } from "./fee.ts";

const E18 = 10n ** 18n;
const USD = 1_000_000n;
/** ACF 18 decimals, USDT 6 — the live Amoy pair. */
const LIVE = feeScaleFor(18, 6);

/** The naive formula, used only to prove the ceiling actually differs from it. */
const naiveFloor = (a: bigint, p: bigint, f: bigint, s: bigint) => (a * p * f) / s;

describe("fee scale derivation", () => {
  it("1. ACF 18 / USDT 6 gives exponent 36, dividing", () => {
    assert.equal(LIVE.exponent, 36);
    assert.equal(LIVE.scale, 10n ** 36n);
    assert.equal(LIVE.multiply, false);
  });

  it("2. a negative exponent switches to multiplying", () => {
    // 18 + 24 - 50 = -8
    const s = feeScaleFor(18, 50);
    assert.equal(s.exponent, -8);
    assert.equal(s.multiply, true);
    assert.equal(s.scale, 10n ** 8n);
  });

  it("3. the contract's ±77 guard is reproduced", () => {
    assert.throws(() => feeScaleFor(100, 0), ClaimFeeError);
    assert.throws(() => feeScaleFor(0, 120), ClaimFeeError);
  });
});

describe("fee arithmetic mirrors _claimFee", () => {
  it("4. a round case matches the hand calculation", () => {
    // 1 ACF at $2, 15% -> $0.30
    assert.equal(claimFee(1n * E18, 2n * E18, 150_000n, LIVE), 300_000n);
  });

  it("5. every live fee band", () => {
    const amount = 10n * E18;
    const price = 2n * E18;                       // $20 of ACF
    assert.equal(claimFee(amount, price, 150_000n, LIVE), 3n * USD);    // 15% -> $3
    assert.equal(claimFee(amount, price, 200_000n, LIVE), 4n * USD);    // 20% -> $4
    assert.equal(claimFee(amount, price, 250_000n, LIVE), 5n * USD);    // 25% -> $5
    assert.equal(claimFee(amount, price, 300_000n, LIVE), 6n * USD);    // 30% -> $6
  });

  it("6. THE CEILING — the remainder term rounds UP, unlike the naive product", () => {
    // Chosen so amount*price is not a multiple of 1e36 and the remainder*percentage is not
    // a multiple either, which is exactly where floor and ceil diverge.
    const amount = 1n;                            // 1 wei of ACF
    const price = 2_759_074_552_778_437_640n;     // the live epoch price
    const fee = claimFee(amount, price, 150_000n, LIVE);
    const floored = naiveFloor(amount, price, 150_000n, LIVE.scale);
    assert.equal(floored, 0n, "the naive product floors to nothing");
    assert.equal(fee, 1n, "the contract charges one base unit instead");
    assert.ok(fee > floored, "a quote using the naive formula would under-approve");
  });

  it("7. the ceiling never exceeds the naive value by more than one unit", () => {
    const price = 2_759_074_552_778_437_640n;
    for (const amount of [1n, 7n, 12_345n, E18 - 1n, E18, 3n * E18 + 7n]) {
      const fee = claimFee(amount, price, 150_000n, LIVE);
      const floored = naiveFloor(amount, price, 150_000n, LIVE.scale);
      assert.ok(fee === floored || fee === floored + 1n, `amount ${amount}`);
    }
  });

  it("8. zero amount costs nothing", () => {
    assert.equal(claimFee(0n, 2n * E18, 150_000n, LIVE), 0n);
  });

  it("9. refuses what the contract would revert on", () => {
    assert.throws(() => claimFee(E18, 0n, 150_000n, LIVE), /InvalidPrice/);
    assert.throws(() => claimFee(E18, 2n * E18, 0n, LIVE), /InvalidClaimFee/);
    assert.throws(
      () => claimFee(E18, 2n * E18, PERCENTAGE_DENOMINATOR + 1n, LIVE), /InvalidClaimFee/,
    );
    assert.throws(() => claimFee(-1n, 2n * E18, 150_000n, LIVE), ClaimFeeError);
  });

  it("10. no precision is lost at realistic magnitudes", () => {
    // 16.584820 ACF — the live claimable amount — at the live price and band.
    const amount = 16_584_820_000_000_000_000n;
    const fee = claimFee(amount, 2_759_074_552_778_437_640n, 150_000n, LIVE);
    // 16.58482 * 2.75907455... * 0.15 = 6.86338... USD
    assert.ok(fee > 6_800_000n && fee < 6_900_000n, `fee was ${fee}`);
    assert.equal(typeof fee, "bigint");
  });

  it("11. the multiplying branch is a pure product", () => {
    const s = feeScaleFor(18, 50);
    assert.equal(claimFee(2n, 3n, 5n, s), 2n * 3n * 5n * s.scale);
  });
});

describe("percentage label", () => {
  it("12. renders the bands for display", () => {
    assert.equal(percentageLabel(150_000n), "15");
    assert.equal(percentageLabel(200_000n), "20");
    assert.equal(percentageLabel(250_000n), "25");
    assert.equal(percentageLabel(300_000n), "30");
    assert.equal(percentageLabel(155_000n), "15.50");
  });
});
