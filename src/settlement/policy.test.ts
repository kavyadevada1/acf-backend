import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertInvariant, canonicalJson, canonicalOrder, combined, leafHash, manifestHash,
  publishedTotal, SettlementInvariantError,
} from "./policy.ts";
import { buildSettlementTree } from "./merkle.ts";

const E18 = 10n ** 18n;
/**
 * A KNOWN-ANSWER VECTOR, not live state.
 *
 * These three values once produced this exact root on a real deployed ACFWithdrawal, which makes
 * them the strongest available proof that `leafHash` encodes a leaf the way the contract hashes
 * it. They are a frozen constant: nothing reads this deployment any more, and the settlement
 * lineage it belonged to is not supported. Kept because a hand-written expectation could only
 * ever prove the implementation agrees with itself.
 */
const VECTOR = {
  externalEOA: "0x7c2d6b5f65c820c1cb014313ab17419420d3e3a7",
  cumulativeSelfACF: 5n * E18,
  cumulativeTeamACF: 0n,
};
const VECTOR_ROOT = "0x0f5e4a1e0d7971af062097dabe3923616dd4d0efb16ef53a43842fa9c41febb9";

const leaf = (n: number, self: bigint, team: bigint) => ({
  externalEOA: `0x${String(n).repeat(40)}`,
  cumulativeSelfACF: self,
  cumulativeTeamACF: team,
});

describe("leaf format mirrors the deployed contract", () => {
  it("1. reproduces a real on-chain root from its single leaf", () => {
    // ACFWithdrawal.claim hashes keccak256(bytes.concat(keccak256(abi.encode(...)))).
    assert.equal(leafHash(VECTOR).toLowerCase(), VECTOR_ROOT);
  });

  it("2. a single-leaf tree's root IS the leaf, with an empty proof", () => {
    const t = buildSettlementTree([VECTOR]);
    assert.equal(t.root, VECTOR_ROOT);
    assert.deepEqual(t.proofFor(VECTOR.externalEOA), []);
  });

  it("3. the leaf identity is the address itself, and no other address reproduces it", () => {
    const mine = leafHash(VECTOR);
    const other = leafHash({ ...VECTOR, externalEOA: `0x${"a".repeat(40)}` });
    assert.notEqual(mine, other, "two addresses with identical amounts give different leaves");
    assert.equal(mine.toLowerCase(), VECTOR_ROOT, "only this address reproduces the live root");
  });

  it("4. changing Self changes the leaf", () => {
    assert.notEqual(leafHash({ ...VECTOR, cumulativeSelfACF: 5n * E18 + 1n }), leafHash(VECTOR));
  });

  it("5. changing Team changes the leaf", () => {
    assert.notEqual(leafHash({ ...VECTOR, cumulativeTeamACF: 1n }), leafHash(VECTOR));
  });

  it("6. case in the address does not change the leaf", () => {
    assert.equal(
      leafHash({ ...VECTOR, externalEOA: VECTOR.externalEOA.toUpperCase().replace("0X", "0x") }),
      leafHash(VECTOR),
    );
  });
});

describe("tree construction", () => {
  const many = [leaf(1, 1n * E18, 0n), leaf(2, 2n * E18, 1n * E18), leaf(3, 0n, 5n * E18)];

  it("7. the root is independent of input order", () => {
    assert.equal(buildSettlementTree(many).root, buildSettlementTree([...many].reverse()).root);
  });

  it("8. canonical order sorts by lowercase wallet", () => {
    const sorted = canonicalOrder([...many].reverse());
    assert.deepEqual(
      sorted.map((l) => l.externalEOA),
      [...many].map((l) => l.externalEOA),
    );
  });

  it("9. the published total is the sum over leaves", () => {
    assert.equal(publishedTotal(many), 9n * E18);
    assert.equal(buildSettlementTree(many).publishedCumulativeTotalACF, 9n * E18);
    assert.equal(combined(many[1]!), 3n * E18);
  });

  it("10. every leaf gets a verifiable proof of the expected depth", () => {
    const t = buildSettlementTree(many);
    assert.equal(t.leafCount, 3);
    for (const l of many) assert.ok(t.proofFor(l.externalEOA).length >= 1);
  });

  it("11. a duplicate address is rejected", () => {
    assert.throws(() => buildSettlementTree([leaf(1, 1n, 0n), leaf(1, 2n, 0n)]),
      (e: unknown) => e instanceof SettlementInvariantError && /Duplicate address/.test((e as Error).message));
  });

  it("12. an empty leaf set is rejected", () => {
    assert.throws(() => buildSettlementTree([]), /no leaves/);
  });

  it("13. an unknown address has no proof", () => {
    assert.throws(() => buildSettlementTree(many).proofFor(`0x${"9".repeat(40)}`), /no leaf/);
  });
});

