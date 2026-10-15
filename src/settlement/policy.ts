import { encodeAbiParameters, getAddress, keccak256 } from "viem";

/**
 * Settlement policy: the leaf format, the invariants, and nothing else.
 *
 * Pure and dependency-free. Every rule here mirrors the DEPLOYED ACFWithdrawal contract, which
 * is the only authority on what a claimable leaf looks like.
 */

/**
 * The statuses a settlement checkpoint moves through. FINALIZED means the root is live.
 *
 * AUTHORIZED sits between CALCULATED and funding: ACFWithdrawal holds the immutable commitment to
 * this checkpoint's root, total and funding amount, and nothing can be funded or finalized before
 * it exists.
 */
export type SettlementStatus =
  | "CALCULATING" | "CALCULATED" | "AUTHORIZED" | "FUNDING_SUBMITTED" | "FUNDED"
  | "FINALIZE_SUBMITTED" | "FINALIZED" | "FAILED";

/** Statuses that mean an operator still has work to do before another checkpoint may be built. */
export const AWAITING_OPERATOR: readonly SettlementStatus[] = [
  "CALCULATED", "AUTHORIZED", "FUNDING_SUBMITTED", "FUNDED", "FINALIZE_SUBMITTED",
];

/** The StandardMerkleTree value types ACFWithdrawal.claim hashes. */
export const LEAF_TYPES = ["address", "uint256", "uint256"] as const;

/**
 * The root a Withdrawal reports before its first finalization: 32 zero bytes.
 *
 * `finalizeEpoch` rejects a zero root, so this value can only ever mean "nothing published yet".
 * That is what makes it a safe cumulative starting point for a fresh deployment.
 */
export const ZERO_ROOT = `0x${"0".repeat(64)}`;

export interface SettlementLeaf {
  externalEOA: string;
  cumulativeSelfACF: bigint;
  cumulativeTeamACF: bigint;
}

/**
 * The leaf hash, byte-identical to the contract:
 *
 *   keccak256(bytes.concat(keccak256(abi.encode(msg.sender, cumulativeSelf, cumulativeTeam))))
 *
 * Double-hashed OpenZeppelin StandardMerkleTree encoding — `abi.encode`, not packed. The
 * address is checksummed before encoding; viem pads it identically either way, but
 * normalizing here keeps the stored lowercase form and the encoded form from ever diverging.
 */
export function leafHash(leaf: SettlementLeaf): string {
  return keccak256(keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
    [getAddress(leaf.externalEOA), leaf.cumulativeSelfACF, leaf.cumulativeTeamACF],
  )));
}

/** Canonical leaf ordering: lowercase address, ascending. Sorted pairs make the root
 *  order-independent anyway, which is why comparing two independently sorted builds is a
 *  genuine cross-check rather than a tautology. */
export function canonicalOrder(leaves: SettlementLeaf[]): SettlementLeaf[] {
  return [...leaves].sort((a, b) => {
    const x = a.externalEOA.toLowerCase();
    const y = b.externalEOA.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

export const combined = (leaf: SettlementLeaf): bigint =>
  leaf.cumulativeSelfACF + leaf.cumulativeTeamACF;

/** Σ over leaves of (self + team). The published total is derived FROM the leaves. */
export const publishedTotal = (leaves: SettlementLeaf[]): bigint =>
  leaves.reduce((sum, l) => sum + combined(l), 0n);

export class SettlementInvariantError extends Error {
  readonly code = "SETTLEMENT_INVARIANT";
  constructor(message: string) {
    super(message);
    this.name = "SettlementInvariantError";
  }
}

/** Throws unless the condition holds. Every call site states the financial reason. */
export function assertInvariant(condition: boolean, message: string): void {
  if (!condition) throw new SettlementInvariantError(message);
}

/**
 * A deterministic canonical JSON encoding for the operator manifest hash.
 *
 * Keys sorted, integers as decimal strings, no whitespace — so the hash depends on the values
 * alone and not on formatting or key order. The executor recomputes this before signing.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (typeof value === "number") {
    assertInvariant(Number.isInteger(value), `Manifest holds a non-integer number: ${value}`);
    return `"${value}"`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const manifestHash = (manifest: unknown): string =>
  keccak256(Buffer.from(canonicalJson(manifest), "utf8") as unknown as `0x${string}`);
