import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acfToUsd6, applyRankCap, baseRank, differentialRateE6, globalReward, grossRankReward,
  LEVEL_RATES, levelReward, RANK_TIERS, rankCapUSD6, rankRateE6, REQUIRED_QUALIFIERS,
  resolveRank, unlockedLevels, usd6ToAcf, USD,
} from "./policy.ts";

const E18 = 10n ** 18n;
const P1 = E18;                       // $1.00 per ACF
const qualifiers = (counts: Record<number, number> = {}) =>
  new Map(Object.entries(counts).map(([k, v]) => [Number(k), v]));

describe("Level rates", () => {
  it("1. L1-L7 are 10/8/6/4/4/1/1 percent on 1e6", () => {
    assert.deepEqual([...LEVEL_RATES],
      [100_000n, 80_000n, 60_000n, 40_000n, 40_000n, 10_000n, 10_000n]);
  });

  it("2. each level pays its exact percentage of the source reward", () => {
    const source = 1000n * E18;
    const expected = [100n, 80n, 60n, 40n, 40n, 10n, 10n];
    for (const [i, pct] of expected.entries()) {
      assert.equal(levelReward(source, i + 1), pct * E18, `L${i + 1}`);
    }
  });

  it("3. relative L8 and beyond pay nothing", () => {
    for (const level of [8, 9, 50]) {
      assert.equal(levelReward(1000n * E18, level), 0n);
    }
  });

  it("4. the seven levels total 34% of the source", () => {
    const source = 1000n * E18;
    let sum = 0n;
    for (let l = 1; l <= 7; l++) sum += levelReward(source, l);
    assert.equal(sum, 340n * E18);
  });

  it("5. rounding floors", () => {
    assert.equal(levelReward(1n, 6), 0n);                 // 1 x 1% is below one unit
    assert.equal(levelReward(999_999n, 1), 99_999n);      // 99_999.9 floors
  });
});

describe("Level unlock", () => {
  it("6. 0 directs unlocks nothing", () => assert.equal(unlockedLevels(0), 0));
  it("7. 1 direct unlocks L1 only", () => assert.equal(unlockedLevels(1), 1));
  it("8. 2 directs unlock L1-L2", () => assert.equal(unlockedLevels(2), 2));
  it("9. 3 directs unlock L1-L3", () => assert.equal(unlockedLevels(3), 3));
  it("10. 4 or more unlock all seven, with no 5/6/7 tier", () => {
    for (const d of [4, 5, 6, 7, 99]) assert.equal(unlockedLevels(d), 7, `${d} directs`);
  });
  it("11. a negative count is treated as none", () => assert.equal(unlockedLevels(-1), 0));
});

describe("USD6 conversion", () => {
  it("12. acfWei x priceE18 / 1e30 yields USDT base units", () => {
    // 1000 ACF at $1.00 = $1000 = 1_000_000_000 USD6
    assert.equal(acfToUsd6(1000n * E18, P1), 1_000n * USD);
    // at $2.50
    assert.equal(acfToUsd6(1000n * E18, 25n * E18 / 10n), 2_500n * USD);
  });

  it("13. the round trip is stable to within one unit", () => {
    const usd = 375n * USD;
    const acf = usd6ToAcf(usd, 1_547_749_657_915_444_035n);
    const back = acfToUsd6(acf, 1_547_749_657_915_444_035n);
    assert.ok(usd - back <= 1n && back <= usd, `expected ~${usd}, got ${back}`);
  });

  it("14. zero and non-positive inputs are safe", () => {
    assert.equal(acfToUsd6(0n, P1), 0n);
    assert.equal(usd6ToAcf(0n, P1), 0n);
    assert.throws(() => usd6ToAcf(1n, 0n), /zero price/);
  });
});

