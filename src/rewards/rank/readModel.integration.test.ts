import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { assertDisposable, TEST_STAKING } from "../../settlement/testenv.ts";

const TEST_URI = process.env.MONGODB_TEST_URI;

const { getRankReadModel, getRankHistory, RankSnapshotMissingError, TIERS } =
  await import("./readModel.js");
const { RANK_TIERS, REQUIRED_QUALIFIERS } = await import("../team/policy.js");
const { RewardPhase2Epoch } = await import("../../models/RewardPhase2Epoch.js");
const { UserRankSnapshot } = await import("../../models/UserRankSnapshot.js");
const { TeamRewardEntry } = await import("../../models/TeamRewardEntry.js");

const USD = 1_000_000n;
const E18 = 10n ** 18n;
const LOW = TEST_STAKING.toLowerCase();
const K = { chainId: 80002, stakingContractAddress: LOW };
const EPOCH = 41_461;
const PRICE = "2759074552778437640";
const U = "usr_rank";

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([RewardPhase2Epoch.init(), UserRankSnapshot.init(), TeamRewardEntry.init()]);
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (!connected) return;
  await Promise.all([
    RewardPhase2Epoch.deleteMany({}), UserRankSnapshot.deleteMany({}), TeamRewardEntry.deleteMany({}),
  ]);
});

const mkEpoch = (epochId: number, status = "CALCULATED") =>
  RewardPhase2Epoch.collection.insertOne({
    ...K, epochId, status, attempts: 1, snapshotAt: epochId * 43_200, priceE18: PRICE,
  } as never);

const mkSnapshot = (o: {
  epochId?: number; userId?: string; rank: number; previousRank?: number | null;
  selfUSD6?: bigint; teamUSD6?: bigint; activeDirects?: number; directCount?: number;
  qualifiers?: number; maxDownlineRank?: number;
  registeredDirects?: number;
  directRule?: "ACTIVE_STAKE" | "ONBOARDED" | "REGISTERED_EOA";
  registrationBasis?: "APPLICATION_TIMESTAMP" | "BLOCK" | "TIMESTAMP";
}) => {
  const tier = RANK_TIERS.find((t) => t.n === o.rank);
  return UserRankSnapshot.collection.insertOne({
    ...K, epochId: o.epochId ?? EPOCH, userId: o.userId ?? U,
    rank: o.rank,
    rankName: tier?.name ?? null,
    rateE6: (tier?.rateE6 ?? 0n).toString(),
    epochCapUSD6: (tier?.epochCapUSD6 ?? 0n).toString(),
    previousRank: o.previousRank === undefined ? null : o.previousRank,
    selfStakeACF: E18.toString(),
    selfStakeUSD6: (o.selfUSD6 ?? 0n).toString(),
    teamStakeACF: E18.toString(),
    teamStakeUSD6: (o.teamUSD6 ?? 0n).toString(),
    activeDirects: o.activeDirects ?? 0,
    directCount: o.directCount ?? 0,
    ...(o.registeredDirects === undefined ? {} : { registeredDirects: o.registeredDirects }),
    ...(o.directRule === undefined ? {} : { directRule: o.directRule }),
    ...(o.registrationBasis === undefined ? {} : { registrationBasis: o.registrationBasis }),
    l1StakeACF: E18.toString(),
    maxDownlineRank: o.maxDownlineRank ?? 0,
    downlineQualifiers: o.qualifiers ?? 0,
    priceE18: PRICE,
  } as never);
};

const mkTeamEntry = (o: { rankRewardACF: string; grossACF: string; capped: boolean; cap: string }) =>
  TeamRewardEntry.collection.insertOne({
    ...K, epochId: EPOCH, userId: U,
    levelRewardACF: "0", rankRewardACF: o.rankRewardACF, globalRewardACF: "0",
    teamRewardACF: o.rankRewardACF,
    levelAudit: { unlockedLevels: 0, directCount: 0, perLevel: [] },
    rankAudit: {
      leaderRank: 1, leaderRateE6: "100000", highestDownlineRank: 0, highestDownlineRateE6: "0",
      differentialRateE6: "100000", teamRewardBaseACF: "0",
      grossACF: o.grossACF, epochCapUSD6: o.cap, capped: o.capped,
    },
    globalAudit: {
      rankNumber: 1, selfStakeACF: "0", selfStakeUSD6: "0", l1StakeACF: "0", l1StakeUSD6: "0",
      networkContributionACF: "0", networkContributionUSD6: "0", priceE18: PRICE,
    },
  } as never);

