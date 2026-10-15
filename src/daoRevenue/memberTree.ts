import { concatHex, encodeAbiParameters, getAddress, keccak256, type Hex } from "viem";
import { assertInvariant } from "./policy.js";

/**
 * The Merkle commitment over an epoch's authorized member allocations.
 *
 * WHY THIS EXISTS
 * ---------------
 * `distributeBatch` used to take member addresses and amounts on the executor's word. A stolen
 * executor key could therefore call the distributor directly — from a block explorer, with no
 * backend involved — and pay an attacker the whole epoch funding. The root built here is
 * committed on chain by a SEPARATE authorizing key, and every transfer must then carry a proof
 * against it, so the executor can relay only what was already authorized.
 *
 * LEAF SHAPE
 * ----------
 *   keccak256(keccak256(abi.encode(epochId, member, amount)))
 *
 * Double-hashed `abi.encode`, matching the settlement tree's convention so one Merkle discipline
 * covers the whole protocol, with sorted-pair internal nodes to match `MerkleProof.verifyCalldata`.
 *
 * `epochId` is INSIDE the leaf. That is what makes a proof worthless against any other epoch: a
 * member authorized for 10 ACF in epoch 41_010 cannot have that proof replayed into 41_011, where
 * a different amount — or no allocation at all — was authorized.
 *
 * Addresses are checksummed before encoding and the leaf set is sorted, so the same allocations
 * always produce the same root regardless of the order they were loaded in.
 */

export interface MemberAllocation {
  externalEOA: string;
  amountACF: bigint;
}

export interface MemberCommitment {
  root: Hex;
  /** Leaf count after padding; equal to `allocations.length` when that is a power of two. */
  leafCount: number;
  proofFor(externalEOA: string, amountACF: bigint): Hex[];
}

export function memberLeaf(epochId: number, externalEOA: string, amountACF: bigint): Hex {
  return keccak256(keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
    [BigInt(epochId), getAddress(externalEOA), amountACF],
  )));
}

const pair = (a: Hex, b: Hex): Hex => keccak256(concatHex([a, b].sort() as [Hex, Hex]));

/**
 * Builds the commitment for one epoch's allocations.
 *
 * Padding duplicates the last leaf to reach a power of two. A duplicate leaf is harmless here
 * because it is the same (epochId, member, amount) triple, and `paid[epochId][member]` on chain
 * already allows each member exactly one transfer per epoch — so a padded duplicate cannot
 * authorize a second payment.
 */
export function buildMemberCommitment(
  epochId: number,
  allocations: readonly MemberAllocation[],
): MemberCommitment {
  assertInvariant(allocations.length > 0, "A member commitment needs at least one allocation.");
  assertInvariant(
    allocations.every((a) => a.amountACF > 0n),
    "Every authorized member allocation must be positive; a zero amount is unpayable.",
  );
  const unique = new Set(allocations.map((a) => getAddress(a.externalEOA)));
  assertInvariant(
    unique.size === allocations.length,
    "Two allocations share an address; only one could ever be paid.",
  );

  // Sorted BEFORE padding, which is what makes the root a function of the SET alone.
  //
  // Padding duplicates the last leaf to reach a power of two; if that happened before sorting,
  // the duplicated leaf would depend on the order the allocations were loaded in and the same
  // epoch could produce two different roots. The authorization is immutable once accepted, so a
  // rerun that produced a different root could never be authorized against the one on chain.
  const sorted = allocations
    .map((a) => memberLeaf(epochId, a.externalEOA, a.amountACF))
    .sort();
  while (sorted.length > 1 && (sorted.length & (sorted.length - 1)) !== 0) {
    sorted.push(sorted.at(-1)!);
  }
  const levels: Hex[][] = [sorted];
  while (levels.at(-1)!.length > 1) {
    const level = levels.at(-1)!;
    levels.push(Array.from(
      { length: level.length / 2 }, (_, i) => pair(level[i * 2]!, level[i * 2 + 1]!),
    ));
  }

  return {
    root: levels.at(-1)![0]!,
    leafCount: sorted.length,
    proofFor(externalEOA: string, amountACF: bigint): Hex[] {
      const leaf = memberLeaf(epochId, externalEOA, amountACF);
      let position = sorted.indexOf(leaf);
      assertInvariant(
        position >= 0,
        `No authorized allocation for ${externalEOA} at ${amountACF} in epoch ${epochId}; ` +
          "refusing to produce a proof the contract would reject.",
      );
      const proof: Hex[] = [];
      for (const level of levels.slice(0, -1)) {
        proof.push(level[position ^ 1]!);
        position >>= 1;
      }
      return proof;
    },
  };
}
