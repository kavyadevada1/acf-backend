import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { assertDisposable, TEST_STAKING, TEST_WITHDRAWAL } from "./testenv.ts";

const TEST_URI = process.env.MONGODB_TEST_URI;

const { getClaimQuote } = await import("./quote.js");
const { getTeamRewards } = await import("../rewards/team/readModel.js");
const { stakeRewardSummaries } = await import("../rewards/stakeRewards.js");
const { getDAORevenueSummary, getDAORevenueHistory } = await import("../daoRevenue/readModel.js");
const { User } = await import("../models/User.js");
const { Stake } = await import("../models/Stake.js");
const { RewardEpoch } = await import("../models/RewardEpoch.js");
const { RewardPhase2Epoch } = await import("../models/RewardPhase2Epoch.js");
const { StakeRewardEntry } = await import("../models/StakeRewardEntry.js");
const { TeamRewardEntry } = await import("../models/TeamRewardEntry.js");
const { RewardSettlementCheckpoint } = await import("../models/RewardSettlementCheckpoint.js");
const { UserRewardCheckpoint } = await import("../models/UserRewardCheckpoint.js");
const { UserClaimState } = await import("../models/UserClaimState.js");
const { CheckpointSelfComponent } = await import("../models/CheckpointSelfComponent.js");
const { DAOContribution } = await import("../models/DAOContribution.js");
const { DAORevenueEpoch } = await import("../models/DAORevenueEpoch.js");
const { DAORevenueMemberEntry } = await import("../models/DAORevenueMemberEntry.js");
const { DAORevenuePayment } = await import("../models/DAORevenuePayment.js");

const E18 = 10n ** 18n;
const USD = 1_000_000n;
const P2 = 2n * E18;
const LOW = TEST_STAKING.toLowerCase();
const WD = TEST_WITHDRAWAL.toLowerCase();
const DAO_ADDR = "0x9cf32271e052cbbc1d6c564b6fe6a86b6ed08e45";
const DIST = "0xc152df6448fb68702b661c4ae210e41f5e76931e";
const SK = { chainId: 80002, stakingContractAddress: LOW };
const SETTLE = { chainId: 80002, withdrawalAddress: WD };
const MK = { chainId: 80002, distributorAddress: DIST };
const EPOCH = 41_459;

const WALLET = "0xf1967e700575cd8c6a7eaa593e7da470850f6a15";
const EOA = "0x6fe1fc915ef1d8197f79c79f0f262f1ca4d320c9";

/** Fee inputs and wallet position are injected, so no RPC is needed. */
const fakeReader = (over: Partial<{
  priceE18: bigint; percentageE6: bigint; balance: bigint; allowance: bigint;
}> = {}) => ({
  async claimFeeInputs() {
    return { priceE18: over.priceE18 ?? P2, percentageE6: over.percentageE6 ?? 150_000n };
  },
  async tokenDecimals() { return { acf: 18, usdt: 6 }; },
  async usdtPosition() {
    return { balance: over.balance ?? 1_000n * USD, allowance: over.allowance ?? 0n };
  },
}) as never;

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([
    User.init(), Stake.init(), RewardEpoch.init(), RewardPhase2Epoch.init(),
    StakeRewardEntry.init(), TeamRewardEntry.init(), RewardSettlementCheckpoint.init(),
    UserRewardCheckpoint.init(), UserClaimState.init(), CheckpointSelfComponent.init(),
    DAOContribution.init(), DAORevenueEpoch.init(), DAORevenueMemberEntry.init(),
    DAORevenuePayment.init(),
  ]);
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (!connected) return;
  await Promise.all([
    User.deleteMany({}), Stake.deleteMany({}), RewardEpoch.deleteMany({}),
    RewardPhase2Epoch.deleteMany({}), StakeRewardEntry.deleteMany({}),
    TeamRewardEntry.deleteMany({}), RewardSettlementCheckpoint.deleteMany({}),
    UserRewardCheckpoint.deleteMany({}), UserClaimState.deleteMany({}),
    CheckpointSelfComponent.deleteMany({}), DAOContribution.deleteMany({}),
    DAORevenueEpoch.deleteMany({}), DAORevenueMemberEntry.deleteMany({}),
    DAORevenuePayment.deleteMany({}),
  ]);
});