// ═════════════════════════════════════════ CURRENT RANK ════

describe("current rank", () => {
  it("1. rank 0 is a real state, reported as AVAILABLE", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 0 });
    const r = await getRankReadModel(U);
    assert.equal(r.status, "AVAILABLE", "unranked is not missing data");
    assert.equal(r.currentRank!.rankNumber, 0);
    // The protocol stores no name for rank 0; inventing one here would state data it has not.
    assert.equal(r.currentRank!.rankName, null);
    assert.equal(r.nextRank!.rankNumber, 1, "an unranked member is still shown the way to Nova");
  });

  it("2. a ranked member reports the tier the epoch actually applied", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 4 });
    const r = await getRankReadModel(U);
    assert.equal(r.currentRank!.rankNumber, 4);
    assert.equal(r.currentRank!.rankName, "Royal");
    assert.equal(r.currentRank!.rateE6, "400000", "40% RANK REWARD rate, not a staking yield");
    assert.equal(r.currentRank!.epochCapUSD6, (125n * USD).toString());
  });

  it("3. the top rank has no next rank", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 12 });
    const r = await getRankReadModel(U);
    assert.equal(r.currentRank!.rankName, "EternalX");
    assert.equal(r.nextRank, null);
  });

  it("4. no settled epoch means NOT_YET_CALCULATED, never rank 0", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const r = await getRankReadModel(U);
    assert.equal(r.status, "NOT_YET_CALCULATED");
    assert.equal(r.currentRank, null, "absent, not a fabricated unranked row");
    assert.equal(r.nextRank, null);
    assert.equal(r.tiers.length, 12, "the ladder is still available to read");
  });

  it("5. unsettled and failed epochs are ignored", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH, "CALCULATED");
    await mkSnapshot({ rank: 2, epochId: EPOCH });
    // Newer epochs that never settled must not be read from.
    await mkEpoch(EPOCH + 1, "FAILED");
    await mkSnapshot({ rank: 9, epochId: EPOCH + 1 });
    await mkEpoch(EPOCH + 2, "PROCESSING");
    await mkSnapshot({ rank: 11, epochId: EPOCH + 2 });

    const r = await getRankReadModel(U);
    assert.equal(r.epoch!.epochId, EPOCH);
    assert.equal(r.currentRank!.rankNumber, 2, "the last SETTLED epoch decides");
  });

  it("6. the latest settled epoch wins when several are settled", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    for (const [e, rank] of [[EPOCH - 2, 1], [EPOCH - 1, 2], [EPOCH, 3]] as const) {
      await mkEpoch(e);
      await mkSnapshot({ rank, epochId: e });
    }
    const r = await getRankReadModel(U);
    assert.equal(r.epoch!.epochId, EPOCH);
    assert.equal(r.currentRank!.rankNumber, 3);
  });

  it("7. a settled epoch missing this user's snapshot is an integrity failure", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 5, userId: "someone-else" });
    // Phase 2 writes a row for every user it settled, so an absence is a disagreement —
    // reporting Unranked would state a rank that was never calculated.
    await assert.rejects(() => getRankReadModel(U), RankSnapshotMissingError);
  });

  it("8. another member's snapshot never leaks", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 0, userId: U });
    await mkSnapshot({ rank: 11, userId: "someone-else" });
    const r = await getRankReadModel(U);
    assert.equal(r.currentRank!.rankNumber, 0);
  });
});

// ═══════════════════════════════════════════ NEXT RANK ════

