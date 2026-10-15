import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { getAddress, keccak256, encodeAbiParameters } from "viem";
import { buildMemberCommitment, memberLeaf } from "./memberTree.ts";
import { DAORevenueInvariantError } from "./policy.ts";

/**
 * The member commitment, which is what stops a compromised executor redirecting the 5% pool.
 *
 * The root built here is committed on chain by a SEPARATE authorizing key, and every member
 * transfer must then carry a proof against it. So the properties that matter are: the leaf
 * encoding matches the contract byte-for-byte, the epoch is bound into it, and the root depends
 * on the SET of allocations rather than on anything a caller can vary at relay time.
 */

const E18 = 10n ** 18n;
const A = getAddress(`0x${"a".repeat(40)}`);
const B = getAddress(`0x${"b".repeat(40)}`);
const C = getAddress(`0x${"c".repeat(40)}`);

describe("the member leaf matches the contract", () => {
  it("1. encodes (epochId, member, amount), double-hashed, exactly as Solidity does", () => {
    // Computed independently here rather than by calling the helper, so this compares two
    // implementations instead of agreeing with one.
    const expected = keccak256(keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [41_010n, A, 10n * E18],
    )));
    assert.equal(memberLeaf(41_010, A, 10n * E18), expected);
  });

  it("2. the Solidity source hashes the same three fields in the same order", () => {
    // The contract's `memberLeaf` is the other half of this agreement. If either side changes
    // its encoding, every proof the backend produces stops verifying — so the shapes are pinned
    // against each other rather than trusted to stay aligned.
    const source = readFileSync(
      new URL(
        "../../../smart-contracts/contracts/dao/ACFDAORevenueDistributor.sol", import.meta.url,
      ),
      "utf8",
    );
    assert.match(
      source,
      /keccak256\(bytes\.concat\(keccak256\(abi\.encode\(epochId, member, amount\)\)\)\)/,
      "the contract must hash (epochId, member, amount) double-hashed, in that order",
    );
  });

  it("3. the epoch is bound into the leaf, so a leaf cannot be reused across epochs", () => {
    assert.notEqual(memberLeaf(41_010, A, 10n * E18), memberLeaf(41_011, A, 10n * E18));
    // And neither the member nor the amount can be varied without changing the leaf.
    assert.notEqual(memberLeaf(41_010, A, 10n * E18), memberLeaf(41_010, B, 10n * E18));
    assert.notEqual(memberLeaf(41_010, A, 10n * E18), memberLeaf(41_010, A, 10n * E18 + 1n));
  });

  it("4. a checksum difference in the input does not change the leaf", () => {
    // Addresses are normalised before encoding, so the same member always produces the same leaf
    // whichever casing the database happened to store.
    assert.equal(
      memberLeaf(41_010, A.toLowerCase(), 1n), memberLeaf(41_010, A.toUpperCase().replace("0X", "0x"), 1n),
    );
  });
});

describe("the member commitment", () => {
  it("5. one allocation is its own root, and its proof is empty", () => {
    const c = buildMemberCommitment(41_010, [{ externalEOA: A, amountACF: 10n * E18 }]);
    assert.equal(c.root, memberLeaf(41_010, A, 10n * E18));
    assert.deepEqual(c.proofFor(A, 10n * E18), []);
  });

  it("6. the root depends on the SET, not on load order", () => {
    const allocations = [
      { externalEOA: A, amountACF: 10n * E18 },
      { externalEOA: B, amountACF: 5n * E18 },
      { externalEOA: C, amountACF: 1n * E18 },
    ];
    const forward = buildMemberCommitment(41_010, allocations);
    const reversed = buildMemberCommitment(41_010, [...allocations].reverse());
    assert.equal(forward.root, reversed.root, "a rerun must reproduce the same commitment");
    // Which matters because the authorization is immutable: a second run that produced a
    // different root could not be authorized against the one already on chain.
  });

  it("7. every proof folds to the root under sorted-pair hashing", async () => {
    const { concatHex } = await import("viem");
    const pair = (x: `0x${string}`, y: `0x${string}`) =>
      keccak256(concatHex([x, y].sort() as [`0x${string}`, `0x${string}`]));
    const allocations = [
      { externalEOA: A, amountACF: 10n * E18 },
      { externalEOA: B, amountACF: 5n * E18 },
      { externalEOA: C, amountACF: 1n * E18 },
      { externalEOA: getAddress(`0x${"d".repeat(40)}`), amountACF: 2n * E18 },
    ];
    const c = buildMemberCommitment(41_010, allocations);
    for (const { externalEOA, amountACF } of allocations) {
      let node = memberLeaf(41_010, externalEOA, amountACF);
      for (const sibling of c.proofFor(externalEOA, amountACF)) {
        node = pair(node, sibling as `0x${string}`);
      }
      assert.equal(node, c.root, `${externalEOA} must prove against the root`);
    }
  });

  it("8. refuses an allocation set it could not authorize", () => {
    assert.throws(() => buildMemberCommitment(41_010, []), DAORevenueInvariantError);
    assert.throws(
      () => buildMemberCommitment(41_010, [{ externalEOA: A, amountACF: 0n }]),
      DAORevenueInvariantError,
    );
    // Two allocations for one address: only one could ever be paid, because the contract allows
    // each member exactly one transfer per epoch.
    assert.throws(
      () => buildMemberCommitment(41_010, [
        { externalEOA: A, amountACF: 1n }, { externalEOA: A.toLowerCase(), amountACF: 2n },
      ]),
      DAORevenueInvariantError,
    );
  });

  it("9. refuses to produce a proof for an allocation it does not contain", () => {
    const c = buildMemberCommitment(41_010, [{ externalEOA: A, amountACF: 10n * E18 }]);
    // Asking for a proof the contract would reject is a backend bug, not something to discover
    // from a reverted transaction after the gas was spent.
    assert.throws(() => c.proofFor(B, 10n * E18), DAORevenueInvariantError);
    assert.throws(() => c.proofFor(A, 11n * E18), DAORevenueInvariantError);
  });
});