const mkUser = (userId: string, wallet?: string) =>
  User.collection.insertOne({
    userId, externalEOA: EOA, referralCode: `ACF-${userId}`, referredByUserId: null,
    ...(wallet ? { externalEOA: wallet } : {}),
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);

const mkEpoch = (epochId: number) =>
  RewardEpoch.collection.insertOne({
    ...SK, epochId, windowStart: 0, snapshotAt: epochId * 43_200, snapshotBlockNumber: 1,
    status: "CALCULATED", attempts: 1, priceE18: P2.toString(), poolROISnapshot: [],
    stakesProcessed: 0, stakesRewarded: 0, totalRegularSelfACF: "0", totalDAOStakeACF: "0",
  } as never);

const mkEntry = (o: {
  stakeId: string; userId: string; source: string; rewardACF: bigint; epochId?: number;
  rate?: string; principal?: bigint; reason?: string | null;
}) => StakeRewardEntry.collection.insertOne({
  ...SK, stakeId: o.stakeId, epochId: o.epochId ?? EPOCH, userId: o.userId,
  externalEOA: WALLET, source: o.source, poolId: 1,
  principalACF: (o.principal ?? 1000n * E18).toString(),
  compoundBaseACF: (o.principal ?? 1000n * E18).toString(),
  rewardACF: o.rewardACF.toString(), cumulativeEarnedACF: "0",
  rateApplied: o.rate ?? "2500", rateDenominator: "1000000",
  rewardEligible: o.reason == null, ineligibleReason: o.reason ?? null,
  snapshotAt: (o.epochId ?? EPOCH) * 43_200,
} as never);

const mkPublished = async (userId: string, self: bigint, team: bigint, claimed: bigint) => {
  await RewardSettlementCheckpoint.collection.insertOne({
    ...SETTLE, stakingContractAddress: LOW, treasuryAddress: WD, checkpointId: 900,
    legacy: false, status: "FINALIZED", previousCheckpointId: null,
    fromRewardEpochId: null, throughRewardEpochId: null, root: `0x${"a".repeat(64)}`,
    publishedCumulativeTotalACF: (self + team).toString(),
    publishedDeltaACF: (self + team).toString(), leafCount: 1, attempts: 1,
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);
  await UserRewardCheckpoint.collection.insertOne({
    ...SETTLE, checkpointId: 900, userId, externalEOA: WALLET,
    cumulativeSelfACF: self.toString(), cumulativeTeamACF: team.toString(),
    combinedCumulativeACF: (self + team).toString(),
    newSelfACF: "0", newTeamACF: "0",
    deferredReleasedSelfACF: "0", deferredReleasedTeamACF: "0",
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);
  await UserClaimState.collection.insertOne({
    ...SETTLE, userId, externalEOA: WALLET,
    alreadyClaimedACF: claimed.toString(),
    highestClaimedCheckpointId: claimed > 0n ? 900 : null,
    lastReconciledBlock: 1, lastReconciledAt: new Date(1),
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);
};

// ═══════════════════════════════════════════ CLAIM QUOTE ════

describe("claim quote", () => {
  it("1. nothing published quotes no fee, and is keyed to the caller's own address", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("u1");
    const q = await getClaimQuote("u1", fakeReader());
    assert.equal(q.status, "NOTHING_TO_CLAIM");
    assert.equal(q.claimable, false);
    assert.equal(q.reason, "NOT_YET_PUBLISHED");
    assert.equal(q.estimatedUsdtFee, null, "no fabricated fee");
    assert.equal(q.availableACF, "0");
    // The quote names the authenticated address: there is no second address it could read.
    assert.match(q.externalEOA, /^0x[0-9a-f]{40}$/);
  });

  it("2. NOTHING_TO_CLAIM when nothing is published", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("u1", WALLET);
    const q = await getClaimQuote("u1", fakeReader());
    assert.equal(q.status, "NOTHING_TO_CLAIM");
    assert.equal(q.reason, "NOT_YET_PUBLISHED");
    assert.equal(q.estimatedUsdtFee, null);
  });

  it("3. CLAIMABLE quotes available, fee, balance and allowance", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("u1", WALLET);
    await mkPublished("u1", 10n * E18, 2n * E18, 0n);
    const q = await getClaimQuote("u1", fakeReader());
    assert.equal(q.status, "CLAIMABLE");
    assert.equal(q.claimable, true);
    assert.equal(q.availableACF, (12n * E18).toString());
    // 12 ACF at $2 = $24, 15% = $3.60
    assert.equal(q.estimatedUsdtFee, (3_600_000n).toString());
    assert.equal(q.feePercentageLabel, "15");
    assert.equal(q.feeIsEstimate, true, "execution re-reads the live rate");
    assert.equal(q.withdrawalAllowance, "0");
    assert.equal(q.approvalRequired, true);
  });

  it("4. available uses PUBLISHED minus claimed, never earned", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("u1", WALLET);
    await mkPublished("u1", 10n * E18, 0n, 4n * E18);
    // Earned far exceeds published; it must not leak into the claim amount.
    await mkEpoch(EPOCH);
    await mkEntry({ stakeId: "1", userId: "u1", source: "DIRECT", rewardACF: 500n * E18 });
    const q = await getClaimQuote("u1", fakeReader());
    assert.equal(q.availableACF, (6n * E18).toString(), "10 published - 4 claimed");
    assert.notEqual(q.availableACF, (500n * E18).toString());
  });

  it("5. the claimed figure stays combined — no Self/Team split", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("u1", WALLET);
    await mkPublished("u1", 6n * E18, 4n * E18, 5n * E18);
    const q = await getClaimQuote("u1", fakeReader());
    assert.equal(q.alreadyClaimedACF, (5n * E18).toString());
    assert.equal(Object.keys(q).some((k) => /claimedSelf|claimedTeam/i.test(k)), false);
  });

  it("6. fully claimed reports FULLY_CLAIMED, not a zero fee", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("u1", WALLET);
    await mkPublished("u1", 5n * E18, 0n, 5n * E18);
    const q = await getClaimQuote("u1", fakeReader());
    assert.equal(q.status, "NOTHING_TO_CLAIM");
    assert.equal(q.reason, "FULLY_CLAIMED");
    assert.equal(q.estimatedUsdtFee, null);
  });

  for (const [band, pct, expected] of [
    ["15%", 150_000n, 3_000_000n], ["20%", 200_000n, 4_000_000n],
    ["25%", 250_000n, 5_000_000n], ["30%", 300_000n, 6_000_000n],
  ] as const) {
    it(`7-${band}. the live band is read, never assumed`, async (t) => {
      if (!connected) return t.skip("no MONGODB_TEST_URI");
      await mkUser("u1", WALLET);
      await mkPublished("u1", 10n * E18, 0n, 0n);          // 10 ACF at $2 = $20
      const q = await getClaimQuote("u1", fakeReader({ percentageE6: pct }));
      assert.equal(q.estimatedUsdtFee, expected.toString());
      assert.equal(q.feePercentageE6, pct.toString());
    });
  }

  it("8. a price change between quotes changes the fee", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("u1", WALLET);
    await mkPublished("u1", 10n * E18, 0n, 0n);
    const a = await getClaimQuote("u1", fakeReader({ priceE18: P2 }));
    const b = await getClaimQuote("u1", fakeReader({ priceE18: 4n * E18 }));
    assert.equal(a.estimatedUsdtFee, (3_000_000n).toString());
    assert.equal(b.estimatedUsdtFee, (6_000_000n).toString());
    assert.equal(a.availableACF, b.availableACF, "the entitlement itself is unchanged");
  });

  it("9. a sufficient allowance needs no approval", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("u1", WALLET);
    await mkPublished("u1", 10n * E18, 0n, 0n);
    const q = await getClaimQuote("u1", fakeReader({ allowance: 10n * USD }));
    assert.equal(q.approvalRequired, false);
    assert.equal(q.usdtShortfall, "0");
  });

  it("10. an insufficient USDT balance is reported as a shortfall", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("u1", WALLET);
    await mkPublished("u1", 10n * E18, 0n, 0n);
    const q = await getClaimQuote("u1", fakeReader({ balance: 1n * USD }));
    assert.equal(q.usdtShortfall, (2_000_000n).toString(), "needs $3, holds $1");
  });

  it("11. every financial field is a decimal string", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("u1", WALLET);
    await mkPublished("u1", 10n * E18, 1n * E18, 0n);
    const q = await getClaimQuote("u1", fakeReader());
    for (const k of ["publishedSelfACF","publishedTeamACF","alreadyClaimedACF","availableACF",
                     "estimatedUsdtFee","priceE18","claimantUsdtBalance","withdrawalAllowance"] as const) {
      assert.equal(typeof q[k], "string", k);
      assert.match(q[k] as string, /^\d+$/, k);
    }
  });
});