describe("next rank requirements", () => {
  it("9. THE REAL FIXTURE — self met, team and active directs not", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({
      rank: 0,
      selfUSD6: 9_390_023_394n,   // $9,390.02
      teamUSD6: 527_632_411n,     // $527.63
      activeDirects: 1,
      directCount: 4,
    });
    const { requirements } = (await getRankReadModel(U)).nextRank!;
    assert.equal(requirements.selfStakeUSD6.met, true, "$9,390 clears Nova's $100");
    assert.equal(requirements.teamStakeUSD6.met, false, "$527 of $5,000");
    assert.equal(requirements.teamStakeUSD6.required, (5_000n * USD).toString());
    assert.equal(requirements.qualifyingDirects.met, false);
    assert.equal(requirements.qualifyingDirects.current, "1");
    assert.equal(requirements.qualifyingDirects.required, "2");
  });

  it("10. qualification counts ACTIVE directs, never the total", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    // Four referrals, one of them active. Nova needs two ACTIVE.
    await mkSnapshot({ rank: 0, selfUSD6: 9_390_023_394n, activeDirects: 1, directCount: 4 });
    const r = await getRankReadModel(U);
    assert.equal(r.nextRank!.requirements.qualifyingDirects.current, "1");
    assert.notEqual(r.nextRank!.requirements.qualifyingDirects.current, "4");
    assert.equal(r.nextRank!.requirements.qualifyingDirects.met, false, "4 total must not qualify");
    // The total is still reported, as information rather than qualification.
    assert.equal(r.currentRank!.directCount, 4);
    assert.equal(r.currentRank!.activeDirects, 1);
  });

  it("11. landing exactly on a threshold qualifies", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({
      rank: 0, selfUSD6: 100n * USD, teamUSD6: 5_000n * USD, activeDirects: 2,
    });
    const { requirements } = (await getRankReadModel(U)).nextRank!;
    // The policy compares with >=, so the read model must too.
    assert.equal(requirements.selfStakeUSD6.met, true);
    assert.equal(requirements.teamStakeUSD6.met, true);
    assert.equal(requirements.qualifyingDirects.met, true);
  });

  it("12. ranks 1-6 carry no qualifier requirement", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 4 });
    const r = await getRankReadModel(U);
    assert.equal(r.nextRank!.rankName, "Legend");
    assert.equal(r.nextRank!.requirements.downlineQualifiers, null);
  });

  it("13. ranks 7-12 require downline qualifiers at a named rank", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 6, qualifiers: 1 });
    const r = await getRankReadModel(U);
    assert.equal(r.nextRank!.rankName, "Quantum");
    const q = r.nextRank!.requirements.downlineQualifiers!;
    assert.equal(q.required, REQUIRED_QUALIFIERS);
    assert.equal(q.requiredRank, 6, "two downline members at Master");
    assert.equal(q.current, 1);
    assert.equal(q.met, false);
  });

  it("14. the inherited team requirement is resolved, not left null", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 6, teamUSD6: 1_200_000n * USD, qualifiers: 2 });
    const { requirements } = (await getRankReadModel(U)).nextRank!;
    // Quantum stores null and inherits Master's figure through requiresRank. The caller is
    // given the number that must actually be met rather than having to walk the chain.
    assert.equal(requirements.teamStakeUSD6.required, (1_200_000n * USD).toString());
    assert.equal(requirements.teamStakeUSD6.met, true);
  });
});

// ════════════════════════════════════════════════ TIERS ════

describe("tier ladder", () => {
  it("15. returns all twelve tiers, straight from the engine's own constants", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    assert.equal(TIERS.length, 12);
    assert.equal(RANK_TIERS.length, 12);
    for (const tier of RANK_TIERS) {
      const view = TIERS.find((v) => v.rankNumber === tier.n)!;
      assert.ok(view, `rank ${tier.n}`);
      assert.equal(view.rankName, tier.name);
      assert.equal(view.rateE6, tier.rateE6.toString());
      assert.equal(view.selfStakeRequirementUSD6, tier.selfUSD6.toString());
      // Both sides must be a real number: this pair was previously `view.activeDirectRequirement`
      // against `tier.activeDirects`, and after the REGISTERED_EOA rename NEITHER field existed,
      // so the assertion compared undefined with undefined and passed while checking nothing.
      assert.equal(typeof view.requiredDirects, "number", `rank ${tier.n} exposes a direct count`);
      assert.equal(view.requiredDirects, tier.requiredDirects);
      assert.equal(view.epochCapUSD6, tier.epochCapUSD6.toString());
    }
  });

  it("16. every tier states a team requirement, inherited ones included", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const master = TIERS.find((v) => v.rankNumber === 6)!;
    assert.equal(master.teamStakeRequirementUSD6, (1_200_000n * USD).toString());
    // 7-12 inherit Master's figure rather than reporting none.
    for (const n of [7, 8, 9, 10, 11, 12]) {
      const view = TIERS.find((v) => v.rankNumber === n)!;
      assert.equal(view.teamStakeRequirementUSD6, master.teamStakeRequirementUSD6, `rank ${n}`);
    }
  });

  it("17. qualifier requirements appear only where the policy has them", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    for (const n of [1, 2, 3, 4, 5, 6]) {
      assert.equal(TIERS.find((v) => v.rankNumber === n)!.downlineQualifierRequirement, null);
    }
    for (const n of [7, 8, 9, 10, 11, 12]) {
      const q = TIERS.find((v) => v.rankNumber === n)!.downlineQualifierRequirement!;
      assert.equal(q.count, REQUIRED_QUALIFIERS);
      assert.equal(q.requiredRank, n - 1, "each high tier requires the one below it");
    }
  });

  it("18. the cap is the TWELVE-HOUR figure, never doubled into a day", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // policy.ts: "Nova's published daily cap is $10; this is $5."
    assert.equal(TIERS.find((v) => v.rankNumber === 1)!.epochCapUSD6, (5n * USD).toString());
    assert.notEqual(TIERS.find((v) => v.rankNumber === 1)!.epochCapUSD6, (10n * USD).toString());
    assert.equal(TIERS.find((v) => v.rankNumber === 12)!.epochCapUSD6, (75_000n * USD).toString());
  });

  it("19. no tier carries a concept the protocol does not define", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const keys = Object.keys(TIERS[0]!);
    for (const invented of ["tierGroup", "badge", "badges", "description", "yieldBonus", "txHash"]) {
      assert.equal(keys.includes(invented), false, invented);
    }
  });
});