describe("rank table", () => {
  it("15. twelve tiers, Nova..EternalX, rates 10%..120%", () => {
    assert.equal(RANK_TIERS.length, 12);
    assert.deepEqual(RANK_TIERS.map((t) => t.name), [
      "Nova", "Vertex", "Crown", "Royal", "Legend", "Master",
      "Quantum", "Prestige", "Monarch", "Empire", "Supreme", "EternalX",
    ]);
    assert.deepEqual(RANK_TIERS.map((t) => t.rateE6), [
      100_000n, 200_000n, 300_000n, 400_000n, 500_000n, 600_000n,
      700_000n, 800_000n, 900_000n, 1_000_000n, 1_100_000n, 1_200_000n,
    ]);
  });

  it("16. self thresholds in USD6", () => {
    assert.deepEqual(RANK_TIERS.map((t) => t.selfUSD6), [
      100n * USD, 300n * USD, 900n * USD, 2_000n * USD, 5_000n * USD, 7_500n * USD,
      10_000n * USD, 12_500n * USD, 15_000n * USD, 17_500n * USD, 20_000n * USD, 20_000n * USD,
    ]);
  });

  it("17. team thresholds exist for 1-6 and are INHERITED for 7-12", () => {
    assert.deepEqual(RANK_TIERS.slice(0, 6).map((t) => t.teamUSD6), [
      5_000n * USD, 15_000n * USD, 45_000n * USD,
      135_000n * USD, 400_000n * USD, 1_200_000n * USD,
    ]);
    for (const t of RANK_TIERS.slice(6)) {
      assert.equal(t.teamUSD6, null, `${t.name} must inherit, not restate, a team figure`);
    }
  });

  it("18. the caps are the TWELVE-HOUR values, already halved", () => {
    // Published daily figures are 10/30/90/250/750/2000/5000/10000/20000/40000/80000/150000.
    assert.deepEqual(RANK_TIERS.map((t) => t.epochCapUSD6), [
      5n * USD, 15n * USD, 45n * USD, 125n * USD, 375n * USD, 1_000n * USD,
      2_500n * USD, 5_000n * USD, 10_000n * USD, 20_000n * USD, 40_000n * USD, 75_000n * USD,
    ]);
  });

  it("19. active-direct requirements", () => {
    assert.deepEqual(RANK_TIERS.map((t) => t.requiredDirects),
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10]);
  });

  it("20. an unranked user has rate 0 and cap 0, never Nova's", () => {
    assert.equal(rankRateE6(0), 0n);
    assert.equal(rankCapUSD6(0), 0n);
  });
});

describe("base rank qualification", () => {
  const at = (self: bigint, team: bigint, directs: number) =>
    baseRank({ selfStakeUSD6: self, teamStakeUSD6: team, qualifyingDirects: directs, qualifiersAtOrAbove: qualifiers() });

  it("21. every tier qualifies at EXACTLY its thresholds", () => {
    for (const t of RANK_TIERS.slice(0, 6)) {
      assert.equal(at(t.selfUSD6, t.teamUSD6!, t.requiredDirects), t.n, t.name);
    }
  });

  it("22. one dollar short of self drops to the tier below", () => {
    const master = RANK_TIERS[5]!;
    assert.equal(at(master.selfUSD6 - 1n, master.teamUSD6!, master.requiredDirects), 5);
  });

  it("23. one dollar short of team drops to the tier below", () => {
    const master = RANK_TIERS[5]!;
    assert.equal(at(master.selfUSD6, master.teamUSD6! - 1n, master.requiredDirects), 5);
  });

  it("24. one direct short drops to the tier below", () => {
    const master = RANK_TIERS[5]!;
    assert.equal(at(master.selfUSD6, master.teamUSD6!, master.requiredDirects - 1), 5);
  });

  it("25. below Nova on any axis is unranked", () => {
    assert.equal(at(99n * USD, 5_000n * USD, 2), 0);
    assert.equal(at(100n * USD, 4_999n * USD, 2), 0);
    assert.equal(at(100n * USD, 5_000n * USD, 1), 0);
  });
});