// ═══════════════════════════════════════════ PER-STAKE ════

describe("per-stake rewards", () => {
  const mkTeam = (userId: string, level: bigint, epochId = EPOCH) =>
    TeamRewardEntry.collection.insertOne({
      ...SK, epochId, userId,
      levelRewardACF: level.toString(), rankRewardACF: "0", globalRewardACF: "0",
      teamRewardACF: level.toString(),
      levelAudit: { unlockedLevels: 1, directCount: 1, perLevel: [] },
      rankAudit: {
        leaderRank: 0, leaderRateE6: "0", highestDownlineRank: 0, highestDownlineRateE6: "0",
        differentialRateE6: "0", teamRewardBaseACF: "0", grossACF: "0", epochCapUSD6: "0",
        capped: false,
      },
      globalAudit: {
        rankNumber: 2, selfStakeACF: "1", selfStakeUSD6: "2", l1StakeACF: "3", l1StakeUSD6: "4",
        networkContributionACF: "5", networkContributionUSD6: "6", priceE18: P2.toString(),
      },
    } as never);

  it("12. each source is reported on its own stake", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkEntry({ stakeId: "1", userId: "u1", source: "DIRECT", rewardACF: 1n * E18 });
    await mkEntry({ stakeId: "2", userId: "u1", source: "BOND", rewardACF: 2n * E18 });
    await mkEntry({ stakeId: "3", userId: "u1", source: "DAO", rewardACF: 3n * E18 });
    const r = await stakeRewardSummaries("u1", ["1", "2", "3"]);
    assert.equal(r.get("1")!.lifetimeEarnedACF, (1n * E18).toString());
    assert.equal(r.get("2")!.lifetimeEarnedACF, (2n * E18).toString());
    assert.equal(r.get("3")!.lifetimeEarnedACF, (3n * E18).toString(), "DAO-source IS Self reward");
  });

  it("13. lifetime sums every settled epoch for that stake only", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH); await mkEpoch(EPOCH + 1);
    await mkEntry({ stakeId: "1", userId: "u1", source: "DIRECT", rewardACF: 1n * E18 });
    await mkEntry({ stakeId: "1", userId: "u1", source: "DIRECT", rewardACF: 2n * E18, epochId: EPOCH + 1 });
    await mkEntry({ stakeId: "2", userId: "u1", source: "DIRECT", rewardACF: 9n * E18 });
    const r = await stakeRewardSummaries("u1", ["1", "2"]);
    assert.equal(r.get("1")!.lifetimeEarnedACF, (3n * E18).toString());
    assert.equal(r.get("1")!.settledEpochCount, 2);
    assert.equal(r.get("2")!.lifetimeEarnedACF, (9n * E18).toString(), "no cross-contamination");
  });

  it("14. an UNSETTLED epoch's rows are excluded", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkEntry({ stakeId: "1", userId: "u1", source: "DIRECT", rewardACF: 1n * E18 });
    // Rows exist for an epoch that never settled; they are not yet truth.
    await mkEntry({ stakeId: "1", userId: "u1", source: "DIRECT", rewardACF: 99n * E18, epochId: EPOCH + 5 });
    const r = await stakeRewardSummaries("u1", ["1"]);
    assert.equal(r.get("1")!.lifetimeEarnedACF, (1n * E18).toString());
  });

  it("15. a claim subtracts from unclaimed but not from lifetime", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkEntry({ stakeId: "1", userId: "u1", source: "DIRECT", rewardACF: 10n * E18 });
    await CheckpointSelfComponent.collection.insertOne({
      ...SETTLE, stakingContractAddress: LOW, checkpointId: 900, userId: "u1",
      externalEOA: WALLET, stakeId: "1", source: "DIRECT",
      rewardEpochId: EPOCH, rewardACF: (4n * E18).toString(),
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);
    await UserClaimState.collection.insertOne({
      ...SETTLE, userId: "u1", externalEOA: WALLET,
      alreadyClaimedACF: (4n * E18).toString(), highestClaimedCheckpointId: 900,
      lastReconciledBlock: 1, lastReconciledAt: new Date(1),
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);
    const r = await stakeRewardSummaries("u1", ["1"]);
    assert.equal(r.get("1")!.lifetimeEarnedACF, (10n * E18).toString(), "lifetime only grows");
    assert.equal(r.get("1")!.claimedACF, (4n * E18).toString());
    assert.equal(r.get("1")!.earnedUnclaimedACF, (6n * E18).toString());
  });

  it("16. a withdrawn stake reports its reason and earns nothing further", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    // Phase 1 stores rate 0 for an ineligible stake; the fixture matches production.
    await mkEntry({
      stakeId: "1", userId: "u1", source: "DIRECT", rewardACF: 0n, reason: "WITHDRAWN", rate: "0",
    });
    const r = await stakeRewardSummaries("u1", ["1"]);
    assert.equal(r.get("1")!.ineligibleReason, "WITHDRAWN");
    assert.equal(r.get("1")!.lifetimeEarnedACF, "0");
    assert.equal(r.get("1")!.estimatedDailyACF, null, "no daily figure for a dead position");
  });

  it("17. TOO_YOUNG is reported without implying a withdrawal", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkEntry({ stakeId: "1", userId: "u1", source: "DAO", rewardACF: 0n, reason: "TOO_YOUNG" });
    const r = await stakeRewardSummaries("u1", ["1"]);
    assert.equal(r.get("1")!.ineligibleReason, "TOO_YOUNG");
  });

  it("18. a stake with no settled epoch gets zeros and nulls, not fabrications", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const r = await stakeRewardSummaries("u1", ["404"]);
    const s = r.get("404")!;
    assert.equal(s.lifetimeEarnedACF, "0");
    assert.equal(s.settledEpochCount, 0);
    assert.equal(s.latestEpochRewardACF, null);
    assert.equal(s.estimatedDailyACF, null);
    assert.equal(s.compoundBaseACF, null);
  });

  it("19. the daily estimate is two epochs at the DAILY rate, not four halves", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    // 1000 ACF principal, DAO fixed 1%/day (rateApplied stores the daily rate).
    await mkEntry({
      stakeId: "1", userId: "u1", source: "DAO", rewardACF: 5n * E18,
      rate: "10000", principal: 1000n * E18,
    });
    const s = (await stakeRewardSummaries("u1", ["1"])).get("1")!;
    // base = 1000 + 5 unclaimed = 1005; one day at 1% = 10.05 ACF
    assert.equal(s.compoundBaseACF, (1005n * E18).toString());
    assert.equal(s.latestRateE6, "10000");
    assert.equal(s.estimatedDailyACF, (10n * E18 + E18 / 20n).toString(), "10.05 ACF");
  });

  it("20. per-stake NEVER contains Team reward", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkEntry({ stakeId: "1", userId: "u1", source: "DIRECT", rewardACF: 1n * E18 });
    await mkTeam("u1", 500n * E18);                 // a large Team reward
    const s = (await stakeRewardSummaries("u1", ["1"])).get("1")!;
    assert.equal(s.lifetimeEarnedACF, (1n * E18).toString(), "Team is user-level, not per-stake");
  });

  it("21. per-stake NEVER contains DAO member revenue", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkEpoch(EPOCH);
    await mkEntry({ stakeId: "1", userId: "u1", source: "DAO", rewardACF: 1n * E18 });
    await DAORevenueMemberEntry.collection.insertOne({
      ...MK, daoContractAddress: DAO_ADDR, epochId: EPOCH, userId: "u1",
      externalEOA: WALLET,
      activeContributionUSDT6: "1", totalEligibleContributionUSDT6: "1",
      activeContributionCount: 1, memberRevenueRateE6: "50000",
      systemRevenueUSD6: "1", daoRevenuePoolUSD6: "1", priceE18: P2.toString(),
      memberRevenueUSD6: "1", memberRevenueACF: (700n * E18).toString(), batchIndex: 0,
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);
    const s = (await stakeRewardSummaries("u1", ["1"])).get("1")!;
    assert.equal(s.lifetimeEarnedACF, (1n * E18).toString(), "DAO revenue is a separate system");
  });
});

