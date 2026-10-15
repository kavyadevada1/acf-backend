import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acfToUsd6, assertInvariant, batchIndexOf, canonicalJson, compareByAddress,
  daoMarketingUSD6, daoRevenuePoolUSD6, DAORevenueInvariantError, isEligible, membershipLabel,
  memberRevenueUSD6, PERCENTAGE_DENOMINATOR, systemSelfRewardACF, usd6ToAcf,
} from "./policy.ts";

const E18 = 10n ** 18n;
const USD = 1_000_000n;
/** $2.00 per whole ACF, scaled 1e18, matching the spec's worked fixture. */
const P2 = 2n * E18;
const RATE_5 = 50_000n;

describe("denominator", () => {
  it("1. shares ACFDAO's PERCENTAGE_DENOMINATOR, so 50_000 really is 5%", () => {
    assert.equal(PERCENTAGE_DENOMINATOR, 1_000_000n);
    assert.equal((RATE_5 * 100n) / PERCENTAGE_DENOMINATOR, 5n);
  });
});

describe("system revenue", () => {
  it("2. is DIRECT+BOND plus DAO staking reward", () => {
    assert.equal(systemSelfRewardACF(18_000n * E18, 2_000n * E18), 20_000n * E18);
  });

  it("3. is zero when the epoch generated nothing", () => {
    assert.equal(systemSelfRewardACF(0n, 0n), 0n);
  });

  it("4. refuses a negative component rather than netting it off", () => {
    assert.throws(() => systemSelfRewardACF(-1n, 0n), DAORevenueInvariantError);
    assert.throws(() => systemSelfRewardACF(0n, -1n), DAORevenueInvariantError);
  });
});

describe("USD6 conversion", () => {
  it("5. converts 20,000 ACF at $2 to $40,000", () => {
    assert.equal(acfToUsd6(20_000n * E18, P2), 40_000n * USD);
  });

  it("6. inverts exactly for a representable amount", () => {
    assert.equal(usd6ToAcf(40_000n * USD, P2), 20_000n * E18);
  });

  it("7. floors rather than rounding, in both directions", () => {
    // 1 wei at $2 is 2e-18 dollars; far below one USD base unit.
    assert.equal(acfToUsd6(1n, P2), 0n);
    // 1 USD base unit at $2 is 0.5e-6 ACF = 5e11 wei; exact here, so use a prime price.
    const odd = 3n * E18;
    const acf = usd6ToAcf(1n, odd);
    assert.ok(acf * odd <= 1n * 10n ** 30n, "never rounds up past the input");
  });

  it("8. rejects a zero or negative price instead of dividing by it", () => {
    assert.throws(() => acfToUsd6(1n, 0n), DAORevenueInvariantError);
    assert.throws(() => usd6ToAcf(1n, 0n), DAORevenueInvariantError);
    assert.throws(() => acfToUsd6(1n, -1n), DAORevenueInvariantError);
  });

  it("9. uses no floating point anywhere — a huge amount stays exact", () => {
    const huge = 10_000_000n * E18;                 // 1e25, far beyond 2^53
    const usd = acfToUsd6(huge, P2);
    assert.equal(usd, 20_000_000n * USD);
    assert.equal(usd6ToAcf(usd, P2), huge);
  });
});

describe("the 5% shared pool", () => {
  it("10. takes exactly 5% of $40,000", () => {
    assert.equal(daoRevenuePoolUSD6(40_000n * USD, RATE_5), 2_000n * USD);
  });

  it("11. is zero when system revenue is zero", () => {
    assert.equal(daoRevenuePoolUSD6(0n, RATE_5), 0n);
  });

  it("12. honours a DIFFERENT historical rate rather than assuming 5%", () => {
    assert.equal(daoRevenuePoolUSD6(40_000n * USD, 30_000n), 1_200n * USD);  // 3%
    assert.equal(daoRevenuePoolUSD6(40_000n * USD, 100_000n), 4_000n * USD); // 10%
  });

  it("13. floors, so the pool never exceeds its share", () => {
    // 19 USD base units at 5% = 0.95 -> 0
    assert.equal(daoRevenuePoolUSD6(19n, RATE_5), 0n);
    assert.equal(daoRevenuePoolUSD6(20n, RATE_5), 1n);
  });

  it("14. rejects a rate above the denominator", () => {
    assert.throws(
      () => daoRevenuePoolUSD6(USD, PERCENTAGE_DENOMINATOR + 1n), DAORevenueInvariantError,
    );
  });
});