describe("high-rank promotion", () => {
  /** Master-qualified on every base axis, with abundant self and directs. */
  const strong = (self: bigint, directs: number, q: Record<number, number>) => ({
    selfStakeUSD6: self,
    teamStakeUSD6: 1_200_000n * USD,
    qualifyingDirects: directs,
    qualifiersAtOrAbove: qualifiers(q),
  });

  it("26. Quantum needs Master, self $10k, 8 directs and >=2 downline at >= Master", () => {
    assert.equal(resolveRank(strong(10_000n * USD, 8, { 6: 2 })), 7);
  });

  it("27. one qualifier is not enough", () => {
    assert.equal(resolveRank(strong(10_000n * USD, 8, { 6: 1 })), 6);
    assert.equal(REQUIRED_QUALIFIERS, 2);
  });

  it("28. the inherited Master team requirement still binds at Quantum", () => {
    assert.equal(resolveRank({
      selfStakeUSD6: 10_000n * USD,
      teamStakeUSD6: 1_200_000n * USD - 1n,          // one dollar short of Master's team
      qualifyingDirects: 8,
      qualifiersAtOrAbove: qualifiers({ 6: 2 }),
    }), 5, "without Master's team there is no Quantum");
  });

  it("29. Quantum's own self threshold binds", () => {
    assert.equal(resolveRank(strong(10_000n * USD - 1n, 8, { 6: 2 })), 6);
  });

  it("30. Quantum's direct requirement binds", () => {
    assert.equal(resolveRank(strong(10_000n * USD, 7, { 6: 2 })), 6);
  });

  it("31. the chain climbs to EternalX when every tier is satisfied", () => {
    assert.equal(resolveRank(strong(20_000n * USD, 10,
      { 6: 2, 7: 2, 8: 2, 9: 2, 10: 2, 11: 2 })), 12);
  });

  it("32. the chain stops at the first unmet tier", () => {
    // Monarch needs >=2 at Prestige; only Quantum-level qualifiers exist.
    assert.equal(resolveRank(strong(20_000n * USD, 10, { 6: 2, 7: 2 })), 8);
  });

  it("33. promotion never skips a tier", () => {
    // Qualifiers for Prestige exist but not for Quantum, so the chain cannot start.
    assert.equal(resolveRank(strong(20_000n * USD, 10, { 7: 2 })), 6);
  });
});

describe("rank differential", () => {
  it("34. 50% leader over a 30% downline leaves 20%", () => {
    assert.equal(differentialRateE6(5, 3), 200_000n);
  });

  it("35. equal rates leave nothing", () => assert.equal(differentialRateE6(5, 5), 0n));

  it("36. a higher downline rate clamps to zero, never negative", () => {
    assert.equal(differentialRateE6(3, 5), 0n);
  });

  it("37. an unranked leader earns nothing", () => assert.equal(differentialRateE6(0, 0), 0n));

  it("38. 20% of a 1000 ACF base is 200 ACF", () => {
    assert.equal(grossRankReward(1000n * E18, 200_000n), 200n * E18);
  });

  it("39. a chain of leaders distributes exactly the top rate, not the sum of rates", () => {
    const base = 1000n * E18;
    // Crown 30% over nothing, Legend 50% over Crown, Master 60% over Legend.
    const crown = grossRankReward(base, differentialRateE6(3, 0));
    const legend = grossRankReward(base, differentialRateE6(5, 3));
    const master = grossRankReward(base, differentialRateE6(6, 5));
    assert.equal(crown, 300n * E18);
    assert.equal(legend, 200n * E18);
    assert.equal(master, 100n * E18);
    assert.equal(crown + legend + master, 600n * E18, "exactly Master's 60%");
  });
});