// ════════════════════════════════════════════════ TEAM ════

describe("team read model", () => {
  const mkPhase2 = (epochId: number) =>
    RewardPhase2Epoch.collection.insertOne({
      ...SK, epochId, status: "CALCULATED", attempts: 1,
      snapshotAt: epochId * 43_200, priceE18: P2.toString(),
    } as never);

  const mkTeamRow = (userId: string, epochId: number, level: bigint, rank: bigint, global: bigint) =>
    TeamRewardEntry.collection.insertOne({
      ...SK, epochId, userId,
      levelRewardACF: level.toString(), rankRewardACF: rank.toString(),
      globalRewardACF: global.toString(),
      teamRewardACF: (level + rank + global).toString(),
      levelAudit: { unlockedLevels: 3, directCount: 3, perLevel: [] },
      rankAudit: {
        leaderRank: 2, leaderRateE6: "0", highestDownlineRank: 1, highestDownlineRateE6: "0",
        differentialRateE6: "0", teamRewardBaseACF: "0", grossACF: "0", epochCapUSD6: "0",
        capped: false,
      },
      globalAudit: {
        rankNumber: 4, selfStakeACF: "100", selfStakeUSD6: "200",
        l1StakeACF: "300", l1StakeUSD6: "400",
        networkContributionACF: "500", networkContributionUSD6: "600",
        priceE18: P2.toString(),
      },
    } as never);

  it("22. lifetime sums Level, Rank and Global separately", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase2(EPOCH); await mkPhase2(EPOCH + 1);
    await mkTeamRow("u1", EPOCH, 1n * E18, 2n * E18, 3n * E18);
    await mkTeamRow("u1", EPOCH + 1, 4n * E18, 5n * E18, 6n * E18);
    const t2 = await getTeamRewards("u1");
    assert.equal(t2.lifetime.levelACF, (5n * E18).toString());
    assert.equal(t2.lifetime.rankACF, (7n * E18).toString());
    assert.equal(t2.lifetime.globalACF, (9n * E18).toString());
    assert.equal(t2.lifetime.totalTeamACF, (21n * E18).toString());
    assert.equal(t2.lifetime.epochCount, 2);
  });

  it("23. the latest epoch carries the HISTORICAL global audit, not current state", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase2(EPOCH);
    await mkTeamRow("u1", EPOCH, 1n * E18, 0n, 2n * E18);
    const t2 = await getTeamRewards("u1");
    const a = t2.latestEpoch!.globalAudit!;
    assert.equal(a.rankNumber, 4);
    assert.equal(a.selfStakeUSD6, "200");
    assert.equal(a.l1StakeUSD6, "400");
    assert.equal(a.networkContributionUSD6, "600");
    assert.equal(a.priceE18, P2.toString(), "the price used THEN");
  });

  it("24. an unsettled Phase 2 epoch is excluded", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkPhase2(EPOCH);
    await mkTeamRow("u1", EPOCH, 1n * E18, 0n, 0n);
    await mkTeamRow("u1", EPOCH + 9, 99n * E18, 0n, 0n);   // no Phase2Epoch row
    const t2 = await getTeamRewards("u1");
    assert.equal(t2.lifetime.levelACF, (1n * E18).toString());
  });

  it("25. a user with nothing published still sees earned Team reward", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkUser("u1");                              // registered, nothing published yet
    await mkPhase2(EPOCH);
    await mkTeamRow("u1", EPOCH, 7n * E18, 0n, 0n);
    const t2 = await getTeamRewards("u1");
    assert.equal(t2.lifetime.levelACF, (7n * E18).toString(),
      "Level Income is deferred, not forfeited — never reported as zero");
  });

  it("26. no Team rows gives zeros and a null latest epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const t2 = await getTeamRewards("nobody");
    assert.equal(t2.lifetime.totalTeamACF, "0");
    assert.equal(t2.latestEpoch, null);
  });
});