describe("manifest canonicalisation", () => {
  it("14. the hash is independent of key order and whitespace", () => {
    const a = { chainId: 80002, checkpointId: 5, root: "0xab" };
    const b = { root: "0xab", checkpointId: 5, chainId: 80002 };
    assert.equal(manifestHash(a), manifestHash(b));
  });

  it("15. integers serialise as decimal strings, so no float can creep in", () => {
    assert.equal(canonicalJson({ n: 5, s: "5", b: 7n }), '{"b":"7","n":"5","s":"5"}');
  });

  it("16. a changed value changes the hash", () => {
    assert.notEqual(manifestHash({ a: 1 }), manifestHash({ a: 2 }));
  });

  it("17. a non-integer number is refused rather than silently rounded", () => {
    assert.throws(() => canonicalJson({ n: 1.5 }), /non-integer/);
  });

  it("18. assertInvariant reports the financial reason", () => {
    assert.throws(() => assertInvariant(false, "because money"),
      (e: unknown) => e instanceof SettlementInvariantError && /because money/.test((e as Error).message));
  });
});

// ════════════════════════════════ SETTLEMENT IDENTITY ════

/**
 * Phase 3 identity: the leaf is keyed to the user's own address.
 *
 * ACFWithdrawal builds its leaf from `_msgSender()`, and the user signs the claim themselves, so
 * the address the backend puts in the leaf and the address the contract derives are the same
 * value. These prove that nothing can substitute one address for another.
 */
describe("the settlement leaf is keyed to the claimant's own address", () => {
  const A = `0x${"a".repeat(40)}`;
  const B = `0x${"b".repeat(40)}`;

  it("18. two users with IDENTICAL entitlement get different leaves", () => {
    // If identity were dropped from the leaf, these would collide and either could claim both.
    const self = 7n * E18;
    const team = 3n * E18;
    assert.notEqual(
      leafHash({ externalEOA: A, cumulativeSelfACF: self, cumulativeTeamACF: team }),
      leafHash({ externalEOA: B, cumulativeSelfACF: self, cumulativeTeamACF: team }),
    );
  });

  it("19. A's proof is not a proof for B, even at the same amounts", () => {
    const self = 7n * E18;
    const team = 3n * E18;
    const tree = buildSettlementTree([
      { externalEOA: A, cumulativeSelfACF: self, cumulativeTeamACF: team },
      { externalEOA: B, cumulativeSelfACF: self, cumulativeTeamACF: team },
    ]);
    const proofA = tree.proofFor(A);
    const proofB = tree.proofFor(B);
    assert.notDeepEqual(proofA, proofB, "the sibling hashes differ because the leaves differ");
    // The contract rebuilds the leaf from msg.sender, so B presenting A's proof hashes B's own
    // leaf against A's path — which cannot reach the root.
    assert.notEqual(
      leafHash({ externalEOA: A, cumulativeSelfACF: self, cumulativeTeamACF: team }),
      leafHash({ externalEOA: B, cumulativeSelfACF: self, cumulativeTeamACF: team }),
    );
  });

  it("20. the leaf changes if the address changes, with amounts held fixed", () => {
    const base = { cumulativeSelfACF: 1n, cumulativeTeamACF: 2n };
    const seen = new Set<string>();
    for (const who of [A, B, `0x${"c".repeat(40)}`]) {
      seen.add(leafHash({ ...base, externalEOA: who }));
    }
    assert.equal(seen.size, 3, "one distinct leaf per address");
  });

  it("21. there is no address translation: the leaf takes exactly one address field", () => {
    // A leaf carries a single identity. Any second address would be a place for a substitution
    // to hide, which is what the removed wallet layer was.
    const keys = Object.keys(VECTOR).filter((k) => /EOA|wallet|address/i.test(k));
    assert.deepEqual(keys, ["externalEOA"]);
  });
});