// ═══════════════════════════════════════ RANK REWARD ════

describe("latest rank reward", () => {
  it("20. reports the paid amount, the gross and whether the cap bit", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 1 });
    await mkTeamEntry({
      rankRewardACF: (2n * E18).toString(),
      grossACF: (5n * E18).toString(),
      capped: true,
      cap: (5n * USD).toString(),
    });
    const r = (await getRankReadModel(U)).latestReward!;
    assert.equal(r.rankRewardACF, (2n * E18).toString(), "after the cap");
    assert.equal(r.grossRankRewardACF, (5n * E18).toString(), "before it");
    assert.equal(r.capped, true);
    assert.equal(r.epochCapUSD6, (5n * USD).toString());
  });

  it("21. an uncapped epoch reports gross equal to paid", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 1 });
    await mkTeamEntry({
      rankRewardACF: E18.toString(), grossACF: E18.toString(),
      capped: false, cap: (5n * USD).toString(),
    });
    const r = (await getRankReadModel(U)).latestReward!;
    assert.equal(r.capped, false);
    assert.equal(r.rankRewardACF, r.grossRankRewardACF);
  });

  it("22. an unranked member's zero reward is a real zero", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 0 });
    await mkTeamEntry({ rankRewardACF: "0", grossACF: "0", capped: false, cap: "0" });
    const r = (await getRankReadModel(U)).latestReward!;
    assert.equal(r.rankRewardACF, "0");
    assert.notEqual(r, null, "zero is reported, not treated as missing");
  });

  it("23. no team entry reports null rather than a fabricated zero", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 0 });
    assert.equal((await getRankReadModel(U)).latestReward, null);
  });

  it("24. ACF and USD6 are never mixed into one figure", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 1 });
    await mkTeamEntry({
      rankRewardACF: E18.toString(), grossACF: (3n * E18).toString(),
      capped: true, cap: (5n * USD).toString(),
    });
    const r = (await getRankReadModel(U)).latestReward!;
    // The gross is ACF and the cap is USD6. They are reported side by side, never divided into
    // a ratio — that would need the epoch price and the locked conversion.
    const keys = Object.keys(r);
    for (const invented of ["capProgressPct", "capUsedPct", "grossUSD6", "remainingUSD6"]) {
      assert.equal(keys.includes(invented), false, invented);
    }
    assert.equal(r.grossRankRewardACF.endsWith("000000000000000000"), true, "ACF base units");
  });
});

// ═══════════════════════════════════════════ HISTORY ════