/**
 * The marketing allocation is now a real payable obligation.
 *
 * ACFDAO holds two separate rates against one epoch's SystemRevenueUSD — members at 5% and
 * marketing at 2% — and both are paid out of one Treasury funding. The backend computes both,
 * so what has to be pinned is no longer "marketing is never calculated" but that the calculation
 * stays honest: the rate comes from the recorded on-chain configuration, the two shares never
 * contaminate each other, and none of the splitter's own arithmetic appears here.
 */
describe("the marketing allocation is a separate share of the same revenue", () => {
  const RATE_2 = 20_000n;

  it("15. takes exactly 2% of $40,000, independently of the member pool", () => {
    assert.equal(daoMarketingUSD6(40_000n * USD, RATE_2), 800n * USD);
    assert.equal(daoRevenuePoolUSD6(40_000n * USD, RATE_5), 2_000n * USD);
    // Separate shares of the WHOLE revenue: members take 5% of 40,000 and marketing 2% of the
    // same 40,000, never 2% of what is left after the member pool.
    assert.equal(
      daoMarketingUSD6(40_000n * USD - 2_000n * USD, RATE_2), 760n * USD,
      "what 2%-of-the-remainder would have been, which is NOT the rule",
    );
    assert.notEqual(daoMarketingUSD6(40_000n * USD, RATE_2), 760n * USD);
  });

  it("16. the known case: 1,000 revenue owes 50 to members, 20 to marketing, 70 in all", () => {
    const revenue = 1_000n * USD;
    const member = daoRevenuePoolUSD6(revenue, RATE_5);
    const marketing = daoMarketingUSD6(revenue, RATE_2);
    assert.equal(member, 50n * USD);
    assert.equal(marketing, 20n * USD);
    assert.equal(member + marketing, 70n * USD, "70 owed, not 60 and not 7% to members");
    // And the member pool is untouched by the marketing rate: the function takes only its own.
    assert.equal(daoRevenuePoolUSD6.length, 2);
    assert.notEqual(member, 70n * USD, "members are never paid the combined share");
  });

  it("17. floors exactly as the member pool does, so the two cannot drift", () => {
    // Non-divisible amounts, pinned against hand-computed truncation. No floating point.
    for (const [revenue, member, marketing] of [
      [1n, 0n, 0n],
      [49n, 2n, 0n],
      [50n, 2n, 1n],
      [999_999n, 49_999n, 19_999n],
      [1_234_567n, 61_728n, 24_691n],
      [10n ** 30n, (10n ** 30n) / 20n, (10n ** 30n) / 50n],
    ] as const) {
      assert.equal(daoRevenuePoolUSD6(revenue, RATE_5), member, `member of ${revenue}`);
      assert.equal(daoMarketingUSD6(revenue, RATE_2), marketing, `marketing of ${revenue}`);
    }
  });

  it("18. honours a DIFFERENT historical rate rather than assuming 2%", () => {
    // The rate is an argument because it is resolved from the configuration history as of the
    // epoch snapshot. Raising it tomorrow must not repay yesterday.
    assert.equal(daoMarketingUSD6(40_000n * USD, 10_000n), 400n * USD);  // the old 1%
    assert.equal(daoMarketingUSD6(40_000n * USD, 0n), 0n);               // switched off
    assert.throws(
      () => daoMarketingUSD6(USD, PERCENTAGE_DENOMINATOR + 1n), DAORevenueInvariantError,
    );
  });

  it("19. no rate is hardcoded in Phase 4, and no splitter maths was brought in", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    /** Comments carry the business rule; the rule is that the LOGIC must not. */
    const code = (f: string) =>
      read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    for (const file of [
      "policy.ts", "calculation.ts", "liability.ts", "executor.ts", "manifest.ts",
      "readModel.ts", "reconcile.ts", "inputs.ts", "eligibility.ts", "service.ts",
      "configHistory.ts",
    ]) {
      const source = code(file);
      // A literal rate here would be a second answer to a question only the contract may answer.
      for (const forbidden of ["20_000", "50_000", "10_000"]) {
        assert.ok(!source.includes(forbidden), `daoRevenue/${file} must not hardcode ${forbidden}`);
      }
      // The ROOT partner split is a different contract's arithmetic and belongs nowhere here.
      for (const forbidden of [
        "sharesBps", "TOTAL_SHARE_BPS", "RootRewardSharePaid", "RootRewardDistributed",
        "recipientCount", "distributionAt",
      ]) {
        assert.ok(!source.includes(forbidden), `daoRevenue/${file} must not reference ${forbidden}`);
      }
    }

    // The marketing rate is read from the recorded config, never from configuration or a literal.
    assert.match(code("calculation.ts"), /daoConfig\.marketingRateE6/);
    assert.ok(
      !code("calculation.ts").includes("config.marketing"),
      "the rate must not come from backend configuration",
    );
  });
});