// ═════════════════════════════════════════ DAO REVENUE ════

describe("DAO revenue read model", () => {
  const mkDaoEpoch = (epochId: number, systemUSD6: string, poolUSD6: string) =>
    DAORevenueEpoch.collection.insertOne({
      chainId: 80002, daoContractAddress: DAO_ADDR, distributorAddress: DIST, epochId,
      stakingContractAddress: LOW, treasuryAddress: WD,
      windowStart: 0, snapshotAt: epochId * 43_200, snapshotBlockNumber: 1,
      priceE18: P2.toString(),
      systemRegularSelfACF: "0", systemDAOStakeRewardACF: "0", systemSelfRewardACF: "0",
      systemRevenueUSD6: systemUSD6, revenueEnabledAtSnapshot: true,
      silverMinimumUSDT6: (5_000n * USD).toString(), goldMinimumUSDT6: "0",
      memberRevenueRateE6: "50000", configBlockNumber: 1, configLogIndex: 0,
      daoRevenuePoolUSD6: poolUSD6, totalEligibleContributionUSDT6: (5_000n * USD).toString(),
      totalMemberRevenueUSD6: "0", totalMemberRevenueACF: "0", roundingDustUSD6: "0",
      eligibleMembers: 1, batchCount: 1, manifestHash: `0x${"0".repeat(64)}`,
      status: "COMPLETED", attempts: 1, paidMembers: 1,
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);

  const mkMember = (userId: string, epochId: number, acf: bigint, usd6 = "100") =>
    DAORevenueMemberEntry.collection.insertOne({
      ...MK, daoContractAddress: DAO_ADDR, epochId, userId,
      externalEOA: WALLET,
      activeContributionUSDT6: (5_000n * USD).toString(),
      totalEligibleContributionUSDT6: (5_000n * USD).toString(),
      activeContributionCount: 1, memberRevenueRateE6: "50000",
      systemRevenueUSD6: "1", daoRevenuePoolUSD6: "1", priceE18: P2.toString(),
      memberRevenueUSD6: usd6, memberRevenueACF: acf.toString(), batchIndex: 0,
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);

  const mkPaid = (userId: string, epochId: number, acf: bigint, tx: string) =>
    DAORevenuePayment.collection.insertOne({
      ...MK, epochId, userId, externalEOA: WALLET,
      expectedAmountACF: acf.toString(), amountPaidACF: acf.toString(),
      txHash: tx, logIndex: 0, blockNumber: 49_274_232, blockTimestamp: 1_791_000_000,
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);

  it("27. THE LIVE FIXTURE — epochs 41459 + 41460 total 0.888795845523831955 ACF", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkDaoEpoch(41_459, "2235757", "111787");
    await mkDaoEpoch(41_460, "46809350", "2340467");
    await mkMember("u1", 41_459, 40_516_121_569_614_160n);
    await mkMember("u1", 41_460, 848_279_723_954_217_795n);
    await mkPaid("u1", 41_459, 40_516_121_569_614_160n, `0x${"a".repeat(64)}`);
    await mkPaid("u1", 41_460, 848_279_723_954_217_795n, `0x${"b".repeat(64)}`);

    const s = await getDAORevenueSummary("u1");
    assert.equal(s.totalCalculatedRevenueACF, "888795845523831955");
    assert.equal(s.totalPaidRevenueACF, "888795845523831955");
    assert.equal(s.pendingRevenueACF, "0");
    assert.equal(s.distributionsCount, 2);
    assert.equal(s.paidCount, 2);
    assert.equal(s.latestDistribution!.epochId, 41_460, "newest first");
  });

  it("28. CALCULATED without a payment is PENDING_PAYOUT, never 'received'", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkDaoEpoch(EPOCH, "1000", "50");
    await mkMember("u1", EPOCH, 5n * E18);
    const s = await getDAORevenueSummary("u1");
    assert.equal(s.totalCalculatedRevenueACF, (5n * E18).toString());
    assert.equal(s.totalPaidRevenueACF, "0");
    assert.equal(s.pendingRevenueACF, (5n * E18).toString());
    assert.equal(s.paidCount, 0);
    const h = await getDAORevenueHistory("u1");
    assert.equal(h.rows[0]!.status, "PENDING_PAYOUT");
    assert.equal(h.rows[0]!.txHash, null);
    assert.equal(h.rows[0]!.amountPaidACF, null);
  });

  it("29. a wallet transfer with NO payment row does not count", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkDaoEpoch(EPOCH, "1000", "50");
    // No member entry and no payment: whatever arrived in the wallet is not DAO revenue.
    const s = await getDAORevenueSummary("u1");
    assert.equal(s.totalCalculatedRevenueACF, "0");
    assert.equal(s.totalPaidRevenueACF, "0");
    assert.equal(s.distributionsCount, 0);
    assert.equal(s.latestDistribution, null);
  });

  it("30. another member's revenue never leaks", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkDaoEpoch(EPOCH, "1000", "50");
    await mkMember("someone-else", EPOCH, 500n * E18);
    await mkPaid("someone-else", EPOCH, 500n * E18, `0x${"c".repeat(64)}`);
    const s = await getDAORevenueSummary("u1");
    assert.equal(s.distributionsCount, 0);
    const h = await getDAORevenueHistory("u1");
    assert.equal(h.rows.length, 0);
  });

  it("31. history carries the epoch's system and pool figures for context", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkDaoEpoch(41_459, "2235757", "111787");
    await mkMember("u1", 41_459, 40_516_121_569_614_160n);
    const h = await getDAORevenueHistory("u1");
    const r = h.rows[0]!;
    assert.equal(r.systemRevenueUSD6, "2235757");
    assert.equal(r.daoRevenuePoolUSD6, "111787");
    assert.equal(r.activeContributionUSDT6, (5_000n * USD).toString());
    assert.equal(r.snapshotAt, 41_459 * 43_200);
  });

  it("32. history is newest first and pages by keyset", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    for (let i = 0; i < 5; i += 1) {
      await mkDaoEpoch(41_450 + i, "1000", "50");
      await mkMember("u1", 41_450 + i, BigInt(i + 1) * E18);
    }
    const first = await getDAORevenueHistory("u1", { limit: 2 });
    assert.deepEqual(first.rows.map((r) => r.epochId), [41_454, 41_453]);
    assert.equal(first.nextCursor, 41_453);

    const second = await getDAORevenueHistory("u1", { limit: 2, before: first.nextCursor! });
    assert.deepEqual(second.rows.map((r) => r.epochId), [41_452, 41_451]);

    const last = await getDAORevenueHistory("u1", { limit: 2, before: second.nextCursor! });
    assert.deepEqual(last.rows.map((r) => r.epochId), [41_450]);
    assert.equal(last.nextCursor, null, "no cursor on the final page");
  });

  it("33. the limit is clamped, so no unbounded scan is possible", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    for (let i = 0; i < 3; i += 1) {
      await mkDaoEpoch(41_450 + i, "1", "1");
      await mkMember("u1", 41_450 + i, E18);
    }
    // Clamped to 100 above and to 1 below, so neither an unbounded scan nor an empty page is
    // reachable. The route rejects anything outside 1..100 before it gets here anyway.
    assert.equal((await getDAORevenueHistory("u1", { limit: 99_999 })).rows.length, 3);
    assert.equal((await getDAORevenueHistory("u1", { limit: 0 })).rows.length, 1);
  });

  it("34. active contribution comes from contributions, not from a balance", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await DAOContribution.collection.insertOne({
      eventId: "e1", chainId: 80002, daoContractAddress: DAO_ADDR, contributionId: "1",
      userId: "u1", externalEOA: WALLET,
      usdtContributed: (5_000n * USD).toString(), acfStaked: "1", executionPriceE18: "1",
      daoPoolId: 6, stakingContractAddress: LOW, stakeId: "8",
      txHash: `0x${"d".repeat(64)}`, blockNumber: 1, logIndex: 0, blockTimestamp: new Date(1),
      lastKnownActive: true, createdAt: new Date(1), updatedAt: new Date(1),
    } as never);
    const s = await getDAORevenueSummary("u1");
    assert.equal(s.activeContributionUSDT6, (5_000n * USD).toString());
  });

  it("35. every financial field is a decimal string", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkDaoEpoch(EPOCH, "1000", "50");
    await mkMember("u1", EPOCH, 5n * E18);
    await mkPaid("u1", EPOCH, 5n * E18, `0x${"e".repeat(64)}`);
    const s = await getDAORevenueSummary("u1");
    for (const k of ["activeContributionUSDT6","totalCalculatedRevenueACF",
                     "totalPaidRevenueACF","pendingRevenueACF"] as const) {
      assert.match(s[k], /^\d+$/, k);
    }
    const r = (await getDAORevenueHistory("u1")).rows[0]!;
    for (const k of ["memberRevenueACF","memberRevenueUSD6","activeContributionUSDT6"] as const) {
      assert.match(r[k], /^\d+$/, k);
    }
  });
});

