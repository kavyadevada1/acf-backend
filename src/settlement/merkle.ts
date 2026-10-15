import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress } from "viem";
import {
  assertInvariant, canonicalOrder, LEAF_TYPES, leafHash, publishedTotal,
  type SettlementLeaf,
} from "./policy.js";

/**
 * Merkle construction for settlement, using OpenZeppelin's StandardMerkleTree.
 *
 * Deliberately not hand-rolled: the deployed contract verifies with
 * MerkleProof.verifyCalldata over double-hashed abi.encode leaves and SORTED-PAIR (commutative)
 * internal hashing. StandardMerkleTree is that exact construction, and re-implementing it would
 * put a byte-for-byte compatibility burden on us for no benefit.
 */

export interface BuiltTree {
  root: string;
  leafCount: number;
  publishedCumulativeTotalACF: bigint;
  proofFor(externalEOA: string): string[];
}

type Row = [string, bigint, bigint];

const toRows = (leaves: SettlementLeaf[]): Row[] =>
  leaves.map((l) => [getAddress(l.externalEOA), l.cumulativeSelfACF, l.cumulativeTeamACF]);

/**
 * Builds the tree and PROVES the root is reproducible before anyone can rely on it.
 *
 * The tree is built twice from independently ordered input. Sorted-pair hashing makes the root
 * order-independent, so a disagreement means the leaf set itself differs between the two
 * passes — a real defect, and the kind that would otherwise surface only as an unclaimable
 * proof after the root was already published to a contract that keeps no history.
 */
export function buildSettlementTree(leaves: SettlementLeaf[]): BuiltTree {
  assertInvariant(leaves.length > 0, "Refusing to build a Merkle tree with no leaves.");

  const seen = new Set<string>();
  for (const l of leaves) {
    const key = l.externalEOA.toLowerCase();
    assertInvariant(!seen.has(key), `Duplicate address ${key} in one checkpoint's leaf set.`);
    seen.add(key);
    assertInvariant(
      l.cumulativeSelfACF >= 0n && l.cumulativeTeamACF >= 0n,
      `Negative cumulative entitlement for ${key}.`,
    );
  }

  const canonical = canonicalOrder(leaves);
  const tree = StandardMerkleTree.of(toRows(canonical), [...LEAF_TYPES]);

  // Independent second pass: reversed input, re-sorted by the same canonical rule.
  const mirror = StandardMerkleTree.of(
    toRows(canonicalOrder([...leaves].reverse())), [...LEAF_TYPES],
  );
  assertInvariant(
    tree.root === mirror.root,
    `Merkle root is not reproducible: ${tree.root} vs ${mirror.root}.`,
  );

  // The library's own leaf encoding must agree with the contract-mirroring one in policy.ts.
  for (const [index, row] of [...tree.entries()]) {
    const expected = leafHash({
      externalEOA: row[0] as string,
      cumulativeSelfACF: row[1] as bigint,
      cumulativeTeamACF: row[2] as bigint,
    });
    assertInvariant(
      tree.leafHash(row) === expected,
      `Leaf ${index} encoding diverges from the contract format.`,
    );
  }

  const byWallet = new Map<string, number>();
  for (const [index, row] of [...tree.entries()]) {
    byWallet.set((row[0] as string).toLowerCase(), index);
  }

  return {
    root: tree.root.toLowerCase(),
    leafCount: canonical.length,
    publishedCumulativeTotalACF: publishedTotal(canonical),
    proofFor(externalEOA) {
      const index = byWallet.get(externalEOA.toLowerCase());
      assertInvariant(
        index !== undefined,
        `Address ${externalEOA} has no leaf in this checkpoint.`,
      );
      return tree.getProof(index!);
    },
  };
}