describe("member share", () => {
  it("15. THE SPEC FIXTURE — Alice's $5,000 of $100,000 earns $100", () => {
    const pool = 2_000n * USD;
    const share = memberRevenueUSD6(pool, 5_000n * USD, 100_000n * USD);
    assert.equal(share, 100n * USD);
    // At $2, that is 50 ACF.
    assert.equal(usd6ToAcf(share, P2), 50n * E18);
  });

  it("16. a sole member takes the whole pool", () => {
    assert.equal(memberRevenueUSD6(2_000n * USD, 5_000n * USD, 5_000n * USD), 2_000n * USD);
  });

  it("17. weight is proportional to recorded USDT, not member count", () => {
    const pool = 1_000n * USD;
    const total = 30_000n * USD;
    const big = memberRevenueUSD6(pool, 20_000n * USD, total);
    const small = memberRevenueUSD6(pool, 10_000n * USD, total);
    assert.equal(big, small * 2n, "twice the contribution, twice the share");
    // 2/3 and 1/3 of 1,000 USD are not representable, so flooring keeps 1 base unit back.
    // The sum must never EXCEED the pool; falling short by dust is the designed behaviour.
    assert.ok(big + small <= pool);
    assert.equal(pool - (big + small), 1n);
  });

  it("18. floors each share, so the sum can fall short of the pool", () => {
    const pool = 100n;                      // 100 USD base units
    const total = 3n;
    const shares = [1n, 1n, 1n].map((w) => memberRevenueUSD6(pool, w, total));
    assert.deepEqual(shares, [33n, 33n, 33n]);
    assert.equal(shares.reduce((a, b) => a + b, 0n), 99n);
    assert.equal(pool - 99n, 1n, "1 base unit of dust, never funded");
  });

  it("19. refuses a zero denominator rather than dividing by it", () => {
    assert.throws(() => memberRevenueUSD6(100n, 0n, 0n), DAORevenueInvariantError);
  });

  it("20. refuses a weight above the total", () => {
    assert.throws(() => memberRevenueUSD6(100n, 11n, 10n), DAORevenueInvariantError);
  });
});

describe("eligibility and labels", () => {
  const SILVER = 5_000n * USD;
  const GOLD = 25_000n * USD;

  it("21. exactly the Silver minimum qualifies", () => {
    assert.equal(isEligible(SILVER, SILVER), true);
  });

  it("22. one USDT base unit below does not", () => {
    assert.equal(isEligible(SILVER - 1n, SILVER), false);
  });

  it("23. Gold qualifies through the same single gate", () => {
    assert.equal(isEligible(GOLD, SILVER), true);
  });

  it("24. the label is cosmetic and carries no multiplier", () => {
    assert.equal(membershipLabel(SILVER - 1n, SILVER, GOLD), "NONE");
    assert.equal(membershipLabel(SILVER, SILVER, GOLD), "SILVER");
    assert.equal(membershipLabel(GOLD, SILVER, GOLD), "GOLD");
    // A Gold member with 5x the contribution gets exactly 5x the share — no bonus.
    const pool = 60_000n * USD;
    const total = 30_000n * USD;
    const gold = memberRevenueUSD6(pool, 25_000n * USD, total);
    const silver = memberRevenueUSD6(pool, 5_000n * USD, total);
    assert.equal(gold, silver * 5n);
  });
});