describe("rank cap", () => {
  it("40. gross under the cap is paid in full and not flagged", () => {
    const gross = 100n * E18;                               // $100 at P=1
    const r = applyRankCap(gross, 375n * USD, P1);
    assert.equal(r.payableACF, gross);
    assert.equal(r.capped, false);
  });

  it("41. gross of $400 against a $375 cap pays exactly $375 of ACF", () => {
    const r = applyRankCap(400n * E18, 375n * USD, P1);
    assert.equal(r.capped, true);
    assert.equal(r.payableACF, 375n * E18);
    assert.equal(acfToUsd6(r.payableACF, P1), 375n * USD);
  });

  it("42. exactly at the cap is NOT capped", () => {
    const r = applyRankCap(375n * E18, 375n * USD, P1);
    assert.equal(r.capped, false);
    assert.equal(r.payableACF, 375n * E18);
  });

  it("43. Nova at exactly $5 gross is not halved a second time", () => {
    // The table holds the 12h cap ($5), not the published daily figure ($10).
    const r = applyRankCap(5n * E18, rankCapUSD6(1), P1);
    assert.equal(rankCapUSD6(1), 5n * USD);
    assert.equal(r.capped, false);
    assert.equal(r.payableACF, 5n * E18, "a second halving would pay 2.5");
  });

  it("44. the cap is applied in USD, so a higher price caps sooner", () => {
    const gross = 300n * E18;
    const cheap = applyRankCap(gross, 375n * USD, P1);              // $300 -> uncapped
    const dear = applyRankCap(gross, 375n * USD, 2n * E18);         // $600 -> capped
    assert.equal(cheap.capped, false);
    assert.equal(dear.capped, true);
    assert.equal(dear.payableACF, 1875n * E18 / 10n);               // $375 at $2 = 187.5 ACF
  });
});

describe("global contribution", () => {
  it("45. the documented fixture yields exactly 2,500 ACF", () => {
    assert.equal(
      globalReward(10_000n * E18, 50_000n * E18, 5, 1_000_000n * E18),
      2_500n * E18,
    );
  });

  it("46. an unranked leader earns nothing", () => {
    assert.equal(globalReward(10_000n * E18, 50_000n * E18, 0, 1_000_000n * E18), 0n);
  });

  it("47. a zero denominator returns zero rather than throwing", () => {
    assert.equal(globalReward(10_000n * E18, 50_000n * E18, 5, 0n), 0n);
  });

  it("48. zero self or zero L1 earns nothing", () => {
    assert.equal(globalReward(0n, 50_000n * E18, 5, 1_000_000n * E18), 0n);
    assert.equal(globalReward(10_000n * E18, 0n, 5, 1_000_000n * E18), 0n);
  });

  it("49. the ACF payout is PRICE-INDEPENDENT — the formula carries no price at all", () => {
    const a = globalReward(10_000n * E18, 50_000n * E18, 5, 1_000_000n * E18);
    // Nothing to vary: price is not a parameter. Confirm against the long USD form instead.
    for (const price of [E18, 2n * E18, 37n * E18 / 10n]) {
      const selfUSD = acfToUsd6(10_000n * E18, price);
      const l1USD = acfToUsd6(50_000n * E18, price);
      const netUSD = acfToUsd6(1_000_000n * E18, price);
      // long form: (selfUSD x l1USD x rank) / netUSD, then back to ACF
      const grossUSD6 = (selfUSD * l1USD * 5n) / netUSD;
      const longFormACF = usd6ToAcf(grossUSD6, price);
      const drift = longFormACF > a ? longFormACF - a : a - longFormACF;
      // The long form truncates three extra times; it must agree to within rounding.
      assert.ok(drift * 1_000_000n < a, `price ${price}: drift ${drift} too large`);
    }
  });

  it("50. huge inputs stay exact in bigint", () => {
    const self = 1_000_000_000n * E18;
    const l1 = 1_000_000_000n * E18;
    const net = 1_000_000_000n * E18;
    assert.equal(globalReward(self, l1, 12, net), self * 12n);
  });

  it("51. rounding floors", () => {
    assert.equal(globalReward(1n, 1n, 1, 3n), 0n);
    assert.equal(globalReward(10n, 10n, 1, 3n), 33n);
  });

  it("52. there is no cap: a small denominator produces a very large payout", () => {
    const reward = globalReward(10_000n * E18, 50_000n * E18, 5, 10n * E18);
    assert.equal(reward, 250_000_000n * E18);
  });
});