// ═══════════════════════════════════════════════ ROUTES ════

describe("route surface", () => {
  /**
   * The real routers on an ephemeral port, driven with fetch — no new test dependency.
   *
   * Mounted directly rather than through createApp(): importing index.ts runs its startup side
   * effects, which open a second mongoose connection and fight the test's own. That the routers
   * are actually mounted in the app is asserted separately, from source.
   */
  const withServer = async (fn: (base: string) => Promise<void>) => {
    const express = (await import("express")).default;
    const { settlementRouter } = await import("./routes.js");
    const { daoRevenueRouter } = await import("../daoRevenue/routes.js");
    const { toErrorBody } = await import("../lib/errors.js");
    const app = express();
    app.use(express.json());
    app.use(settlementRouter);
    app.use(daoRevenueRouter);
    // index.ts defines its handler inline; this reuses the same toErrorBody conversion, so the
    // status and code a client sees are the production ones.
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

  const NEW_ROUTES = [
    "/rewards/claim-quote",
    "/rewards/team",
    "/dao-revenue/summary",
    "/dao-revenue/history",
  ];

  it("36a. the new routers are mounted in the application", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { readFileSync } = await import("node:fs");
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    assert.match(index, /app\.use\(settlementRouter\)/, "settlement routes reachable");
    assert.match(index, /app\.use\(daoRevenueRouter\)/, "dao revenue routes reachable");
  });

  it("36. every new route rejects an anonymous caller", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withServer(async (base) => {
      for (const path of NEW_ROUTES) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 401, `${path} must require auth`);
        // The API's single envelope is { error: { code, message } }.
        const body = await res.json() as { error?: { code?: string } };
        assert.equal(body.error?.code, "UNAUTHORIZED", path);
      }
    });
  });

  it("37. a malformed bearer token is rejected, not treated as anonymous", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withServer(async (base) => {
      for (const path of NEW_ROUTES) {
        const res = await fetch(`${base}${path}`, {
          headers: { authorization: "Bearer not-a-real-token" },
        });
        assert.ok(res.status === 401, `${path} returned ${res.status}`);
      }
    });
  });

  it("38. history rejects an invalid limit and cursor rather than coercing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { signSession } = await import("../auth/jwt.js");
    const token = signSession({ sub: "u1", eoa: EOA });
    await withServer(async (base) => {
      for (const [query, code] of [
        ["limit=0", "INVALID_LIMIT"], ["limit=101", "INVALID_LIMIT"],
        ["limit=abc", "INVALID_LIMIT"], ["before=-1", "INVALID_CURSOR"],
        ["before=xyz", "INVALID_CURSOR"],
      ] as const) {
        const res = await fetch(`${base}/dao-revenue/history?${query}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 400, query);
        assert.equal((await res.json() as { error: { code: string } }).error.code, code, query);
      }
    });
  });

  it("39. an authenticated caller gets its OWN data, with no userId parameter honoured", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { signSession } = await import("../auth/jwt.js");
    await mkUser("mine", WALLET);
    await DAORevenueMemberEntry.collection.insertOne({
      ...MK, daoContractAddress: DAO_ADDR, epochId: EPOCH, userId: "theirs",
      externalEOA: WALLET,
      activeContributionUSDT6: "1", totalEligibleContributionUSDT6: "1",
      activeContributionCount: 1, memberRevenueRateE6: "50000",
      systemRevenueUSD6: "1", daoRevenuePoolUSD6: "1", priceE18: P2.toString(),
      memberRevenueUSD6: "1", memberRevenueACF: (900n * E18).toString(), batchIndex: 0,
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);

    const token = signSession({ sub: "mine", eoa: EOA });
    await withServer(async (base) => {
      // Even asked for someone else explicitly, the session decides.
      const res = await fetch(`${base}/dao-revenue/summary?userId=theirs`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { totalCalculatedRevenueACF: string };
      assert.equal(body.totalCalculatedRevenueACF, "0", "no leak from the userId parameter");
    });
  });
});