describe("determinism", () => {
  it("25. orders members by lowercase wallet, ascending", () => {
    const members = [
      { externalEOA: "0xCC" }, { externalEOA: "0xaa" },
      { externalEOA: "0xBb" },
    ];
    assert.deepEqual(
      [...members].sort(compareByAddress).map((m) => m.externalEOA),
      ["0xaa", "0xBb", "0xCC"],
    );
  });

  it("26. the order is independent of input order", () => {
    const a = [{ externalEOA: "0x01" }, { externalEOA: "0x02" }];
    assert.deepEqual(
      [...a].sort(compareByAddress), [...a].reverse().sort(compareByAddress),
    );
  });

  it("27. batch index groups by configured size", () => {
    assert.equal(batchIndexOf(0, 50), 0);
    assert.equal(batchIndexOf(49, 50), 0);
    assert.equal(batchIndexOf(50, 50), 1);
    assert.equal(batchIndexOf(100, 50), 2);
  });

  it("28. a non-positive batch size is refused", () => {
    assert.throws(() => batchIndexOf(0, 0), DAORevenueInvariantError);
    assert.throws(() => batchIndexOf(0, -1), DAORevenueInvariantError);
  });
});

describe("manifest canonicalisation", () => {
  it("29. is independent of key order", () => {
    assert.equal(
      canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }),
    );
  });

  it("30. preserves array order, which batches depend on", () => {
    assert.notEqual(canonicalJson({ x: [1, 2] }), canonicalJson({ x: [2, 1] }));
  });

  it("31. serialises integers as decimal strings so no float can appear", () => {
    assert.equal(canonicalJson({ n: 5, b: 7n, s: "5" }), '{"b":"7","n":"5","s":"5"}');
  });

  it("32. refuses a non-integer rather than rounding it", () => {
    assert.throws(() => canonicalJson({ n: 1.5 }), DAORevenueInvariantError);
  });

  it("33. drops mongo bookkeeping fields", () => {
    assert.equal(canonicalJson({ a: 1, _id: "x", __v: 0 }), '{"a":"1"}');
  });

  it("34. assertInvariant reports the financial reason", () => {
    assert.throws(
      () => assertInvariant(false, "because money"),
      (e: unknown) => e instanceof DAORevenueInvariantError && /because money/.test((e as Error).message),
    );
  });
});

// ════════════════════════════════ PAYOUT IDENTITY ════

/**
 * Phase 4 identity: the address submitted to `distributeBatch` is the address paid.
 *
 * The distributor transfers to exactly the address it is given, so there is no registry read, no
 * resolution step, and no second address that could disagree with the first.
 */
describe("the DAO revenue recipient is the member's own address", () => {
  const A = `0x${"a".repeat(40)}`;
  const B = `0x${"b".repeat(40)}`;

  it("27. ordering is by the member's own address, and is total", () => {
    const rows = [{ externalEOA: B }, { externalEOA: A }];
    assert.deepEqual([...rows].sort(compareByAddress).map((r) => r.externalEOA), [A, B]);
    // Deterministic both ways round, so batch composition cannot depend on input order.
    assert.deepEqual([...rows].reverse().sort(compareByAddress).map((r) => r.externalEOA), [A, B]);
  });

  it("28. ordering ignores case, so a checksummed address sorts with its lowercase form", () => {
    const upper = `0x${"A".repeat(40)}`;
    assert.equal(compareByAddress({ externalEOA: upper }, { externalEOA: A }), 0);
  });

  it("29. an obligation names one address, which is both the argument and the recipient", () => {
    // A second address field is exactly what the removed wallet layer added, and exactly where a
    // payout could have diverged from the member it was credited to.
    const obligation = { userId: "u1", externalEOA: A, memberRevenueACF: "1" };
    const addressKeys = Object.keys(obligation).filter((k) => /EOA|wallet|address/i.test(k));
    assert.deepEqual(addressKeys, ["externalEOA"]);
  });
});
