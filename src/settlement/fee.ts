/**
 * The claim fee, reproducing ACFWithdrawal._claimFee exactly.
 *
 * The contract exposes no view helper for this, and `feeScale`/`multiplyFee` are private storage
 * with no getters, so the quote has to re-derive the arithmetic rather than read it. Everything
 * here mirrors the Solidity line for line, because a quote that is one base unit short makes the
 * user approve too little and the claim reverts.
 *
 *   int256 exponent = acfDecimals + 24 - usdtDecimals;
 *   multiplyFee = exponent < 0;
 *   feeScale    = 10 ** |exponent|;
 *
 *   if (multiplyFee) return amount * price * percentage * scale;
 *   q = Math.mulDiv(amount, price, scale);
 *   r = mulmod(amount, price, scale);
 *   return q * percentage + Math.mulDiv(r, percentage, scale, Math.Rounding.Ceil);
 *
 * The contract's own note explains why that identity is exact: for A*P = q*S + r,
 * ceil(A*P*F/S) = q*F + ceil(r*F/S). It is NOT floor(A*P*F/S) — the remainder term rounds UP, so
 * the fee can exceed the naive product by one base unit. Reproducing that is the whole point.
 *
 * Integer only. No Number, no parseFloat, no division before multiplication.
 */

/** Mirrors ACFWithdrawal.PERCENTAGE_DENOMINATOR. */
export const PERCENTAGE_DENOMINATOR = 1_000_000n;
/** Mirrors ACFWithdrawal.PRICE_SCALE. */
export const PRICE_SCALE = 10n ** 18n;

export class ClaimFeeError extends Error {
  readonly code = "CLAIM_FEE_UNSUPPORTED";
  constructor(message: string) {
    super(message);
    this.name = "ClaimFeeError";
  }
}

export interface FeeScale {
  /** |exponent|, as 10**|exponent|. */
  scale: bigint;
  /** True when the exponent is negative, which makes the fee a product rather than a quotient. */
  multiply: boolean;
  /** The signed exponent itself, kept for diagnostics. */
  exponent: number;
}

/**
 * Derives the contract's fee scaling from the two tokens' decimals.
 *
 * Read from chain rather than assumed: a redeployment against a different USDT would change the
 * exponent, and silently keeping 1e36 would misprice every quote.
 */
export function feeScaleFor(acfDecimals: number, usdtDecimals: number): FeeScale {
  if (!Number.isInteger(acfDecimals) || !Number.isInteger(usdtDecimals)) {
    throw new ClaimFeeError("Token decimals must be integers.");
  }
  const exponent = acfDecimals + 24 - usdtDecimals;
  // The contract refuses to initialize outside this range, so a quote outside it is impossible.
  if (exponent > 77 || exponent < -77) {
    throw new ClaimFeeError(`Unsupported decimals: exponent ${exponent} is outside ±77.`);
  }
  return {
    scale: 10n ** BigInt(Math.abs(exponent)),
    multiply: exponent < 0,
    exponent,
  };
}

/** ceil(a / b) for positive integers. */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/**
 * The exact USDT fee the contract would charge for `amountACF` at `priceE18` and `percentageE6`.
 *
 * Returns base units of USDT. Mirrors _claimFee including its ceiling on the remainder term.
 */
export function claimFee(
  amountACF: bigint,
  priceE18: bigint,
  percentageE6: bigint,
  scale: FeeScale,
): bigint {
  if (amountACF < 0n) throw new ClaimFeeError(`Amount cannot be negative, got ${amountACF}.`);
  // The contract reverts on both of these before reaching _claimFee, so a quote must too rather
  // than returning a number that could never be charged.
  if (priceE18 <= 0n) throw new ClaimFeeError("Swap price is zero; claim would revert InvalidPrice.");
  if (percentageE6 <= 0n || percentageE6 > PERCENTAGE_DENOMINATOR) {
    throw new ClaimFeeError(
      `Claim fee percentage ${percentageE6} is outside 1..${PERCENTAGE_DENOMINATOR}; ` +
        "claim would revert InvalidClaimFee.",
    );
  }
  if (amountACF === 0n) return 0n;

  if (scale.multiply) {
    return amountACF * priceE18 * percentageE6 * scale.scale;
  }
  const quotient = (amountACF * priceE18) / scale.scale;
  const remainder = (amountACF * priceE18) % scale.scale;
  return quotient * percentageE6 + ceilDiv(remainder * percentageE6, scale.scale);
}

/** The fee percentage as a display string, e.g. 150000 -> "15". Presentation only. */
export function percentageLabel(percentageE6: bigint): string {
  const whole = (percentageE6 * 100n) / PERCENTAGE_DENOMINATOR;
  const frac = (percentageE6 * 10_000n) / PERCENTAGE_DENOMINATOR % 100n;
  return frac === 0n ? whole.toString() : `${whole}.${String(frac).padStart(2, "0")}`;
}