describe("rank history", () => {
  it("25. a steady rank produces no rows", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    for (const e of [EPOCH - 2, EPOCH - 1, EPOCH]) {
      await mkEpoch(e);
      await mkSnapshot({ rank: 0, previousRank: 0, epochId: e });
    }
    assert.deepEqual((await getRankHistory(U)).rows, []);
  });

  it("26. a promotion is recorded with its direction", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 2, previousRank: 1, epochId: EPOCH });
    const [row] = (await getRankHistory(U)).rows;
    assert.equal(row!.fromRank, 1);
    assert.equal(row!.toRank, 2);
    assert.equal(row!.toRankName, "Vertex");
    assert.equal(row!.direction, "PROMOTED");
  });

  it("27. A DEMOTION IS RECORDED — rank is not monotonic", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    // resolveRank is a pure function of each epoch's inputs with no clamp against the previous
    // rank, so withdrawing stake or losing an active direct lowers it. Hiding that would
    // misrepresent the member's standing.
    await mkSnapshot({ rank: 1, previousRank: 4, epochId: EPOCH });
    const [row] = (await getRankHistory(U)).rows;
    assert.equal(row!.fromRank, 4);
    assert.equal(row!.toRank, 1);
    assert.equal(row!.direction, "DEMOTED");
  });

  it("28. a first snapshot above zero reads as a promotion from nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 1, previousRank: null, epochId: EPOCH });
    const [row] = (await getRankHistory(U)).rows;
    assert.equal(row!.fromRank, null);
    assert.equal(row!.direction, "PROMOTED");
  });

  it("29. a first snapshot at rank 0 is not a change", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 0, previousRank: null, epochId: EPOCH });
    assert.deepEqual((await getRankHistory(U)).rows, [], "never ranked is not a transition");
  });

  it("30. newest first, paginated by keyset", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    for (let i = 0; i < 5; i += 1) {
      await mkEpoch(EPOCH + i);
      await mkSnapshot({ rank: i + 1, previousRank: i, epochId: EPOCH + i });
    }
    const first = await getRankHistory(U, { limit: 2 });
    assert.deepEqual(first.rows.map((r) => r.epochId), [EPOCH + 4, EPOCH + 3]);
    assert.equal(first.nextCursor, EPOCH + 3);

    const second = await getRankHistory(U, { limit: 2, before: first.nextCursor! });
    assert.deepEqual(second.rows.map((r) => r.epochId), [EPOCH + 2, EPOCH + 1]);

    const last = await getRankHistory(U, { limit: 2, before: second.nextCursor! });
    assert.deepEqual(last.rows.map((r) => r.epochId), [EPOCH]);
    assert.equal(last.nextCursor, null);
  });

  it("31. the limit is clamped, so no unbounded scan is possible", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    for (let i = 0; i < 3; i += 1) {
      await mkEpoch(EPOCH + i);
      await mkSnapshot({ rank: i + 1, previousRank: i, epochId: EPOCH + i });
    }
    assert.equal((await getRankHistory(U, { limit: 99_999 })).rows.length, 3);
    assert.equal((await getRankHistory(U, { limit: 0 })).rows.length, 1);
  });

  it("32. another member's transitions never leak", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 9, previousRank: 3, epochId: EPOCH, userId: "someone-else" });
    assert.deepEqual((await getRankHistory(U)).rows, []);
  });

  it("33. carries no transaction hash — rank is calculated off chain", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 2, previousRank: 1, epochId: EPOCH });
    const [row] = (await getRankHistory(U)).rows;
    // There is no rank-promotion transaction, so there is no hash to show.
    assert.equal(Object.keys(row!).includes("txHash"), false);
    assert.equal(JSON.stringify(row).toLowerCase().includes("tx"), false);
  });
});

// ═══════════════════════════════════════════ ROUTES ════

describe("route surface", () => {
  /** The real routers on an ephemeral port — importing index.ts would open a second connection. */
  const withServer = async (fn: (base: string) => Promise<void>) => {
    const express = (await import("express")).default;
    const { rankRouter } = await import("./routes.js");
    const { toErrorBody } = await import("../../lib/errors.js");
    const app = express();
    app.use(express.json());
    app.use(rankRouter);
    app.use((
      error: unknown,
      _req: unknown,
      res: { status: (n: number) => { json: (b: unknown) => void } },
      _next: unknown,
    ) => {
      const { status, body } = toErrorBody(error);
      res.status(status).json(body);
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };

  const PATHS = ["/rewards/rank", "/rewards/rank/history"];

  it("34. both routes reject an anonymous caller", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withServer(async (base) => {
      for (const path of PATHS) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 401, path);
        assert.equal(((await res.json()) as { error: { code: string } }).error.code, "UNAUTHORIZED");
      }
    });
  });

  it("35. history validates its paging rather than coercing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { signSession } = await import("../../auth/jwt.js");
    const token = signSession({ sub: U, eoa: "0x6fe1fc915ef1d8197f79c79f0f262f1ca4d320c9" });
    await withServer(async (base) => {
      for (const [query, code] of [
        ["limit=0", "INVALID_LIMIT"], ["limit=101", "INVALID_LIMIT"],
        ["limit=abc", "INVALID_LIMIT"], ["before=-1", "INVALID_CURSOR"],
      ] as const) {
        const res = await fetch(`${base}/rewards/rank/history?${query}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 400, query);
        assert.equal(((await res.json()) as { error: { code: string } }).error.code, code, query);
      }
    });
  });

  it("36. the session decides whose rank is returned, not a parameter", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { signSession } = await import("../../auth/jwt.js");
    await mkEpoch(EPOCH);
    await mkSnapshot({ rank: 0, userId: "mine" });
    await mkSnapshot({ rank: 11, userId: "theirs" });
    const token = signSession({ sub: "mine", eoa: "0x6fe1fc915ef1d8197f79c79f0f262f1ca4d320c9" });
    await withServer(async (base) => {
      const res = await fetch(`${base}/rewards/rank?userId=theirs`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { currentRank: { rankNumber: number } };
      assert.equal(body.currentRank.rankNumber, 0, "no leak from the userId parameter");
    });
  });
});

/**
 * Which count the read model reports as qualifying.
 *
 * The row states its own rule, so a pre-rule snapshot keeps reporting active-stake directs while
 * a row settled under the onboarded rule reports onboarded directs. The API never asks the caller
 * to work out which applies.
 *
 * Uses the suite's own connection and per-test cleanup; no second lifecycle of its own.
 */
describe("rank read model reports the count that actually qualified", () => {
  it("a REGISTERED_EOA row reports registeredDirects, not the staked count", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    // Two registered directs, none of them staking: exactly the case the rule changed.
    await mkSnapshot({
      rank: 0,
      selfUSD6: 100n * USD,
      teamUSD6: 5_000n * USD,
      activeDirects: 0,
      registeredDirects: 2,
      directCount: 4,
      directRule: "REGISTERED_EOA",
      registrationBasis: "APPLICATION_TIMESTAMP",
    });

    const r = await getRankReadModel(U);
    assert.equal(r.currentRank!.directRule, "REGISTERED_EOA");
    assert.equal(r.currentRank!.registrationBasis, "APPLICATION_TIMESTAMP");
    assert.equal(r.currentRank!.registeredDirects, 2);
    assert.equal(r.currentRank!.activeDirects, 0, "retained for audit");
    assert.equal(r.currentRank!.directCount, 4, "retained for audit");
    assert.equal(r.currentRank!.qualifyingDirects, 2, "the figure that qualifies");

    // Nova needs 2 directs, and registration satisfies it with zero stake among them.
    const req = r.nextRank!.requirements.qualifyingDirects;
    assert.equal(req.current, "2");
    assert.equal(req.required, "2");
    assert.equal(req.met, true, "registration alone qualifies");
  });

  it("an ONBOARDED row keeps reporting what it was settled on", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    // A historical row. The rule is no longer computable, but a settled row must keep stating
    // its own semantics rather than being reinterpreted under today's rule.
    await mkSnapshot({
      rank: 0, selfUSD6: 100n * USD, teamUSD6: 5_000n * USD,
      activeDirects: 0, registeredDirects: 2, directCount: 4,
      directRule: "ONBOARDED", registrationBasis: "BLOCK",
    });

    const r = await getRankReadModel(U);
    assert.equal(r.currentRank!.directRule, "ONBOARDED");
    assert.equal(r.currentRank!.registrationBasis, "BLOCK");
    assert.equal(r.currentRank!.qualifyingDirects, 2, "the count it was qualified on");
  });

  it("a pre-rule row still reports the staked count, and says so", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    // No registeredDirects, no directRule — exactly how 41459-41461 were written.
    await mkSnapshot({ rank: 0, selfUSD6: 9_390_023_394n, activeDirects: 1, directCount: 4 });

    const r = await getRankReadModel(U);
    assert.equal(r.currentRank!.directRule, "ACTIVE_STAKE", "inferred from the absent field");
    assert.equal(r.currentRank!.registeredDirects, null, "never invented");
    assert.equal(r.currentRank!.registrationBasis, null);
    assert.equal(r.currentRank!.qualifyingDirects, 1, "the staked count, as settled");
    assert.equal(r.nextRank!.requirements.qualifyingDirects.current, "1");
  });
});
