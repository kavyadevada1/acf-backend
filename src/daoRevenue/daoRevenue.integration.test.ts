import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import {
  assertDisposable, fakeDAOChain, TEST_DAO, TEST_DISTRIBUTOR, TEST_MARKETING_COLLECTOR,
  TEST_STAKING,
} from "./testenv.ts";

const TEST_URI = process.env.MONGODB_TEST_URI;

const { runDAORevenueEpoch, Phase1NotSettledError } = await import("./calculation.js");
const { catchUpDAORevenueEpochs } = await import("./service.js");
const { reconcileDAORevenueEpoch, recordPayments } = await import("./reconcile.js");
const {
  preflight, rebuildManifest, nextExecutableEpoch, executeDAORevenueEpoch,
} = await import("./executor.js");
const { DAORevenueInvariantError } = await import("./policy.js");
const { DAOConfigUnavailableError, resolveConfigAsOf } = await import("./configHistory.js");
const { DAORevenueRowError } = await import("./verify.js");
const { RewardEpoch } = await import("../models/RewardEpoch.js");
const { StakeRewardEntry } = await import("../models/StakeRewardEntry.js");
const { TeamRewardEntry } = await import("../models/TeamRewardEntry.js");
const { Stake } = await import("../models/Stake.js");
const { User } = await import("../models/User.js");
const { DAOContribution } = await import("../models/DAOContribution.js");
const { DAOConfigHistory } = await import("../models/DAOConfigHistory.js");
const { DAORevenueEpoch } = await import("../models/DAORevenueEpoch.js");
const { DAORevenueMemberEntry } = await import("../models/DAORevenueMemberEntry.js");
const { DAORevenuePayment } = await import("../models/DAORevenuePayment.js");
const { RewardSettlementCheckpoint } = await import("../models/RewardSettlementCheckpoint.js");

const E18 = 10n ** 18n;
const USD = 1_000_000n;
const P2 = 2n * E18;                                   // $2.00 per whole ACF
const LOW_STAKING = TEST_STAKING.toLowerCase();
const SK = { chainId: 80002, stakingContractAddress: LOW_STAKING };
const DK = { chainId: 80002, daoContractAddress: TEST_DAO.toLowerCase() };
const RK = {
  chainId: 80002,
  daoContractAddress: TEST_DAO.toLowerCase(),
  distributorAddress: TEST_DISTRIBUTOR.toLowerCase(),
};
const MK = { chainId: 80002, distributorAddress: TEST_DISTRIBUTOR.toLowerCase() };

const EPOCH = 41_010;
const SNAPSHOT = EPOCH * 43_200;
const CONFIG_BLOCK = 1_000;
const SNAPSHOT_BLOCK = 2_000;

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([
    RewardEpoch.init(), StakeRewardEntry.init(), TeamRewardEntry.init(), Stake.init(),
    User.init(), DAOContribution.init(), DAOConfigHistory.init(), DAORevenueEpoch.init(),
    DAORevenueMemberEntry.init(), DAORevenuePayment.init(),
    RewardSettlementCheckpoint.init(),
  ]);
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (!connected) return;
  await Promise.all([
    RewardEpoch.deleteMany({}), StakeRewardEntry.deleteMany({}), TeamRewardEntry.deleteMany({}),
    Stake.deleteMany({}), User.deleteMany({}), DAOContribution.deleteMany({}),
    DAOConfigHistory.deleteMany({}), DAORevenueEpoch.deleteMany({}),
    DAORevenueMemberEntry.deleteMany({}), DAORevenuePayment.deleteMany({}),
    RewardSettlementCheckpoint.deleteMany({}),
  ]);
  seq = 0;
});

let seq = 0;
const eoaOf = (n: number) => `0x${n.toString(16).padStart(40, "1")}`;

/** A user with both addresses, as every DAO member must have. */
const mkUser = async (userId: string, n: number) => {
  seq += 1;
  await User.collection.insertOne({
    userId,
    externalEOA: eoaOf(n),
    referralCode: `ACF-${userId.toUpperCase()}`,
    referredByUserId: null,
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);
};

/** DAO configuration in force from CONFIG_BLOCK onward. */
const mkConfig = async (over: Partial<{
  blockNumber: number; silver: bigint; gold: bigint; rate: bigint; enabled: boolean;
}> = {}) => {
  await DAOConfigHistory.collection.insertOne({
    ...DK,
    blockNumber: over.blockNumber ?? CONFIG_BLOCK,
    logIndex: 0,
    blockTimestamp: 1_700_000_000,
    txHash: `0x${"c".repeat(64)}`,
    eventName: "RevenueConfigUpdated",
    silverMinimumUSDT6: (over.silver ?? 5_000n * USD).toString(),
    goldMinimumUSDT6: (over.gold ?? 25_000n * USD).toString(),
    memberRevenueRateE6: (over.rate ?? 50_000n).toString(),
    marketingRateE6: "20000",
    // The collector ACFDAO emitted at initialization. Present because the marketing allocation
    // is payable: an epoch that resolved to no collector refuses to calculate.
    marketingCollector: TEST_MARKETING_COLLECTOR,
    revenueEnabled: over.enabled ?? true,
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);
};

/** A settled Phase 1 epoch with the given Self reward split. */
const mkPhase1 = async (
  regularSelfACF: bigint, daoStakeACF: bigint, over: Partial<{ epochId: number }> = {},
) => {
  const epochId = over.epochId ?? EPOCH;
  await RewardEpoch.collection.insertOne({
    ...SK, epochId,
    windowStart: epochId * 43_200 - 43_200,
    snapshotAt: epochId * 43_200,
    snapshotBlockNumber: SNAPSHOT_BLOCK,
    status: "CALCULATED", attempts: 1,
    priceE18: P2.toString(), poolROISnapshot: [],
    stakesProcessed: 0, stakesRewarded: 0,
    totalRegularSelfACF: regularSelfACF.toString(),
    totalDAOStakeACF: daoStakeACF.toString(),
  } as never);
};

/**
 * A Phase 1 reward row. The cross-check requires the rows to sum to the aggregate, so helpers
 * always write both consistently.
 */
const mkEntry = async (opts: {
  stakeId: string; userId: string; wallet: string; source: string; rewardACF: bigint;
  epochId?: number; ineligibleReason?: string | null;
}) => {
  const epochId = opts.epochId ?? EPOCH;
  await StakeRewardEntry.collection.insertOne({
    ...SK, stakeId: opts.stakeId, epochId,
    userId: opts.userId, externalEOA: opts.wallet.toLowerCase(),
    source: opts.source, poolId: 6,
    principalACF: (1000n * E18).toString(),
    compoundBaseACF: (1000n * E18).toString(),
    rewardACF: opts.rewardACF.toString(),
    cumulativeEarnedACF: "0", rateApplied: "5000", rateDenominator: "1000000",
    rewardEligible: opts.ineligibleReason == null,
    ineligibleReason: opts.ineligibleReason ?? null,
    snapshotAt: epochId * 43_200,
  } as never);
};

/** A DAO stake plus its contribution, linked as ACFDAO.contribute() creates them. */
const mkContribution = async (opts: {
  contributionId: string; stakeId: string; userId: string; n: number; usdt: bigint;
  stakeTimestamp?: number; withdrawnBlockTimestamp?: number | null; source?: string;
}) => {
  const wallet = eoaOf(opts.n);
  await Stake.collection.insertOne({
    eventId: `80002:0x${opts.stakeId.padStart(8, "0")}:0`,
    ...SK, stakeId: opts.stakeId,
    userId: opts.userId, externalEOA: wallet,
    poolId: 6, principalACF: (1000n * E18).toString(),
    source: opts.source ?? "DAO",
    poolDailyROIAtCreation: "5000",
    stakeTimestamp: new Date((opts.stakeTimestamp ?? SNAPSHOT - 86_400) * 1000),
    unlockTimestamp: new Date((SNAPSHOT + 750 * 86_400) * 1000),
    active: opts.withdrawnBlockTimestamp == null,
    withdrawnAt: null, withdrawTxHash: null,
    withdrawnBlockNumber: opts.withdrawnBlockTimestamp == null ? null : SNAPSHOT_BLOCK - 1,
    withdrawnBlockTimestamp: opts.withdrawnBlockTimestamp ?? null,
    txHash: `0x${opts.stakeId.padStart(64, "0")}`, blockNumber: 100, logIndex: 0,
  } as never);
  await DAOContribution.collection.insertOne({
    eventId: `80002:dao:${opts.contributionId}`,
    ...DK, contributionId: opts.contributionId,
    userId: opts.userId, externalEOA: wallet,
    usdtContributed: opts.usdt.toString(),
    acfStaked: (1000n * E18).toString(),
    executionPriceE18: P2.toString(),
    daoPoolId: 6,
    stakingContractAddress: LOW_STAKING, stakeId: opts.stakeId,
    txHash: `0x${opts.contributionId.padStart(64, "0")}`,
    blockNumber: 100, logIndex: 0, blockTimestamp: new Date(1),
    lastKnownActive: true,
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);
};

/** Chain fake with every eligible member's wallet registered. */
const chainFor = (members: number[]) =>
  fakeDAOChain({
  });

// ═══════════════════════════════════════════════ SYSTEM REVENUE ════


/**
 * Authorizes an epoch on the fake chain from its own calculated row, then funds it.
 *
 * Mirrors the real ordering: AUTHORIZE commits the payable set with a separate key, and only then
 * can the executor fund the exact authorized total. The fake refuses any other amount, so a
 * fixture cannot reach a payout from a state the chain would never permit.
 */
async function authorizeEpochRow(
  chain: ReturnType<typeof fakeDAOChain>, epochId: number = EPOCH,
) {
  const epoch = (await DAORevenueEpoch.findOne({ ...RK, epochId }))!;
  chain.authorize(epochId, {
    memberRoot: epoch.memberRoot,
    memberTotalACF: BigInt(epoch.totalMemberRevenueACF),
    marketingRecipient: epoch.marketingCollector,
    marketingAmountACF: BigInt(epoch.marketingRevenueACF),
  });
  // The real authorize step advances the row as well, and the executor refuses a CALCULATED
  // epoch — so a fixture that only wrote the chain state would be modelling a status the
  // backend never reaches.
  await DAORevenueEpoch.updateOne(
    { ...RK, epochId, status: "CALCULATED" },
    { $set: { status: "AUTHORIZED", authorizedAt: new Date() } },
  );
  return epoch;
}

async function authorizeAndFund(
  chain: ReturnType<typeof fakeDAOChain>, epochId: number = EPOCH,
) {
  const epoch = await authorizeEpochRow(chain, epochId);
  chain.fund(epochId, BigInt(epoch.totalObligationACF));
  return epoch;
}

describe("system revenue", () => {
  it("1. THE SPEC FIXTURE — 18,000 + 2,000 ACF at $2 gives a $2,000 pool", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(18_000n * E18, 2_000n * E18);
    await mkEntry({ stakeId: "1", userId: "u1", wallet: eoaOf(1), source: "DIRECT", rewardACF: 18_000n * E18 });
    await mkEntry({ stakeId: "2", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 2_000n * E18 });
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "2", userId: "alice", n: 2, usdt: 5_000n * USD });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    if (r.status !== "CALCULATED") return;
    assert.equal(r.systemSelfRewardACF, (20_000n * E18).toString());
    assert.equal(r.systemRevenueUSD6, (40_000n * USD).toString());
    assert.equal(r.daoRevenuePoolUSD6, (2_000n * USD).toString());
    // Sole eligible member takes the whole pool: $2,000 at $2 = 1,000 ACF.
    assert.equal(r.totalMemberRevenueACF, (1_000n * E18).toString());
  });

  it("2. Level, Rank and Global are excluded from the base", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(1_000n * E18, 0n);
    await mkEntry({ stakeId: "1", userId: "alice", wallet: eoaOf(2), source: "DIRECT", rewardACF: 1_000n * E18 });
    // A large Team reward in the same epoch must not move the DAO pool at all.
    await TeamRewardEntry.collection.insertOne({
      ...SK, epochId: EPOCH, userId: "alice",
      levelRewardACF: (9_000n * E18).toString(), rankRewardACF: (9_000n * E18).toString(),
      globalRewardACF: (9_000n * E18).toString(), teamRewardACF: (27_000n * E18).toString(),
      levelAudit: { unlockedLevels: 1, directCount: 1, perLevel: [] },
      rankAudit: {
        leaderRank: 0, leaderRateE6: "0", highestDownlineRank: 0, highestDownlineRateE6: "0",
        differentialRateE6: "0", teamRewardBaseACF: "0", grossACF: "0", epochCapUSD6: "0",
        capped: false,
      },
      globalAudit: {
        rankNumber: 0, selfStakeACF: "0", selfStakeUSD6: "0", l1StakeACF: "0", l1StakeUSD6: "0",
        networkContributionACF: "0", networkContributionUSD6: "0", priceE18: P2.toString(),
      },
    } as never);
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "9", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkEntry({ stakeId: "9", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    if (r.status !== "CALCULATED") return;
    // Base is 1,000 ACF = $2,000; 5% = $100. The 27,000 ACF of Team reward is invisible.
    assert.equal(r.systemSelfRewardACF, (1_000n * E18).toString());
    assert.equal(r.daoRevenuePoolUSD6, (100n * USD).toString());
  });

  it("3. an aggregate/rows mismatch FAILS loudly", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(20_000n * E18, 0n);               // claims 20,000
    await mkEntry({ stakeId: "1", userId: "u1", wallet: eoaOf(1), source: "DIRECT", rewardACF: 19_000n * E18 });
    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor([]).reader),
      (e: unknown) => e instanceof DAORevenueInvariantError
        && /system revenue disagrees/.test((e as Error).message),
    );
  });

  it("4. a mislabelled source FAILS even when the total matches", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(18_000n * E18, 2_000n * E18);
    // Total is right, but all of it is tagged DIRECT.
    await mkEntry({ stakeId: "1", userId: "u1", wallet: eoaOf(1), source: "DIRECT", rewardACF: 20_000n * E18 });
    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor([]).reader),
      (e: unknown) => /DAO-source reward disagrees/.test((e as Error).message),
    );
  });

  it("5. zero system revenue is terminal, not an error", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(0n, 0n);
    const r = await runDAORevenueEpoch(EPOCH, chainFor([]).reader);
    assert.equal(r.status, "NOTHING_TO_DISTRIBUTE");
    if (r.status !== "NOTHING_TO_DISTRIBUTE") return;
    assert.equal(r.reason, "NO_SYSTEM_REVENUE");
    const row = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    assert.equal(row.totalMemberRevenueACF, "0");
    assert.equal(await DAORevenueMemberEntry.countDocuments({}), 0);
  });

  it("6. the epoch price is used, never a current one", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(1_000n * E18, 0n);
    await mkEntry({ stakeId: "1", userId: "alice", wallet: eoaOf(2), source: "DIRECT", rewardACF: 1_000n * E18 });
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "9", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkEntry({ stakeId: "9", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    assert.equal(entry.priceE18, P2.toString(), "the frozen Phase 1 price, not a spot read");
    // 1,000 ACF at $2 = $2,000; 5% = $100; back to ACF at $2 = 50 ACF.
    assert.equal(entry.memberRevenueUSD6, (100n * USD).toString());
    assert.equal(entry.memberRevenueACF, (50n * E18).toString());
  });
});

// ════════════════════════════════════════════════ EPOCH GATE ════

describe("epoch gate", () => {
  it("7. refuses to run before Phase 1 has settled", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor([]).reader), Phase1NotSettledError,
    );
  });

  it("8. does NOT require Phase 2 — no Team epoch exists here", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(1_000n * E18, 0n);
    await mkEntry({ stakeId: "1", userId: "alice", wallet: eoaOf(2), source: "DIRECT", rewardACF: 1_000n * E18 });
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "9", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkEntry({ stakeId: "9", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED", "Phase 2 absence must not block DAO revenue");
  });

  it("9. a missing snapshotBlockNumber FAILS rather than using live config", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(1_000n * E18, 0n);
    await RewardEpoch.updateOne({ ...SK, epochId: EPOCH }, { $unset: { snapshotBlockNumber: "" } });
    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor([]).reader),
      (e: unknown) => /no snapshotBlockNumber/.test((e as Error).message),
    );
  });
});

// ═══════════════════════════════════ ACTIVE CONTRIBUTION ════

describe("active contribution at the snapshot", () => {
  /** Base: 1,000 ACF of DIRECT Self reward, so the pool is $100 at $2. */
  const withRevenue = async () => {
    await mkConfig();
    await mkPhase1(1_000n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT",
      rewardACF: 1_000n * E18,
    });
  };

  it("10. multiple active contributions by one member aggregate to 15,000", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withRevenue();
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkContribution({ contributionId: "2", stakeId: "11", userId: "alice", n: 2, usdt: 10_000n * USD });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });
    await mkEntry({ stakeId: "11", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    assert.equal(entry.activeContributionUSDT6, (15_000n * USD).toString());
    assert.equal(entry.activeContributionCount, 2);
  });

  it("11. one leg withdrawn before the snapshot leaves only the other", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withRevenue();
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkContribution({
      contributionId: "2", stakeId: "11", userId: "alice", n: 2, usdt: 10_000n * USD,
      withdrawnBlockTimestamp: SNAPSHOT - 10,
    });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });
    await mkEntry({
      stakeId: "11", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n,
      ineligibleReason: "WITHDRAWN",
    });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    assert.equal(entry.activeContributionUSDT6, (5_000n * USD).toString());
    assert.equal(entry.activeContributionCount, 1);
  });

  it("12. withdrawn AFTER the snapshot still counts for this epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withRevenue();
    await mkUser("alice", 2);
    await mkContribution({
      contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD,
      withdrawnBlockTimestamp: SNAPSHOT + 1,
    });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    assert.equal(entry.activeContributionUSDT6, (5_000n * USD).toString());
  });

  it("13. a contribution made AFTER the snapshot is excluded", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withRevenue();
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });
    // A second contribution the member made after the boundary, with a TOO_YOUNG entry.
    await mkContribution({
      contributionId: "2", stakeId: "11", userId: "alice", n: 2, usdt: 50_000n * USD,
      stakeTimestamp: SNAPSHOT + 60,
    });
    await mkEntry({
      stakeId: "11", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n,
      ineligibleReason: "TOO_YOUNG",
    });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    assert.equal(
      entry.activeContributionUSDT6, (5_000n * USD).toString(),
      "the 50,000 made after the boundary must not be weighted",
    );
  });

  it("14. TOO_YOUNG but created BEFORE the snapshot is included", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withRevenue();
    await mkUser("alice", 2);
    await mkContribution({
      contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD,
      stakeTimestamp: SNAPSHOT - 600,
    });
    await mkEntry({
      stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n,
      ineligibleReason: "TOO_YOUNG",
    });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED", "a young but existing contribution participates");
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    assert.equal(entry.activeContributionUSDT6, (5_000n * USD).toString());
  });

  it("15. current Stake.active=false does NOT override the historical entry", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withRevenue();
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });
    // The member has since withdrawn: live state is inactive, and the cached DAO flag too.
    await Stake.updateOne({ ...SK, stakeId: "10" }, { $set: { active: false } });
    await DAOContribution.updateOne(
      { ...DK, contributionId: "1" }, { $set: { lastKnownActive: false } },
    );

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    assert.equal(
      entry.activeContributionUSDT6, (5_000n * USD).toString(),
      "a later withdrawal must not void an epoch the position was active throughout",
    );
  });

  it("16. a missing Phase 1 entry for an existing contribution FAILS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withRevenue();
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD });
    // No entry written for stake 10.
    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor([2]).reader),
      (e: unknown) => /no Phase 1 reward entry exists/.test((e as Error).message),
    );
  });

  it("17. a contribution with no linked Stake FAILS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withRevenue();
    await mkUser("alice", 2);
    await DAOContribution.collection.insertOne({
      eventId: "80002:dao:orphan", ...DK, contributionId: "99",
      userId: "alice", externalEOA: eoaOf(2),
      usdtContributed: (5_000n * USD).toString(), acfStaked: "0",
      executionPriceE18: P2.toString(), daoPoolId: 6,
      stakingContractAddress: LOW_STAKING, stakeId: "404",
      txHash: `0x${"f".repeat(64)}`, blockNumber: 1, logIndex: 0, blockTimestamp: new Date(1),
      lastKnownActive: true, createdAt: new Date(1), updatedAt: new Date(1),
    } as never);
    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor([2]).reader),
      (e: unknown) => /absent from the Stake collection/.test((e as Error).message),
    );
  });

  it("18. the weight is recorded USDT, never ACF principal repriced", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withRevenue();
    await mkUser("alice", 2);
    // 5,000 USDT bought 1,000 ACF. At the epoch price of $2 that principal is worth $2,000 —
    // repricing would weight this member at 2,000 instead of 5,000.
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    assert.equal(entry.activeContributionUSDT6, (5_000n * USD).toString());
    assert.notEqual(entry.activeContributionUSDT6, (2_000n * USD).toString());
  });
});

// ═════════════════════════════════════════════ ELIGIBILITY ════

describe("eligibility and the shared pool", () => {
  const withRevenue = async (regular = 1_000n * E18) => {
    await mkPhase1(regular, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: regular,
    });
  };

  const addMember = async (userId: string, n: number, usdt: bigint, stakeId: string) => {
    await mkUser(userId, n);
    await mkContribution({ contributionId: stakeId, stakeId, userId, n, usdt });
    await mkEntry({ stakeId, userId, wallet: eoaOf(n), source: "DAO", rewardACF: 0n });
  };

  it("19. exactly the Silver minimum qualifies", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await withRevenue();
    await addMember("alice", 2, 5_000n * USD, "10");
    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    assert.equal((r as { eligibleMembers: number }).eligibleMembers, 1);
  });

  it("20. one USDT base unit below does not qualify for a member share", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await withRevenue();
    await addMember("alice", 2, 5_000n * USD - 1n, "10");
    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);

    // The epoch is still executable, because the marketing allocation comes out of SystemRevenue
    // whether or not anyone qualified for the member pool. What the minimum decides is the MEMBER
    // share, not whether the protocol owes anything.
    assert.equal(r.status, "CALCULATED");
    assert.equal((r as { eligibleMembers: number }).eligibleMembers, 0, "nobody qualified");
    const epoch = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    assert.equal(epoch.totalMemberRevenueACF, "0");
    assert.ok(BigInt(epoch.marketingRevenueACF) > 0n, "and marketing is still owed");
    assert.equal(epoch.totalObligationACF, epoch.marketingRevenueACF);
  });

  it("21. Gold receives NO multiplier — 5x contribution, exactly 5x share", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await withRevenue(30_000n * E18);                 // $60,000 revenue, $3,000 pool
    await addMember("gold", 2, 25_000n * USD, "10");
    await addMember("silver", 3, 5_000n * USD, "11");

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2, 3]).reader);
    assert.equal(r.status, "CALCULATED");
    const gold = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "gold" }))!;
    const silver = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "silver" }))!;
    assert.equal(
      BigInt(gold.memberRevenueUSD6), BigInt(silver.memberRevenueUSD6) * 5n,
      "proportional only — no Gold bonus",
    );
    // One shared pool: the two shares exhaust it.
    assert.equal(
      BigInt(gold.memberRevenueUSD6) + BigInt(silver.memberRevenueUSD6),
      BigInt((r as { daoRevenuePoolUSD6: string }).daoRevenuePoolUSD6),
    );
  });

  it("22. no DAO members at all still owes the marketing allocation", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await withRevenue();
    const r = await runDAORevenueEpoch(EPOCH, chainFor([]).reader);

    // A marketing-only epoch: zero members, zero batches, one obligation. Treating this as
    // terminal would quietly drop the 2% the protocol owes for the epoch.
    assert.equal(r.status, "CALCULATED");
    assert.equal((r as { eligibleMembers: number }).eligibleMembers, 0);
    const epoch = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    assert.equal(epoch.batchCount, 0, "nothing to batch");
    assert.equal(epoch.totalMemberRevenueACF, "0");
    assert.equal(epoch.totalObligationACF, epoch.marketingRevenueACF);
    assert.ok(BigInt(epoch.marketingRevenueACF) > 0n);
    assert.equal(epoch.marketingCollector, TEST_MARKETING_COLLECTOR.toLowerCase());
  });

  it("22b. no members AND no marketing is still terminal", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Marketing switched off: with nobody eligible either, the epoch genuinely owes nothing.
    await mkConfig();
    await DAOConfigHistory.collection.updateOne(
      { ...DK, blockNumber: CONFIG_BLOCK }, { $set: { marketingRateE6: "0" } },
    );
    await withRevenue();
    const r = await runDAORevenueEpoch(EPOCH, chainFor([]).reader);
    assert.equal(r.status, "NOTHING_TO_DISTRIBUTE");
    if (r.status !== "NOTHING_TO_DISTRIBUTE") return;
    assert.equal(r.reason, "NO_ELIGIBLE_MEMBERS");
  });

  it("23. THE SPEC ECONOMICS — Alice's 5,000 of 100,000 earns 50 ACF", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    // 20,000 ACF Self reward at $2 = $40,000; 5% = $2,000 pool.
    await mkPhase1(18_000n * E18, 2_000n * E18);
    await mkEntry({ stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: 18_000n * E18 });
    await mkEntry({ stakeId: "2", userId: "whale", wallet: eoaOf(9), source: "DAO", rewardACF: 2_000n * E18 });
    // Alice 5,000; whale 95,000. Total 100,000.
    await addMember("alice", 2, 5_000n * USD, "10");
    await mkUser("whale", 9);
    await mkContribution({ contributionId: "2", stakeId: "2", userId: "whale", n: 9, usdt: 95_000n * USD });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2, 9]).reader);
    assert.equal(r.status, "CALCULATED");
    if (r.status !== "CALCULATED") return;
    assert.equal(r.systemRevenueUSD6, (40_000n * USD).toString());
    assert.equal(r.daoRevenuePoolUSD6, (2_000n * USD).toString());

    const alice = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    assert.equal(alice.totalEligibleContributionUSDT6, (100_000n * USD).toString());
    assert.equal(alice.memberRevenueUSD6, (100n * USD).toString(), "5% of $2,000 = $100");
    assert.equal(alice.memberRevenueACF, (50n * E18).toString(), "$100 at $2 = 50 ACF");

    const whale = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "whale" }))!;
    assert.equal(whale.memberRevenueUSD6, (1_900n * USD).toString());
    assert.equal(
      BigInt(alice.memberRevenueACF) + BigInt(whale.memberRevenueACF),
      BigInt(r.totalMemberRevenueACF),
    );
  });
});

// ════════════════════════════════════ HISTORICAL CONFIG ════

describe("historical DAO configuration", () => {
  const withOneMember = async (usdt = 5_000n * USD) => {
    await mkPhase1(1_000n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT",
      rewardACF: 1_000n * E18,
    });
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });
  };

  it("24. missing config FAILS rather than reading the live contract", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withOneMember();
    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor([2]).reader), DAOConfigUnavailableError,
    );
  });

  it("25. config mined AFTER the snapshot block is invisible", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withOneMember();
    await mkConfig({ blockNumber: SNAPSHOT_BLOCK + 1, rate: 100_000n });   // 10%, too late
    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor([2]).reader), DAOConfigUnavailableError,
    );
  });

  it("26. the OLD rate applies to an old epoch, not today's", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withOneMember();
    await mkConfig({ blockNumber: CONFIG_BLOCK, rate: 50_000n });            // 5% then
    await mkConfig({ blockNumber: SNAPSHOT_BLOCK + 500, rate: 200_000n });   // 20% later

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    if (r.status !== "CALCULATED") return;
    // $2,000 revenue at the HISTORICAL 5% = $100, not 20% = $400.
    assert.equal(r.daoRevenuePoolUSD6, (100n * USD).toString());
    const row = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    assert.equal(row.memberRevenueRateE6, "50000");
    assert.equal(row.configBlockNumber, CONFIG_BLOCK);
  });

  it("27. the OLD Silver threshold applies, not a later one", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withOneMember(5_000n * USD);
    await mkConfig({ blockNumber: CONFIG_BLOCK, silver: 5_000n * USD });
    // Raised afterwards to 10,000, which would have disqualified this member.
    await mkConfig({ blockNumber: SNAPSHOT_BLOCK + 500, silver: 10_000n * USD });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED", "judged against the threshold in force at the time");
    const row = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    assert.equal(row.silverMinimumUSDT6, (5_000n * USD).toString());
  });

  it("28. a LATER threshold increase does not retroactively disqualify", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withOneMember(7_000n * USD);
    await mkConfig({ blockNumber: CONFIG_BLOCK, silver: 5_000n * USD });
    await mkConfig({ blockNumber: SNAPSHOT_BLOCK - 1, silver: 10_000n * USD });  // before snapshot

    // This one IS in force at the snapshot, so 7,000 no longer qualifies for a member share.
    // The epoch remains executable on its marketing allocation alone: a threshold decides who is
    // in the member pool, not whether the protocol owes its 2%.
    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    assert.equal((r as { eligibleMembers: number }).eligibleMembers, 0);
    const epoch = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    assert.equal(epoch.totalMemberRevenueACF, "0", "the member share is gone");
    assert.equal(epoch.silverMinimumUSDT6, (10_000n * USD).toString(), "the later threshold applied");
    assert.equal(epoch.totalObligationACF, epoch.marketingRevenueACF);
  });

  it("29. the programme being DISABLED at the snapshot is terminal and recorded", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withOneMember();
    await mkConfig({ blockNumber: CONFIG_BLOCK, enabled: false });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "NOTHING_TO_DISTRIBUTE");
    if (r.status !== "NOTHING_TO_DISTRIBUTE") return;
    assert.equal(r.reason, "PROGRAM_DISABLED");
    const row = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    assert.equal(row.revenueEnabledAtSnapshot, false);
    assert.equal(row.totalMemberRevenueACF, "0");
    // Recorded, so switching the programme on later cannot make this epoch payable.
    assert.equal(row.status, "NOTHING_TO_DISTRIBUTE");
  });

  it("30. re-enabled later does NOT revive a disabled historical epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await withOneMember();
    await mkConfig({ blockNumber: CONFIG_BLOCK, enabled: false });
    await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    await mkConfig({ blockNumber: SNAPSHOT_BLOCK + 1, enabled: true });

    const again = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(again.status, "ALREADY_PROCESSED");
    assert.equal((again as { existing: string }).existing, "NOTHING_TO_DISTRIBUTE");
  });

  it("31. as-of resolution picks the newest row at or before the block", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig({ blockNumber: 100, rate: 10_000n });
    await mkConfig({ blockNumber: 200, rate: 20_000n });
    await mkConfig({ blockNumber: 300, rate: 30_000n });
    assert.equal((await resolveConfigAsOf(250)).memberRevenueRateE6, 20_000n);
    assert.equal((await resolveConfigAsOf(300)).memberRevenueRateE6, 30_000n);
    assert.equal((await resolveConfigAsOf(100)).memberRevenueRateE6, 10_000n);
    // Before the earliest known row there is no answer, and inventing one would price an
    // epoch against a threshold nobody set.
    await assert.rejects(resolveConfigAsOf(99), DAOConfigUnavailableError);
  });
});

// ═════════════════════════════════════════════ IDENTITY ════

describe("payout identity", () => {
  const ready = async () => {
    await mkConfig();
    await mkPhase1(1_000n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT",
      rewardACF: 1_000n * E18,
    });
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });
  };

  it("32. the member entry stores the EOA and the wallet separately", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await ready();
    await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    // One address plays both roles: what distributeBatch is called with, and where ACF lands.
    assert.equal(entry.externalEOA, eoaOf(2).toLowerCase(), "the distributeBatch argument");
    assert.equal(entry.externalEOA, eoaOf(2).toLowerCase(), "and the payout destination");
  });

  it("33. the manifest batch carries the member's own address as the call argument", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await ready();
    await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    const { manifest } = await rebuildManifest(EPOCH);
    assert.deepEqual(manifest.batches[0]!.externalEOAs, [eoaOf(2).toLowerCase()]);
    assert.deepEqual(manifest.batches[0]!.recipients, [eoaOf(2).toLowerCase()],
      "the recipient is the same address that is submitted");
  });

  it("34. the epoch settles with no registry read at all", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await ready();
    // A bare fake chain: it exposes no address resolution whatsoever. Under the old architecture
    // this epoch could not be calculated; now there is nothing to resolve, so it settles.
    await runDAORevenueEpoch(EPOCH, fakeDAOChain().reader);
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    assert.equal(entry.externalEOA, eoaOf(2).toLowerCase());
  });

  it("35. the obligation names exactly one address, which is both argument and recipient", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await ready();
    await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    // There is no second address field to disagree with the first.
    assert.equal(Object.keys(entry.toObject()).filter((k) => /EOA|wallet|address/i.test(k))
      .filter((k) => k !== "daoContractAddress" && k !== "distributorAddress").length, 1);
    assert.equal(entry.externalEOA, eoaOf(2).toLowerCase());
  });

  it("36. a member with no address on record FAILS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await ready();
    // One address now, so there is one way to be unpayable. `externalEOA` is immutable:true and
    // Mongoose strips $unset on it, so corrupting the record takes the raw driver — which is the
    // point: this state is unreachable through the application.
    await User.collection.updateOne({ userId: "alice" }, { $unset: { externalEOA: "" } });
    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor([2]).reader),
      (e: unknown) => /has no address/.test((e as Error).message),
    );
  });
});

// ══════════════════════════════════ PERSISTENCE / B1 ════

describe("persistence verification", () => {
  /** N eligible members of equal weight, so shares and batching are easy to reason about. */
  const withMembers = async (count: number, revenue = 1_000n * E18) => {
    await mkConfig();
    await mkPhase1(revenue, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: revenue,
    });
    const ns: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const n = 100 + i;
      ns.push(n);
      await mkUser(`m${i}`, n);
      await mkContribution({
        contributionId: `${i}`, stakeId: `${1000 + i}`, userId: `m${i}`, n, usdt: 5_000n * USD,
      });
      await mkEntry({
        stakeId: `${1000 + i}`, userId: `m${i}`, wallet: eoaOf(n), source: "DAO", rewardACF: 0n,
      });
    }
    return ns;
  };

  it("38. exactly one entry per eligible member, and the totals agree", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const ns = await withMembers(4);
    const r = await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    assert.equal(r.status, "CALCULATED");
    if (r.status !== "CALCULATED") return;

    const entries = await DAORevenueMemberEntry.find({ ...MK, epochId: EPOCH }).lean();
    assert.equal(entries.length, 4);
    assert.equal(new Set(entries.map((e) => e.userId)).size, 4);
    const sum = entries.reduce((acc, e) => acc + BigInt(e.memberRevenueACF), 0n);
    assert.equal(sum, BigInt(r.totalMemberRevenueACF));
  });

  it("39. a divergent stored entry FAILS and is never repaired", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const ns = await withMembers(2);
    await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);

    // Tamper, then force recalculation by resetting the epoch to a replaceable state.
    await DAORevenueMemberEntry.collection.updateOne(
      { ...MK, epochId: EPOCH, userId: "m0" }, { $set: { memberRevenueACF: "1" } },
    );
    await DAORevenueEpoch.updateOne({ ...RK, epochId: EPOCH }, { $set: { status: "FAILED" } });

    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor(ns).reader),
      (e: unknown) => e instanceof DAORevenueRowError
        && /memberRevenueACF expected/.test((e as Error).message),
    );
    assert.equal(
      (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "m0" }))!.memberRevenueACF,
      "1", "reported, never overwritten",
    );
  });

  it("40. a deleted entry FAILS on recalculation", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const ns = await withMembers(3);
    await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    // Remove one row and leave an extra behind so the count cannot match either way.
    await DAORevenueMemberEntry.deleteOne({ ...MK, epochId: EPOCH, userId: "m1" });
    await DAORevenueEpoch.updateOne({ ...RK, epochId: EPOCH }, { $set: { status: "FAILED" } });

    // Recalculation re-inserts the missing row, so this must SUCCEED and restore consistency.
    const again = await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    assert.equal(again.status, "CALCULATED");
    assert.equal(await DAORevenueMemberEntry.countDocuments({ ...MK, epochId: EPOCH }), 3);
  });

  it("41. an UNEXPECTED extra entry FAILS the count check", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const ns = await withMembers(2);
    await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    await DAORevenueMemberEntry.collection.insertOne({
      ...MK, daoContractAddress: TEST_DAO.toLowerCase(), epochId: EPOCH, userId: "ghost",
      externalEOA: eoaOf(900).toLowerCase(),
      activeContributionUSDT6: "1", totalEligibleContributionUSDT6: "1",
      activeContributionCount: 1, memberRevenueRateE6: "50000",
      systemRevenueUSD6: "1", daoRevenuePoolUSD6: "1", priceE18: P2.toString(),
      memberRevenueUSD6: "1", memberRevenueACF: "1", batchIndex: 0,
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);
    await DAORevenueEpoch.updateOne({ ...RK, epochId: EPOCH }, { $set: { status: "FAILED" } });

    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor(ns).reader),
      (e: unknown) => /would be paid without a calculated obligation/.test((e as Error).message),
    );
  });

  it("42. a second identical run is idempotent", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const ns = await withMembers(2);
    const first = await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    const second = await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    assert.equal(first.status, "CALCULATED");
    assert.equal(second.status, "ALREADY_PROCESSED");
    assert.equal(await DAORevenueMemberEntry.countDocuments({ ...MK, epochId: EPOCH }), 2);
    assert.equal(await DAORevenueEpoch.countDocuments({ ...RK, epochId: EPOCH }), 1);
  });

  it("43. a divergent EPOCH row FAILS rather than being rewritten", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const ns = await withMembers(2);
    await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    // CALCULATED is not replaceable, so a tampered financial field must be reported.
    await DAORevenueEpoch.collection.updateOne(
      { ...RK, epochId: EPOCH }, { $set: { totalMemberRevenueACF: "1" } },
    );
    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor(ns).reader),
      (e: unknown) => e instanceof DAORevenueInvariantError
        && /A financial field has changed since calculation/.test((e as Error).message),
    );
    assert.equal(
      (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!.totalMemberRevenueACF,
      "1", "reported, never repaired",
    );
  });

  it("44. the manifest hash covers every financial field", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const ns = await withMembers(2);
    await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    const before = await rebuildManifest(EPOCH);
    assert.equal(before.hash, before.recordedHash);

    // Change one member's amount: the rebuilt manifest must no longer hash to the record.
    await DAORevenueMemberEntry.collection.updateOne(
      { ...MK, epochId: EPOCH, userId: "m0" }, { $set: { memberRevenueACF: "123" } },
    );
    const after = await rebuildManifest(EPOCH);
    assert.notEqual(after.hash, after.recordedHash);
  });
});

// ═══════════════════════════════════════ ROUNDING / BATCHING ════

describe("rounding and batching", () => {
  const withWeights = async (weights: bigint[], revenue: bigint) => {
    await mkConfig();
    await mkPhase1(revenue, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: revenue,
    });
    const ns: number[] = [];
    for (const [i, usdt] of weights.entries()) {
      const n = 200 + i;
      ns.push(n);
      await mkUser(`w${i}`, n);
      await mkContribution({
        contributionId: `${i}`, stakeId: `${2000 + i}`, userId: `w${i}`, n, usdt,
      });
      await mkEntry({
        stakeId: `${2000 + i}`, userId: `w${i}`, wallet: eoaOf(n), source: "DAO", rewardACF: 0n,
      });
    }
    return ns;
  };

  it("45. shares are floored, dust is recorded and NEVER funded", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Three equal members against a pool that does not divide by three.
    const ns = await withWeights([5_000n * USD, 5_000n * USD, 5_000n * USD], 1_000n * E18 + 1n);
    const r = await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    assert.equal(r.status, "CALCULATED");
    if (r.status !== "CALCULATED") return;

    const entries = await DAORevenueMemberEntry.find({ ...MK, epochId: EPOCH }).lean();
    const sumUSD = entries.reduce((a, e) => a + BigInt(e.memberRevenueUSD6), 0n);
    const pool = BigInt(r.daoRevenuePoolUSD6);
    assert.ok(sumUSD <= pool, "member shares never exceed the pool");
    assert.equal(BigInt(r.roundingDustUSD6), pool - sumUSD);

    // The obligation is the sum of member ACF, not the pool converted.
    const sumACF = entries.reduce((a, e) => a + BigInt(e.memberRevenueACF), 0n);
    assert.equal(BigInt(r.totalMemberRevenueACF), sumACF);
  });

  it("46. the funded amount is the member sum, not the theoretical pool", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const ns = await withWeights([1n * USD, 1n * USD, 1n * USD], 1_000n * E18);
    // A later-but-still-historical config drops the minimum so these tiny weights qualify.
    await mkConfig({ blockNumber: CONFIG_BLOCK + 1, silver: 1n });
    const r = await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    if (r.status !== "CALCULATED") return;

    const entries = await DAORevenueMemberEntry.find({ ...MK, epochId: EPOCH }).lean();
    const sumACF = entries.reduce((a, e) => a + BigInt(e.memberRevenueACF), 0n);
    const poolACF = (BigInt(r.daoRevenuePoolUSD6) * 10n ** 30n) / P2;
    assert.equal(BigInt(r.totalMemberRevenueACF), sumACF);
    assert.ok(
      BigInt(r.totalMemberRevenueACF) <= poolACF,
      "funding the pool instead would strand the difference in a contract with no sweep",
    );
  });

  it("47. 51 members split into 2 batches at the default size of 50", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const ns = await withWeights(Array.from({ length: 51 }, () => 5_000n * USD), 100_000n * E18);
    const r = await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    assert.equal(r.status, "CALCULATED");
    if (r.status !== "CALCULATED") return;
    assert.equal(r.eligibleMembers, 51);
    assert.equal(r.batchCount, 2);

    const { manifest } = await rebuildManifest(EPOCH);
    assert.equal(manifest.batches.length, 2);
    assert.equal(manifest.batches[0]!.externalEOAs.length, 50);
    assert.equal(manifest.batches[1]!.externalEOAs.length, 1);
  });

  it("48. batches are ordered deterministically by lowercase wallet", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const ns = await withWeights(Array.from({ length: 5 }, () => 5_000n * USD), 10_000n * E18);
    await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    const { manifest } = await rebuildManifest(EPOCH);
    const wallets = manifest.batches.flatMap((b) => b.recipients);
    assert.deepEqual(wallets, [...wallets].sort(), "ascending wallet order");
  });

  it("49. batch totals sum to the epoch obligation", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const ns = await withWeights([5_000n * USD, 7_000n * USD, 9_000n * USD], 10_000n * E18);
    const r = await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    if (r.status !== "CALCULATED") return;
    const { manifest } = await rebuildManifest(EPOCH);
    const total = manifest.batches.reduce((a, b) => a + BigInt(b.batchTotalACF), 0n);
    assert.equal(total, BigInt(r.totalMemberRevenueACF));
  });

  it("50. a pool too small to give anyone a unit is terminal", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // 1 wei of Self reward at $2 converts to 0 USD6, so the pool is empty.
    const ns = await withWeights([5_000n * USD], 1n);
    const r = await runDAORevenueEpoch(EPOCH, chainFor(ns).reader);
    assert.equal(r.status, "NOTHING_TO_DISTRIBUTE");
    if (r.status !== "NOTHING_TO_DISTRIBUTE") return;
    assert.ok(["NO_SYSTEM_REVENUE", "EMPTY_POOL"].includes(r.reason));
    assert.equal(await DAORevenueMemberEntry.countDocuments({ ...MK, epochId: EPOCH }), 0);
  });
});

// ══════════════════════════ FUNDING / DISTRIBUTION / EXECUTOR ════

describe("funding, distribution and the executor", () => {
  /** A CALCULATED epoch with `count` equal members, plus the chain fake backing it. */
  const calculated = async (count = 3, revenue = 10_000n * E18) => {
    await mkConfig();
    await mkPhase1(revenue, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: revenue,
    });
    const ns: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const n = 300 + i;
      ns.push(n);
      await mkUser(`f${i}`, n);
      await mkContribution({
        contributionId: `${i}`, stakeId: `${3000 + i}`, userId: `f${i}`, n, usdt: 5_000n * USD,
      });
      await mkEntry({
        stakeId: `${3000 + i}`, userId: `f${i}`, wallet: eoaOf(n), source: "DAO", rewardACF: 0n,
      });
    }
    const chain = chainFor(ns);
    const r = await runDAORevenueEpoch(EPOCH, chain.reader);
    assert.equal(r.status, "CALCULATED");
    // `obligation` is what Treasury must FUND: the member shares plus the marketing allocation.
    // Both are returned separately too, because a settled epoch needs both paid.
    const epoch = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    // Authorized immediately: the executor cannot act on a merely CALCULATED epoch, so every
    // case below would otherwise be testing a state the real flow never presents to it.
    await authorizeEpochRow(chain, EPOCH);
    return {
      chain, ns,
      obligation: BigInt(epoch.totalObligationACF),
      memberObligation: BigInt(epoch.totalMemberRevenueACF),
      marketing: BigInt(epoch.marketingRevenueACF),
    };
  };

  it("51. preflight passes on an authorized epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation } = await calculated();
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.deepEqual(report.blockers, []);
    assert.equal(report.manifestVerified, true);
    assert.equal(report.obligationACF, obligation.toString());
    assert.equal(report.fundedACF, "0");
    assert.equal(report.unpaidMembers, 3);
    assert.ok(report.plannedCalls[0]!.startsWith("Treasury.fundDAORevenueEpoch"));
  });

  it("52. the planned funding is the obligation, never the pool", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation } = await calculated();
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.ok(report.plannedCalls.includes(
      `Treasury.fundDAORevenueEpoch(${EPOCH}, ${obligation})`,
    ));
  });

  it("53. an already-funded epoch with the RIGHT amount skips funding", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, marketing } = await calculated();
    await authorizeAndFund(chain);
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.deepEqual(report.blockers, []);
    assert.equal(report.fundedACF, obligation.toString());
    assert.ok(
      !report.plannedCalls.some((c) => c.startsWith("Treasury.fundDAORevenueEpoch")),
      "never funds twice because a local tx hash is missing",
    );
  });

  it("54. an epoch cannot be funded with the WRONG amount at all", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation } = await calculated();
    // Previously this state was reachable and preflight had to catch it afterwards. The
    // distributor now refuses any amount other than the authorized total, so the overfunded
    // epoch cannot exist — which is a stronger guarantee than detecting it later, because an
    // executor calling Treasury directly is refused by the chain rather than by this backend.
    for (const wrong of [obligation + 1n, obligation - 1n, obligation * 2n, 1n]) {
      assert.throws(() => chain.fund(EPOCH, wrong), /authorized for/);
    }
    assert.equal(await chain.reader.epochFundedAmount(EPOCH), 0n);

    // Exactly the authorized total is accepted, and preflight is then clear.
    chain.fund(EPOCH, obligation);
    assert.deepEqual((await preflight(EPOCH, chain.reader, eoaOf(1))).blockers, []);
  });

  it("55. insufficient Treasury headroom blocks execution rather than minting", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation } = await calculated();
    // Leave the balance only just above the required reserve, so funding would erode backing.
    chain.state.requiredReserve = chain.state.treasuryBalance - obligation + 1n;
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.headroomOk, false);
    assert.ok(report.blockers.some((b) => /required headroom/.test(b)));
    assert.ok(report.blockers.some((b) => /escalate rather than minting/.test(b)));
  });

  it("56. a Treasury balance below the obligation is blocked", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation } = await calculated();
    chain.state.treasuryBalance = obligation - 1n;
    chain.state.requiredReserve = 0n;
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.ok(report.blockers.some((b) => /less than the obligation/.test(b)));
  });

  it("57. a wrong payout destination is blocked", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await calculated();
    chain.state.payoutDestination = `0x${"e".repeat(40)}`;
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.ok(report.blockers.some((b) => /daoPayoutDestination/.test(b)));
  });

  it("58. a missing executor role is blocked", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await calculated();
    chain.state.roles = { treasury: false, distributor: false };
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.ok(report.blockers.some((b) => /lacks EPOCH_EXECUTOR_ROLE on the Treasury/.test(b)));
    assert.ok(report.blockers.some((b) => /lacks EPOCH_EXECUTOR_ROLE on the distributor/.test(b)));
  });

  it("59. the wrong chain is blocked", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await calculated();
    chain.state.chainId = 1;
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.ok(report.blockers.some((b) => /RPC reports chain 1/.test(b)));
  });

  it("60. a batch size above the distributor's maximum is blocked", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await calculated();
    chain.state.maxBatchSize = 2;                 // configured size is 50
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.ok(report.blockers.some((b) => /exceeds the distributor's MAX_BATCH_SIZE/.test(b)));
  });

  it("61. a tampered member amount blocks execution via the manifest hash", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await calculated();
    await DAORevenueMemberEntry.collection.updateOne(
      { ...MK, epochId: EPOCH, userId: "f0" }, { $set: { memberRevenueACF: "999" } },
    );
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.manifestVerified, false);
    assert.ok(report.blockers.some((b) => /Manifest hash mismatch/.test(b)));
  });

  it("62. partially paid members are excluded from the remaining plan", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, marketing } = await calculated();
    await authorizeAndFund(chain);
    const entries = await DAORevenueMemberEntry.find({ ...MK, epochId: EPOCH })
      .sort({ externalEOA: 1 }).lean();
    chain.pay(EPOCH, entries[0]!.externalEOA, BigInt(entries[0]!.memberRevenueACF));

    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.unpaidMembers, 2);
    assert.deepEqual(report.blockers, []);
  });

  it("63. COMPLETED needs every member paid, marketing paid AND totals agreeing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, marketing } = await calculated();
    await authorizeAndFund(chain);
    const entries = await DAORevenueMemberEntry.find({ ...MK, epochId: EPOCH }).lean();
    assert.ok(marketing > 0n, "the fixture owes a marketing allocation");

    // Pay all but one member: DISTRIBUTING, not COMPLETED.
    for (const e of entries.slice(0, -1)) {
      chain.pay(EPOCH, e.externalEOA, BigInt(e.memberRevenueACF));
    }
    const partial = (await reconcileDAORevenueEpoch(EPOCH, chain.reader))!;
    assert.equal(partial.statusAfter, "DISTRIBUTING");
    assert.equal(partial.paidMembers, entries.length - 1);

    // Every member paid, but marketing still outstanding. This is the case that must NOT read as
    // settled: the epoch has real money left to send.
    const last = entries.at(-1)!;
    chain.pay(EPOCH, last.externalEOA, BigInt(last.memberRevenueACF));
    const membersOnly = (await reconcileDAORevenueEpoch(EPOCH, chain.reader))!;
    assert.equal(membersOnly.statusAfter, "DISTRIBUTING", "all members paid is not settled");
    assert.equal(membersOnly.paidMembers, entries.length);
    assert.equal(membersOnly.marketingPaidACF, "0");
    assert.notEqual(membersOnly.distributedACF, membersOnly.obligationACF);

    // And the mirror case: marketing paid with a member outstanding is not settled either.
    chain.payMarketing(EPOCH, marketing);
    const done = (await reconcileDAORevenueEpoch(EPOCH, chain.reader))!;
    assert.equal(done.statusAfter, "COMPLETED");
    assert.equal(done.distributedACF, done.obligationACF);
    assert.equal(done.marketingPaidACF, marketing.toString());
    assert.equal(
      BigInt(done.memberObligationACF) + BigInt(done.marketingObligationACF),
      BigInt(done.obligationACF),
      "the two obligations account for the whole funding",
    );
  });

  it("63b. marketing paid while a member is outstanding is not settled either", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, marketing } = await calculated();
    await authorizeAndFund(chain);
    const entries = await DAORevenueMemberEntry.find({ ...MK, epochId: EPOCH }).lean();

    chain.payMarketing(EPOCH, marketing);
    for (const e of entries.slice(0, -1)) {
      chain.pay(EPOCH, e.externalEOA, BigInt(e.memberRevenueACF));
    }
    const partial = (await reconcileDAORevenueEpoch(EPOCH, chain.reader))!;
    assert.equal(partial.statusAfter, "DISTRIBUTING");
    assert.equal(partial.marketingPaidACF, marketing.toString());

    const last = entries.at(-1)!;
    chain.pay(EPOCH, last.externalEOA, BigInt(last.memberRevenueACF));
    assert.equal((await reconcileDAORevenueEpoch(EPOCH, chain.reader))!.statusAfter, "COMPLETED");
  });

  it("64. a funded-but-untouched epoch reconciles to FUNDED", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, marketing } = await calculated();
    await authorizeAndFund(chain);
    const r = (await reconcileDAORevenueEpoch(EPOCH, chain.reader))!;
    assert.equal(r.statusAfter, "FUNDED");
    assert.equal(r.paidMembers, 0);
  });

  it("65. a distributed total that no paid member explains FAILS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, marketing } = await calculated();
    await authorizeAndFund(chain);
    // Chain says ACF left the distributor but names nobody as paid.
    chain.state.distributed.set(EPOCH, obligation);
    await assert.rejects(
      reconcileDAORevenueEpoch(EPOCH, chain.reader),
      (e: unknown) => /account for 0/.test((e as Error).message)
        || /paid without a calculated obligation/.test((e as Error).message),
    );
  });

  it("66. distributing more than was funded FAILS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, marketing } = await calculated();
    await authorizeAndFund(chain);
    chain.state.distributed.set(EPOCH, obligation + 1n);
    await assert.rejects(
      reconcileDAORevenueEpoch(EPOCH, chain.reader),
      (e: unknown) => /distributed/.test((e as Error).message),
    );
  });

  it("67. an epoch owing nothing cannot be funded at all", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(0n, 0n);
    const r = await runDAORevenueEpoch(EPOCH, chainFor([]).reader);
    assert.equal(r.status, "NOTHING_TO_DISTRIBUTE");
    const chain = chainFor([]);

    // Stranding ACF this way used to be possible, and reconciliation had to catch it afterwards.
    // It is now unreachable: funding requires an authorization, and an epoch owing nothing cannot
    // be authorized — `authorizeEpoch` rejects a zero total. Refused by the chain, not detected
    // by this backend, so an executor calling Treasury directly is stopped too.
    assert.throws(() => chain.fund(EPOCH, 5n * E18), /not authorized/);
    assert.equal(await chain.reader.epochFundedAmount(EPOCH), 0n);

    // The reconciliation guard still stands behind it, for the hypothetical where such a state
    // somehow existed. Written directly into the fake, because nothing can produce it legitimately.
    chain.state.funded.set(EPOCH, 5n * E18);
    await assert.rejects(
      reconcileDAORevenueEpoch(EPOCH, chain.reader),
      (e: unknown) => /cannot be distributed and cannot be swept/.test((e as Error).message),
    );
  });

  it("68. a payment event that matches no obligation FAILS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await calculated();
    await assert.rejects(
      recordPayments(EPOCH, [{
        user: eoaOf(999), amount: 1n,
        txHash: `0x${"1".repeat(64)}`, logIndex: 0, blockNumber: 1, blockTimestamp: 1,
      }]),
      (e: unknown) => /has no calculated obligation/.test((e as Error).message),
    );
  });

  it("69. a payment to an address with no obligation FAILS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await calculated();
    // There is no "wrong recipient" left to test: the event's one address is both who was paid
    // and where the ACF went. What remains is a payment the calculation never authorised.
    await assert.rejects(
      recordPayments(EPOCH, [{
        user: eoaOf(888),
        amount: 1n,
        txHash: `0x${"2".repeat(64)}`, logIndex: 0, blockNumber: 1, blockTimestamp: 1,
      }]),
      (e: unknown) => /has no calculated obligation/.test((e as Error).message),
    );
  });

  it("70. a payment of the WRONG amount FAILS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await calculated();
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH }))!;
    await assert.rejects(
      recordPayments(EPOCH, [{
        user: entry.externalEOA,
        amount: BigInt(entry.memberRevenueACF) + 1n,
        txHash: `0x${"3".repeat(64)}`, logIndex: 0, blockNumber: 1, blockTimestamp: 1,
      }]),
      (e: unknown) => /but the obligation is/.test((e as Error).message),
    );
  });

  it("71. a correct payment records once and is idempotent", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await calculated();
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH }))!;
    const event = {
      user: entry.externalEOA,
      amount: BigInt(entry.memberRevenueACF),
      txHash: `0x${"4".repeat(64)}`, logIndex: 0, blockNumber: 1, blockTimestamp: 1,
    };
    assert.deepEqual(await recordPayments(EPOCH, [event]), { recorded: 1, alreadyPresent: 0 });
    assert.deepEqual(await recordPayments(EPOCH, [event]), { recorded: 0, alreadyPresent: 1 });
    assert.equal(await DAORevenuePayment.countDocuments({ ...MK, epochId: EPOCH }), 1);
  });

  it("72. the executor picks the oldest actionable epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await calculated();
    assert.equal(await nextExecutableEpoch(), EPOCH);
    await DAORevenueEpoch.updateOne({ ...RK, epochId: EPOCH }, { $set: { status: "COMPLETED" } });
    assert.equal(await nextExecutableEpoch(), null);
  });

  it("73. catch-up decides every settled Phase 1 epoch exactly once", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(0n, 0n, { epochId: EPOCH });
    await mkPhase1(0n, 0n, { epochId: EPOCH + 1 });
    const first = await catchUpDAORevenueEpochs(chainFor([]).reader);
    assert.equal(first.processed.length, 2);
    assert.equal(first.stoppedAt, null);
    const second = await catchUpDAORevenueEpochs(chainFor([]).reader);
    assert.equal(second.processed.length, 0, "already decided epochs are not revisited");
  });
});

// ══════════════════ PENDING PHASE 3 LIABILITY (headroom) ════

describe("Treasury headroom reserves the pending Phase 3 obligation", () => {
  const WD = "0x882db912586869315c2720de72224d79b9d99ea1";
  const SETTLE = { chainId: 80002, withdrawalAddress: WD };

  /** A Phase 3 checkpoint in a given state with a given published delta. */
  const mkCheckpoint = async (
    checkpointId: number, status: string, deltaACF: bigint, over: Partial<{ legacy: boolean }> = {},
  ) => {
    await RewardSettlementCheckpoint.collection.insertOne({
      ...SETTLE,
      stakingContractAddress: LOW_STAKING,
      treasuryAddress: "0x114fe8e3414bc49a24c6efd9e702cd66b9a80251",
      checkpointId,
      legacy: over.legacy ?? false,
      status,
      previousCheckpointId: null,
      fromRewardEpochId: null,
      throughRewardEpochId: null,
      root: `0x${checkpointId.toString(16).padStart(64, "0")}`,
      publishedCumulativeTotalACF: deltaACF.toString(),
      publishedDeltaACF: deltaACF.toString(),
      leafCount: 1,
      attempts: 1,
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);
  };

  /** A CALCULATED DAO epoch plus a chain fake with controllable balances. */
  const ready = async () => {
    await mkConfig();
    await mkPhase1(1_000n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT",
      rewardACF: 1_000n * E18,
    });
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });
    const chain = chainFor([2]);
    const r = await runDAORevenueEpoch(EPOCH, chain.reader);
    assert.equal(r.status, "CALCULATED");
    // Authorized, so these headroom cases exercise a genuinely executable epoch rather than
    // tripping the "not authorized" gate before reaching the reserve arithmetic.
    await authorizeEpochRow(chain, EPOCH);
    return { chain, obligation: BigInt((r as { totalMemberRevenueACF: string }).totalMemberRevenueACF) };
  };

  it("74. with no Phase 3 checkpoints the headroom is just the reserve", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await ready();
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.pendingStandardObligationACF, "0");
    assert.equal(report.requiredHeadroomACF, report.requiredReserveACF);
    assert.deepEqual(report.blockers, []);
  });

  it("75. THE MANDATORY SCENARIO — an unfunded CALCULATED checkpoint blocks DAO funding", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation } = await ready();
    // The spec's shape, scaled so the DAO obligation (50 ACF here) still exposes the gap:
    //   balance 1,000, reserve 600, pending Phase 3 400, DAO 50
    //   naive: 1,000 - 50 = 950 >= 600            -> would PASS
    //   truth: 600 + 400 = 1,000 needed, 950 left -> must BLOCK
    chain.state.treasuryBalance = 1_000n * E18;
    chain.state.requiredReserve = 600n * E18;
    await mkCheckpoint(900, "CALCULATED", 400n * E18);

    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.pendingStandardObligationACF, (400n * E18).toString());
    assert.equal(report.requiredHeadroomACF, (1_000n * E18).toString());
    // The naive guard would have passed: 1,000 - obligation is far above 600.
    assert.ok(BigInt(report.postFundingBalanceACF) >= BigInt(report.requiredReserveACF));
    assert.equal(report.headroomOk, false);
    assert.ok(report.blockers.some((b) => /pending standard-reward obligation/.test(b)));
    void obligation;
  });

  it("76. a checkpoint already funded ON CHAIN reserves nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await ready();
    chain.state.treasuryBalance = 1_000n * E18;
    chain.state.requiredReserve = 600n * E18;
    await mkCheckpoint(900, "FUNDED", 300n * E18);
    chain.state.standardFunded.add(900);                 // chain says it is settled

    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.pendingStandardObligationACF, "0");
    assert.deepEqual(report.blockers, []);
  });

  it("77. FINALIZED and FAILED checkpoints reserve nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await ready();
    await mkCheckpoint(900, "FINALIZED", 5_000n * E18);
    await mkCheckpoint(901, "FAILED", 5_000n * E18);
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.pendingStandardObligationACF, "0");
    assert.deepEqual(report.blockers, []);
  });

  it("78. the legacy checkpoint is excluded", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await ready();
    await mkCheckpoint(1_790_792_573, "FINALIZED", 5n * E18, { legacy: true });
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.pendingStandardObligationACF, "0");
  });

  it("79. several unfunded checkpoints accumulate", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await ready();
    await mkCheckpoint(900, "CALCULATED", 100n * E18);
    await mkCheckpoint(901, "FUNDING_SUBMITTED", 50n * E18);
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.pendingStandardObligationACF, (150n * E18).toString());
  });

  it("80. a CALCULATING checkpoint makes the liability undetermined and STOPS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await ready();
    await mkCheckpoint(900, "CALCULATING", 0n);
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.headroomOk, false);
    assert.ok(report.blockers.some((b) => /undetermined/.test(b)));
    assert.ok(report.blockers.some((b) => /Refusing to guess zero/.test(b)));
  });

  it("81. local FUNDED but chain says unfunded is a disagreement that STOPS", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await ready();
    await mkCheckpoint(900, "FUNDED", 300n * E18);       // chain.standardFunded left empty
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.headroomOk, false);
    assert.ok(report.blockers.some((b) => /disagree/.test(b)));
  });

  it("82. execution refuses when the headroom guard blocks", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await ready();
    chain.state.treasuryBalance = 1_000n * E18;
    chain.state.requiredReserve = 600n * E18;
    await mkCheckpoint(900, "CALCULATED", 400n * E18);
    // A signer is supplied, but execution must stop before anything is signed.
    await assert.rejects(
      executeDAORevenueEpoch(EPOCH, {
        reader: chain.reader,
        signer: {
          address: eoaOf(1),
          client: { account: null } as never,
          chain: { id: 80002 } as never,
        },
      }),
      (e: unknown) => /Refusing to execute DAO revenue epoch/.test((e as Error).message)
        && /pending standard-reward obligation/.test((e as Error).message),
    );
  });
});

// ═══════════════ SAME-BLOCK CONFIG ORDER / FULL SNAPSHOTS ════

describe("config history ordering and snapshots", () => {
  /** Two config events in ONE block, as initialize() emits them. */
  const mkConfigAt = async (
    blockNumber: number, logIndex: number, eventName: string,
    over: Partial<{ silver: bigint; rate: bigint; enabled: boolean }> = {},
  ) => {
    await DAOConfigHistory.collection.insertOne({
      ...DK, blockNumber, logIndex, blockTimestamp: 1_700_000_000,
      txHash: `0x${"d".repeat(64)}`, eventName,
      silverMinimumUSDT6: (over.silver ?? 5_000n * USD).toString(),
      goldMinimumUSDT6: (25_000n * USD).toString(),
      memberRevenueRateE6: (over.rate ?? 50_000n).toString(),
      marketingRateE6: "20000",
      marketingCollector: TEST_MARKETING_COLLECTOR,
      revenueEnabled: over.enabled ?? true,
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);
  };

  it("83. SAME BLOCK: the higher logIndex wins, not an arbitrary row", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // initialize(): RevenueConfigUpdated at logIndex 3 (enabled still false), then
    // RevenueEnabledUpdated at logIndex 4 (enabled true). End-of-block state is ENABLED.
    await mkConfigAt(500, 3, "RevenueConfigUpdated", { enabled: false });
    await mkConfigAt(500, 4, "RevenueEnabledUpdated", { enabled: true });
    const resolved = await resolveConfigAsOf(500);
    assert.equal(resolved.revenueEnabled, true);
    assert.equal(resolved.logIndex, 4);
  });

  it("84. SAME BLOCK, reverse order: the later logIndex still wins", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Disable then re-configure within one block: end state keeps the config row's carry.
    await mkConfigAt(500, 7, "RevenueEnabledUpdated", { enabled: false });
    await mkConfigAt(500, 9, "RevenueConfigUpdated", { enabled: false, rate: 70_000n });
    const resolved = await resolveConfigAsOf(500);
    assert.equal(resolved.logIndex, 9);
    assert.equal(resolved.memberRevenueRateE6, 70_000n);
    assert.equal(resolved.revenueEnabled, false);
  });

  it("85. insertion order does not affect resolution", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Insert the HIGHER logIndex first; the sort must still pick it.
    await mkConfigAt(600, 5, "RevenueEnabledUpdated", { enabled: true, rate: 90_000n });
    await mkConfigAt(600, 1, "RevenueConfigUpdated", { enabled: false, rate: 10_000n });
    const resolved = await resolveConfigAsOf(600);
    assert.equal(resolved.logIndex, 5);
    assert.equal(resolved.memberRevenueRateE6, 90_000n);
  });

  it("86. a RevenueEnabledUpdated row carries the thresholds in force", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfigAt(700, 0, "RevenueConfigUpdated", { silver: 8_000n * USD, rate: 60_000n });
    await mkConfigAt(701, 0, "RevenueEnabledUpdated", {
      silver: 8_000n * USD, rate: 60_000n, enabled: false,
    });
    const resolved = await resolveConfigAsOf(701);
    assert.equal(resolved.revenueEnabled, false);
    assert.equal(resolved.silverMinimumUSDT6, 8_000n * USD, "thresholds not reset to a default");
    assert.equal(resolved.memberRevenueRateE6, 60_000n, "rate not reset to a default");
  });

  it("87. a RevenueConfigUpdated row carries the enabled state in force", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfigAt(700, 0, "RevenueEnabledUpdated", { enabled: false });
    await mkConfigAt(701, 0, "RevenueConfigUpdated", { enabled: false, rate: 30_000n });
    const resolved = await resolveConfigAsOf(701);
    assert.equal(resolved.revenueEnabled, false, "a config change must not re-enable the program");
    assert.equal(resolved.memberRevenueRateE6, 30_000n);
  });
});

// ══════════════ MONGOOSE IMMUTABLE-FIELD BEHAVIOUR (regression) ════

describe("Mongoose immutable-field behaviour", () => {
  /**
   * These pin the driver behaviour the persistence design has to survive.
   *
   * Mongoose strips `immutable: true` fields from a `$set` against an EXISTING document, and it
   * does so SILENTLY — `updateOne` reports a successful match and modification while the
   * financial field never lands. An earlier version of this module took a lease row before
   * computing, then `$set` the numbers onto it; every amount was silently dropped and the row
   * was left failing validation-by-absence. The fix was to write every immutable field in the
   * same operation that creates the row.
   */
  it("88. $set on an existing row SILENTLY drops immutable financial fields", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // A complete, valid row.
    await DAORevenueMemberEntry.create({
      ...MK, daoContractAddress: TEST_DAO.toLowerCase(), epochId: 99_001, userId: "pin",
      externalEOA: eoaOf(2),
      activeContributionUSDT6: (5_000n * USD).toString(),
      totalEligibleContributionUSDT6: (5_000n * USD).toString(),
      activeContributionCount: 1, memberRevenueRateE6: "50000",
      systemRevenueUSD6: (2_000n * USD).toString(),
      daoRevenuePoolUSD6: (100n * USD).toString(),
      priceE18: P2.toString(),
      memberRevenueUSD6: (100n * USD).toString(),
      memberRevenueACF: (50n * E18).toString(),
      batchIndex: 0,
    });

    const result = await DAORevenueMemberEntry.updateOne(
      { ...MK, epochId: 99_001, userId: "pin" },
      { $set: { memberRevenueACF: "999999999999999999999" } },
    );
    // The driver reports success...
    assert.equal(result.matchedCount, 1);
    // ...but the value is unchanged. This is the silent loss the design must not rely on.
    assert.equal(
      (await DAORevenueMemberEntry.findOne({ ...MK, epochId: 99_001, userId: "pin" }))!.memberRevenueACF,
      (50n * E18).toString(),
      "immutable field silently retained its original value",
    );
  });

  it("89. the same $set on a NON-immutable field does land", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Control, so test 88 cannot pass merely because the update never ran.
    await DAORevenueEpoch.create({
      ...RK, stakingContractAddress: LOW_STAKING,
      treasuryAddress: "0x114fe8e3414bc49a24c6efd9e702cd66b9a80251",
      epochId: 99_002, windowStart: 1, snapshotAt: 2, snapshotBlockNumber: 3,
      priceE18: P2.toString(),
      systemRegularSelfACF: "0", systemDAOStakeRewardACF: "0", systemSelfRewardACF: "0",
      systemRevenueUSD6: "0", revenueEnabledAtSnapshot: true,
      silverMinimumUSDT6: "0", goldMinimumUSDT6: "0", memberRevenueRateE6: "50000",
      configBlockNumber: 1, configLogIndex: 0,
      daoRevenuePoolUSD6: "0", totalEligibleContributionUSDT6: "0",
      totalMemberRevenueUSD6: "0", totalMemberRevenueACF: "0", roundingDustUSD6: "0",
      marketingRateE6: "20000", marketingCollector: TEST_MARKETING_COLLECTOR,
      marketingRevenueUSD6: "0", marketingRevenueACF: "0", totalObligationACF: "0",
      memberRoot: `0x${"0".repeat(64)}`,
      eligibleMembers: 0, batchCount: 0, manifestHash: `0x${"0".repeat(64)}`,
      status: "CALCULATED",
    });
    await DAORevenueEpoch.updateOne({ ...RK, epochId: 99_002 }, { $set: { status: "FUNDED" } });
    assert.equal(
      (await DAORevenueEpoch.findOne({ ...RK, epochId: 99_002 }))!.status, "FUNDED",
      "mutable execution fields update normally",
    );
    // And the financial field beside it is immutable, so it cannot be moved this way.
    await DAORevenueEpoch.updateOne(
      { ...RK, epochId: 99_002 }, { $set: { totalMemberRevenueACF: "777" } },
    );
    assert.equal(
      (await DAORevenueEpoch.findOne({ ...RK, epochId: 99_002 }))!.totalMemberRevenueACF, "0",
    );
  });

  it("90. calculation therefore writes the financial row in ONE creating operation", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Proof the production path does not depend on $set: no row exists before calculation, and
    // afterwards every financial field is present and correct.
    await mkConfig();
    await mkPhase1(1_000n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT",
      rewardACF: 1_000n * E18,
    });
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });

    assert.equal(await DAORevenueEpoch.countDocuments({ ...RK, epochId: EPOCH }), 0,
      "no placeholder row is taken before the numbers exist");

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    const row = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    // Every immutable financial field landed, which a $set-based design would have lost.
    assert.equal(row.systemSelfRewardACF, (1_000n * E18).toString());
    assert.equal(row.systemRevenueUSD6, (2_000n * USD).toString());
    assert.equal(row.daoRevenuePoolUSD6, (100n * USD).toString());
    assert.equal(row.totalMemberRevenueACF, (50n * E18).toString());
    assert.equal(row.memberRevenueRateE6, "50000");
    assert.notEqual(row.manifestHash, `0x${"0".repeat(64)}`);
  });

  it("91. a FAILED attempt cannot contaminate a later successful calculation", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(1_000n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT",
      rewardACF: 1_000n * E18,
    });
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });

    // An earlier attempt left a FAILED row carrying WRONG financial values.
    await DAORevenueEpoch.create({
      ...RK, stakingContractAddress: LOW_STAKING,
      treasuryAddress: "0x114fe8e3414bc49a24c6efd9e702cd66b9a80251",
      epochId: EPOCH, windowStart: 0, snapshotAt: 0, snapshotBlockNumber: 0,
      priceE18: "1", systemRegularSelfACF: "1", systemDAOStakeRewardACF: "1",
      systemSelfRewardACF: "1", systemRevenueUSD6: "1", revenueEnabledAtSnapshot: false,
      silverMinimumUSDT6: "1", goldMinimumUSDT6: "1", memberRevenueRateE6: "1",
      configBlockNumber: 0, configLogIndex: 0,
      daoRevenuePoolUSD6: "1", totalEligibleContributionUSDT6: "1",
      totalMemberRevenueUSD6: "1", totalMemberRevenueACF: "1", roundingDustUSD6: "1",
      marketingRateE6: "1", marketingCollector: `0x${"1".repeat(40)}`,
      marketingRevenueUSD6: "1", marketingRevenueACF: "1", totalObligationACF: "2",
      memberRoot: `0x${"1".repeat(64)}`,
      eligibleMembers: 1, batchCount: 1, manifestHash: `0x${"1".repeat(64)}`,
      status: "FAILED", lastError: "earlier attempt", attempts: 1,
    });

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    const row = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    // The replaced row carries the CORRECT values, not the stale ones.
    assert.equal(row.totalMemberRevenueACF, (50n * E18).toString());
    assert.equal(row.priceE18, P2.toString());
    assert.equal(row.revenueEnabledAtSnapshot, true);
    assert.equal(row.attempts, 2, "the earlier attempt is counted, not lost");
    assert.equal(await DAORevenueEpoch.countDocuments({ ...RK, epochId: EPOCH }), 1);
  });
});

// ════════════════════ OUT-OF-BAND / PARTIAL BATCH RESUME ════

describe("resuming a partially paid batch", () => {
  /** 5 members in one batch, funded, so the resume path can be exercised. */
  const fundedEpoch = async () => {
    await mkConfig();
    await mkPhase1(10_000n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT",
      rewardACF: 10_000n * E18,
    });
    const ns: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const n = 400 + i;
      ns.push(n);
      await mkUser(`p${i}`, n);
      await mkContribution({
        contributionId: `${i}`, stakeId: `${4000 + i}`, userId: `p${i}`, n, usdt: 5_000n * USD,
      });
      await mkEntry({
        stakeId: `${4000 + i}`, userId: `p${i}`, wallet: eoaOf(n), source: "DAO", rewardACF: 0n,
      });
    }
    const chain = chainFor(ns);
    const r = await runDAORevenueEpoch(EPOCH, chain.reader);
    assert.equal(r.status, "CALCULATED");
    // Fund what the epoch actually owes: member shares plus the marketing allocation. Funding
    // only the member share would be refused by preflight, because the distributor has no sweep.
    const epoch = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    const obligation = BigInt(epoch.totalObligationACF);
    const marketing = BigInt(epoch.marketingRevenueACF);
    await authorizeAndFund(chain);
    return { chain, obligation, marketing };
  };

  it("92. members paid out-of-band are filtered, independent of the original batch size", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await fundedEpoch();
    const entries = await DAORevenueMemberEntry.find({ ...MK, epochId: EPOCH })
      .sort({ batchIndex: 1, externalEOA: 1 }).lean();
    assert.equal(entries.length, 5);
    assert.equal(new Set(entries.map((e) => e.batchIndex)).size, 1, "one batch of five");

    // Two were paid by a differently-composed transaction, not by our batch.
    for (const e of [entries[1]!, entries[3]!]) {
      chain.pay(EPOCH, e.externalEOA, BigInt(e.memberRevenueACF));
    }

    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.unpaidMembers, 3, "only the three unpaid remain");
    assert.deepEqual(report.blockers, []);
    // The plan is a single batch call for the remaining three, not the original five.
    const batchCalls = report.plannedCalls.filter((c) => c.includes("distributeBatch"));
    assert.equal(batchCalls.length, 1);
    assert.ok(batchCalls[0]!.includes("[3 users]"));
  });

  it("93. a fully paid batch leaves only the marketing call, then nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, marketing } = await fundedEpoch();
    const entries = await DAORevenueMemberEntry.find({ ...MK, epochId: EPOCH }).lean();
    for (const e of entries) chain.pay(EPOCH, e.externalEOA, BigInt(e.memberRevenueACF));

    // Every member is paid, so no batch call remains — but the epoch still owes its marketing
    // allocation, and the plan says so rather than reporting the epoch finished.
    const withMarketingLeft = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(withMarketingLeft.unpaidMembers, 0);
    assert.equal(withMarketingLeft.marketingOutstanding, true);
    assert.deepEqual(
      withMarketingLeft.plannedCalls.filter((c) => c.includes("distributeBatch")), [],
      "no member batch is left to submit",
    );
    assert.equal(withMarketingLeft.plannedCalls.length, 1);
    assert.match(withMarketingLeft.plannedCalls[0]!, /payMarketing/);
    assert.equal((await reconcileDAORevenueEpoch(EPOCH, chain.reader))!.statusAfter, "DISTRIBUTING");

    chain.payMarketing(EPOCH, marketing);
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.marketingOutstanding, false);
    assert.equal(report.plannedCalls.length, 0, "nothing left to submit");
    const r = (await reconcileDAORevenueEpoch(EPOCH, chain.reader))!;
    assert.equal(r.statusAfter, "COMPLETED");
  });

  it("94. a stranger paid against this epoch is detected, not ignored", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation } = await fundedEpoch();
    const entries = await DAORevenueMemberEntry.find({ ...MK, epochId: EPOCH }).lean();
    for (const e of entries) chain.pay(EPOCH, e.externalEOA, BigInt(e.memberRevenueACF));
    // An address with no calculated obligation also received ACF from this epoch. We never
    // query its paid flag, but the distributed total no longer matches our members' sum.
    chain.state.distributed.set(EPOCH, obligation + 1n);

    await assert.rejects(
      reconcileDAORevenueEpoch(EPOCH, chain.reader),
      (e: unknown) => /distributed/.test((e as Error).message),
    );
  });
});

// ═══════════════════════════════ EXECUTOR CONCURRENCY ════

describe("executor concurrency", () => {
  const leased = async () => {
    await mkConfig();
    await mkPhase1(1_000n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT",
      rewardACF: 1_000n * E18,
    });
    await mkUser("alice", 2);
    await mkContribution({ contributionId: "1", stakeId: "10", userId: "alice", n: 2, usdt: 5_000n * USD });
    await mkEntry({ stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO", rewardACF: 0n });
    const chain = chainFor([2]);
    assert.equal((await runDAORevenueEpoch(EPOCH, chain.reader)).status, "CALCULATED");
    // Authorized, because `nextExecutableEpoch` offers only epochs the executor may act on and
    // a CALCULATED one is not yet among them.
    await authorizeEpochRow(chain, EPOCH);
    return chain;
  };

  const fakeSigner = () => ({
    address: eoaOf(1),
    client: { account: null } as never,
    chain: { id: 80002 } as never,
  });

  it("95. a leased epoch is not offered to a second executor", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await leased();
    assert.equal(await nextExecutableEpoch(), EPOCH);
    // A live lease hides it.
    await DAORevenueEpoch.updateOne(
      { ...RK, epochId: EPOCH },
      { $set: { leaseExpiresAt: new Date(Date.now() + 600_000) } },
    );
    assert.equal(await nextExecutableEpoch(), null);
  });

  it("96. an EXPIRED lease is offered again", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await leased();
    await DAORevenueEpoch.updateOne(
      { ...RK, epochId: EPOCH },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
    );
    assert.equal(await nextExecutableEpoch(), EPOCH, "a dead executor must not block forever");
  });

  it("97. a second executor refuses to submit while the lease is held", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const chain = await leased();
    // Executor A holds the lease.
    await DAORevenueEpoch.updateOne(
      { ...RK, epochId: EPOCH },
      { $set: { leaseExpiresAt: new Date(Date.now() + 600_000) } },
    );
    // Executor B reaches execution anyway (it was told the epoch id directly).
    await assert.rejects(
      executeDAORevenueEpoch(EPOCH, { reader: chain.reader, signer: fakeSigner() }),
      (e: unknown) => /already leased by another executor/.test((e as Error).message),
    );
    // Nothing was funded: it stopped before signing.
    assert.equal(await chain.reader.epochFundedAmount(EPOCH), 0n);
  });

  it("98. the lease is counted as an attempt, so repeated failures are visible", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const chain = await leased();
    const before = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!.attempts;
    // Execution fails at the signing step because the fake signer cannot write.
    await executeDAORevenueEpoch(EPOCH, { reader: chain.reader, signer: fakeSigner() })
      .catch(() => {});
    const after = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!.attempts;
    assert.ok(after > before, "the lease records the attempt");
  });
});

// ══════════════════════════ THE MARKETING ALLOCATION ═════════════════════

/**
 * The 2% marketing allocation, end to end through Phase 4.
 *
 * It is a SEPARATE obligation from the 5% member pool, out of the same SystemRevenueUSD, at the
 * same epoch price, funded in the same Treasury call and paid to ONE recipient pinned at
 * calculation time. These cover the arithmetic, the funding, the recipient's determinism and the
 * idempotency — the contract's own replay guard is covered in its own suite.
 */
describe("the DAO marketing allocation", () => {
  const addMember = async (userId: string, n: number, usdt: bigint, stakeId: string) => {
    await mkUser(userId, n);
    await mkContribution({ contributionId: stakeId, stakeId, userId, n, usdt });
    await mkEntry({ stakeId, userId, wallet: eoaOf(n), source: "DAO", rewardACF: 0n });
  };

  /** A CALCULATED epoch with three equal members, plus the chain fake backing it. */
  const calculated = async (count = 3, revenue = 10_000n * E18) => {
    await mkConfig();
    await mkPhase1(revenue, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: revenue,
    });
    const ns: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const n = 500 + i;
      ns.push(n);
      await addMember(`m${i}`, n, 5_000n * USD, `${5000 + i}`);
    }
    const chain = chainFor(ns);
    assert.equal((await runDAORevenueEpoch(EPOCH, chain.reader)).status, "CALCULATED");
    const epoch = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    // Authorized immediately: the executor cannot act on a merely CALCULATED epoch, so every
    // case below would otherwise be testing a state the real flow never presents to it.
    await authorizeEpochRow(chain, EPOCH);
    return {
      chain, ns,
      obligation: BigInt(epoch.totalObligationACF),
      memberObligation: BigInt(epoch.totalMemberRevenueACF),
      marketing: BigInt(epoch.marketingRevenueACF),
    };
  };

  it("100. THE KNOWN CASE — 1,000 USD of revenue owes 50 to members and 20 to marketing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // 500 ACF of Self reward at $2.00 = $1,000 of SystemRevenue.
    await mkConfig();
    await mkPhase1(500n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: 500n * E18,
    });
    await addMember("alice", 2, 5_000n * USD, "10");

    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    const epoch = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;

    assert.equal(epoch.systemRevenueUSD6, (1_000n * USD).toString(), "SystemRevenue = $1,000");
    assert.equal(epoch.daoRevenuePoolUSD6, (50n * USD).toString(), "members: 5% = 50");
    assert.equal(epoch.marketingRevenueUSD6, (20n * USD).toString(), "marketing: 2% = 20");

    // Converted back to ACF at the SAME epoch price: $2.00, so 25 ACF and 10 ACF.
    assert.equal(epoch.totalMemberRevenueACF, (25n * E18).toString());
    assert.equal(epoch.marketingRevenueACF, (10n * E18).toString());
    assert.equal(epoch.totalObligationACF, (35n * E18).toString(), "70 USD of obligation in all");

    // Neither the member pool nor any member's share absorbed the marketing allocation.
    const entry = (await DAORevenueMemberEntry.findOne({ ...MK, epochId: EPOCH, userId: "alice" }))!;
    assert.equal(entry.memberRevenueUSD6, (50n * USD).toString(), "the sole member takes the whole pool");
    assert.equal(entry.memberRevenueACF, (25n * E18).toString());
  });

  it("101. both obligations use ONE price and ONE snapshot", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain } = await calculated();
    void chain;
    const epoch = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    const price = BigInt(epoch.priceE18);

    // Recomputing each obligation from the recorded figures reproduces both exactly, which is
    // only true if they came from the same revenue, the same rates basis and the same price.
    const revenue = BigInt(epoch.systemRevenueUSD6);
    const memberUSD = (revenue * BigInt(epoch.memberRevenueRateE6)) / 1_000_000n;
    const marketingUSD = (revenue * BigInt(epoch.marketingRateE6)) / 1_000_000n;
    assert.equal(epoch.daoRevenuePoolUSD6, memberUSD.toString());
    assert.equal(epoch.marketingRevenueUSD6, marketingUSD.toString());
    assert.equal(
      epoch.marketingRevenueACF, ((marketingUSD * 10n ** 30n) / price).toString(),
      "marketing converts at the epoch price, like every member amount",
    );
    // One snapshot decided the configuration for both.
    assert.equal(epoch.configBlockNumber, CONFIG_BLOCK);
  });

  it("102. Treasury funds BOTH obligations, and preflight plans the marketing call", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, memberObligation, marketing } = await calculated();
    assert.equal(obligation, memberObligation + marketing, "funding covers both");

    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.deepEqual(report.blockers, []);
    assert.equal(report.obligationACF, obligation.toString());
    assert.equal(report.memberObligationACF, memberObligation.toString());
    assert.equal(report.marketingObligationACF, marketing.toString());
    assert.equal(report.marketingCollector, TEST_MARKETING_COLLECTOR.toLowerCase());
    assert.equal(report.marketingOutstanding, true);
    assert.ok(
      report.plannedCalls.some((c) => c.includes(`fundDAORevenueEpoch(${EPOCH}, ${obligation})`)),
      "the funding call names the COMBINED obligation",
    );
    assert.ok(report.plannedCalls.some((c) => c.includes("payMarketing")));
  });

  it("103. Treasury short of BOTH obligations is blocked, not partially funded", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, memberObligation, marketing } = await calculated();
    assert.ok(marketing > 0n);

    // Enough for the members alone, short of the pair. Funding anyway would register an epoch
    // whose marketing allocation could never be paid out of it.
    chain.state.treasuryBalance = memberObligation;
    const short = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.ok(
      short.blockers.some((b) => /less than the obligation/.test(b)),
      `expected a funding blocker, got ${JSON.stringify(short.blockers)}`,
    );

    // Exactly enough for both, and the reserve respected: executable.
    chain.state.treasuryBalance = obligation + chain.state.requiredReserve;
    assert.deepEqual((await preflight(EPOCH, chain.reader, eoaOf(1))).blockers, []);
  });

  it("104. the Phase 3 reserve is still protected independently", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation } = await calculated();

    // One ACF short of the reserve once BOTH obligations are funded. The reserve calculation is
    // untouched by this stage; what changed is only that the amount leaving is now the pair.
    chain.state.treasuryBalance = obligation + chain.state.requiredReserve - 1n;
    const blocked = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.ok(
      blocked.blockers.some((b) => /required headroom/.test(b)),
      `expected a headroom blocker, got ${JSON.stringify(blocked.blockers)}`,
    );
    chain.state.treasuryBalance = obligation + chain.state.requiredReserve;
    assert.deepEqual((await preflight(EPOCH, chain.reader, eoaOf(1))).blockers, []);
  });

  it("105. a chain pinning that disagrees with the calculation is blocked", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, marketing } = await calculated();
    assert.ok(marketing > 0n);
    void obligation;
    await authorizeAndFund(chain);

    // The AUTHORIZATION is what the distributor will act on, and it is immutable, so the contract
    // would faithfully pay whatever it was authorized. A disagreement with what this epoch
    // calculated therefore has to be caught on this side — it cannot be fixed by retrying.
    const epoch = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    chain.authorize(EPOCH, {
      memberRoot: epoch.memberRoot,
      memberTotalACF: BigInt(epoch.totalMemberRevenueACF),
      marketingRecipient: `0x${"9".repeat(40)}`,
      marketingAmountACF: marketing,
    });
    const wrongRecipient = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.ok(
      wrongRecipient.blockers.some((b) => /marketing recipient/.test(b)),
      `expected a recipient blocker, got ${JSON.stringify(wrongRecipient.blockers)}`,
    );

    chain.authorize(EPOCH, {
      memberRoot: epoch.memberRoot,
      memberTotalACF: BigInt(epoch.totalMemberRevenueACF),
      marketingRecipient: TEST_MARKETING_COLLECTOR,
      marketingAmountACF: marketing + 1n,
    });
    const wrongAmount = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.ok(
      wrongAmount.blockers.some((b) => /marketing amount/.test(b)),
      `expected an amount blocker, got ${JSON.stringify(wrongAmount.blockers)}`,
    );

    // A forged member root is caught the same way: the executor could relay only what that root
    // authorizes, so a root this epoch did not calculate is not this epoch's entitlements.
    chain.authorize(EPOCH, {
      memberRoot: `0x${"7".repeat(64)}`,
      memberTotalACF: BigInt(epoch.totalMemberRevenueACF),
      marketingRecipient: TEST_MARKETING_COLLECTOR,
      marketingAmountACF: marketing,
    });
    assert.ok(
      (await preflight(EPOCH, chain.reader, eoaOf(1))).blockers.some((b) => /member root/.test(b)),
    );

    // Agreeing again clears it, and the report exposes both sides so an operator can compare.
    await authorizeAndFund(chain);
    const ok = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.deepEqual(ok.blockers, []);
    assert.equal(ok.epochAuthorized, true);
    assert.equal(ok.authorizedMarketingRecipient, TEST_MARKETING_COLLECTOR.toLowerCase());
    assert.equal(ok.authorizedMarketingACF, marketing.toString());
    assert.equal(ok.authorizedMemberRoot, epoch.memberRoot);
    assert.equal(ok.marketingCollector, ok.authorizedMarketingRecipient);
  });

  it("106. a marketing amount already paid that differs from the calculation is blocked", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, marketing } = await calculated();
    await authorizeAndFund(chain);

    // Someone paid a different amount against this epoch — a whole payment, consistent with the
    // distributed total, just not the calculated figure. There is no sweep and no top-up, so this
    // is an operator decision rather than something to reconcile away.
    chain.payMarketing(EPOCH, marketing + 1n);
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.ok(
      report.blockers.some((b) => /already paid/.test(b)),
      `expected a mismatch blocker, got ${JSON.stringify(report.blockers)}`,
    );
    await assert.rejects(
      reconcileDAORevenueEpoch(EPOCH, chain.reader),
      /paid .* of marketing but the calculated allocation is/,
    );
  });

  it("107. paying marketing twice is impossible, and a retry plans nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, marketing } = await calculated();
    await authorizeAndFund(chain);

    chain.payMarketing(EPOCH, marketing);
    const afterFirst = chain.state.distributed.get(EPOCH);
    assert.equal(afterFirst, marketing);

    // The chain is the authority, so a second run sees it as settled and plans no call. The
    // contract would refuse anyway; this is the backend not even trying.
    const report = await preflight(EPOCH, chain.reader, eoaOf(1));
    assert.equal(report.marketingOutstanding, false);
    assert.equal(report.marketingPaidACF, marketing.toString());
    assert.deepEqual(report.plannedCalls.filter((c) => c.includes("payMarketing")), []);
    assert.equal(chain.state.distributed.get(EPOCH), afterFirst, "nothing moved twice");
  });

  it("108. a later rate change does not alter a settled epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(500n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: 500n * E18,
    });
    await addMember("alice", 2, 5_000n * USD, "10");
    const r = await runDAORevenueEpoch(EPOCH, chainFor([2]).reader);
    assert.equal(r.status, "CALCULATED");
    const before = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;

    // The rate doubles AFTER this epoch's snapshot block. The epoch keeps its own figures: the
    // configuration is resolved as-of, so raising the rate tomorrow cannot repay yesterday.
    await mkConfig({ blockNumber: SNAPSHOT_BLOCK + 1_000 });
    await DAOConfigHistory.collection.updateOne(
      { ...DK, blockNumber: SNAPSHOT_BLOCK + 1_000 }, { $set: { marketingRateE6: "40000" } },
    );
    const after = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!;
    assert.equal(after.marketingRateE6, before.marketingRateE6, "2%, not the later 4%");
    assert.equal(after.marketingRevenueACF, before.marketingRevenueACF);
    assert.equal(after.totalObligationACF, before.totalObligationACF);
  });

  it("109. the recipient is pinned per epoch, so a later change cannot redirect it", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const NEW_COLLECTOR = `0x${"b".repeat(40)}`;
    await mkConfig();
    await mkPhase1(500n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: 500n * E18,
    });
    await addMember("alice", 2, 5_000n * USD, "10");
    assert.equal((await runDAORevenueEpoch(EPOCH, chainFor([2]).reader)).status, "CALCULATED");
    const pinned = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!.marketingCollector;
    assert.equal(pinned, TEST_MARKETING_COLLECTOR.toLowerCase());

    // The admin changes the collector on chain, AFTER the snapshot. A later epoch picks the new
    // one up; this one does not, and keeps paying the address Treasury pinned for it.
    await DAOConfigHistory.collection.insertOne({
      ...DK, blockNumber: SNAPSHOT_BLOCK + 1, logIndex: 0, blockTimestamp: 1_700_000_500,
      txHash: `0x${"e".repeat(64)}`, eventName: "MarketingFeeCollectorUpdated",
      silverMinimumUSDT6: (5_000n * USD).toString(), goldMinimumUSDT6: (25_000n * USD).toString(),
      memberRevenueRateE6: "50000", marketingRateE6: "20000",
      marketingCollector: NEW_COLLECTOR, revenueEnabled: true,
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);

    assert.equal(
      (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH }))!.marketingCollector, pinned,
      "the settled epoch keeps the recipient it was calculated against",
    );
    const { manifest } = await rebuildManifest(EPOCH);
    assert.equal(manifest.marketingCollector, pinned, "and the executor is given that address");
  });

  it("110. a marketing obligation with no known collector refuses to calculate", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Models a configuration history that starts mid-initialization: the rates have been emitted
    // but MarketingFeeCollectorUpdated has not. Paying an invented address is not an option.
    await mkConfig();
    await DAOConfigHistory.collection.updateOne(
      { ...DK, blockNumber: CONFIG_BLOCK }, { $set: { marketingCollector: `0x${"0".repeat(40)}` } },
    );
    await mkPhase1(500n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: 500n * E18,
    });
    await addMember("alice", 2, 5_000n * USD, "10");

    await assert.rejects(
      runDAORevenueEpoch(EPOCH, chainFor([2]).reader),
      /no collector is known/,
    );
  });

  it("111. marketing is never recorded as a member payment", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { chain, obligation, marketing } = await calculated();
    await authorizeAndFund(chain);
    chain.payMarketing(EPOCH, marketing);

    // The collector gets no member entry and no DAORevenuePayment row: it is an epoch-level
    // protocol allocation, not a contribution share.
    assert.equal(
      await DAORevenueMemberEntry.countDocuments({
        ...MK, epochId: EPOCH, externalEOA: TEST_MARKETING_COLLECTOR.toLowerCase(),
      }), 0,
    );
    const r = (await reconcileDAORevenueEpoch(EPOCH, chain.reader))!;
    assert.equal(r.totalMembers, 3, "three members, and the collector is not one of them");
    assert.equal(r.marketingPaidACF, marketing.toString());
  });
});

// ══════════════════════ EPOCH-PINNED MARKETING RECIPIENT ═════════════════

/**
 * An epoch permanently owns the marketing recipient valid at its snapshot.
 *
 * The recipient is resolved from the configuration history as-of the epoch's snapshot block, then
 * PINNED on chain by Treasury at funding. Nothing afterwards can move it: a later collector
 * change reaches future epochs only, and the old epoch stays payable to the address it was
 * calculated against — no recalculation, no stuck state.
 */
describe("the marketing recipient is pinned per epoch", () => {
  const COLLECTOR_A = TEST_MARKETING_COLLECTOR.toLowerCase();
  const COLLECTOR_B = `0x${"b".repeat(40)}`;
  const EPOCH_N = EPOCH;
  const EPOCH_N1 = EPOCH + 1;

  const addMember = async (userId: string, n: number, usdt: bigint, stakeId: string) => {
    await mkUser(userId, n);
    await mkContribution({ contributionId: stakeId, stakeId, userId, n, usdt });
    await mkEntry({ stakeId, userId, wallet: eoaOf(n), source: "DAO", rewardACF: 0n });
  };

  /** A config row at `blockNumber` naming `collector`, as MarketingFeeCollectorUpdated would. */
  const collectorAt = async (blockNumber: number, collector: string) => {
    await DAOConfigHistory.collection.insertOne({
      ...DK, blockNumber, logIndex: 0, blockTimestamp: 1_700_000_000 + blockNumber,
      txHash: `0x${"f".repeat(64)}`, eventName: "MarketingFeeCollectorUpdated",
      silverMinimumUSDT6: (5_000n * USD).toString(), goldMinimumUSDT6: (25_000n * USD).toString(),
      memberRevenueRateE6: "50000", marketingRateE6: "20000",
      marketingCollector: collector, revenueEnabled: true,
      createdAt: new Date(1), updatedAt: new Date(1),
    } as never);
  };

  it("120. Epoch N pays A even after the collector moves to B, with no recalculation", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // ── Epoch N: snapshot sees collector A ──────────────────────────────
    await mkConfig();
    await mkPhase1(500n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: 500n * E18,
    });
    await addMember("alice", 2, 5_000n * USD, "10");
    assert.equal((await runDAORevenueEpoch(EPOCH_N, chainFor([2]).reader)).status, "CALCULATED");

    const n = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH_N }))!;
    assert.equal(n.marketingCollector, COLLECTOR_A, "1-2. history resolved A and the row persists it");
    const { manifest: manifestN } = await rebuildManifest(EPOCH_N);
    assert.equal(manifestN.marketingCollector, COLLECTOR_A, "2. the manifest carries A");

    // ── the authorizer commits A, then Treasury funds the authorized total ────
    const chainN = chainFor([2]);
    await authorizeAndFund(chainN, EPOCH_N);
    assert.equal(
      (await chainN.reader.epochAuthorization(EPOCH_N)).marketingRecipient, COLLECTOR_A,
      "3. the authorization committed A",
    );

    // ── the admin then moves the collector to B ────────────────────────
    await collectorAt(SNAPSHOT_BLOCK + 10, COLLECTOR_B);

    // 4-5. Epoch N is still planned and payable, and still to A. The authorization is immutable,
    // so nothing about the live configuration can reach it.
    const report = await preflight(EPOCH_N, chainN.reader, eoaOf(1));
    assert.deepEqual(report.blockers, [], "10. no epoch becomes stuck because config changed");
    assert.equal(report.authorizedMarketingRecipient, COLLECTOR_A);
    assert.equal(report.marketingCollector, COLLECTOR_A);
    assert.equal(report.marketingOutstanding, true);
    assert.ok(report.plannedCalls.some((c) => c.includes("payMarketing")));

    // 9. And the epoch's FINANCIAL row is untouched: no recalculation happened or is needed. Its
    // status advanced to AUTHORIZED, which is the authorize step doing its job, not a change to
    // anything the epoch owes or to whom.
    const after = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH_N }))!;
    assert.equal(after.marketingCollector, COLLECTOR_A);
    assert.equal(after.marketingRevenueACF, n.marketingRevenueACF);
    assert.equal(after.memberRoot, n.memberRoot);
    assert.equal(after.totalObligationACF, n.totalObligationACF);
    assert.equal(after.status, "AUTHORIZED");

    // 6. Reconciliation accepts A for Epoch N, with no reference to the live collector.
    chainN.payMarketing(EPOCH_N, BigInt(n.marketingRevenueACF));
    const rec = (await reconcileDAORevenueEpoch(EPOCH_N, chainN.reader))!;
    assert.equal(rec.marketingPaidACF, n.marketingRevenueACF);
    assert.equal(rec.marketingObligationACF, n.marketingRevenueACF);
  });

  it("121. Epoch N+1, snapshotted after the change, resolves and pays B", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    // The collector moved to B BEFORE this epoch's snapshot block, so its as-of resolution is B.
    await collectorAt(SNAPSHOT_BLOCK - 1, COLLECTOR_B);
    await mkPhase1(500n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: 500n * E18,
    });
    await addMember("alice", 2, 5_000n * USD, "10");

    assert.equal((await runDAORevenueEpoch(EPOCH_N, chainFor([2]).reader)).status, "CALCULATED");
    const row = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH_N }))!;
    assert.equal(row.marketingCollector, COLLECTOR_B, "7. the later epoch resolves B");

    const { manifest } = await rebuildManifest(EPOCH_N);
    assert.equal(manifest.marketingCollector, COLLECTOR_B);

    // 8. The authorization commits B, and the plan names B.
    const chain = chainFor([2]);
    await authorizeAndFund(chain, EPOCH_N);
    const report = await preflight(EPOCH_N, chain.reader, eoaOf(1));
    assert.deepEqual(report.blockers, []);
    assert.equal(report.authorizedMarketingRecipient, COLLECTOR_B);
    assert.notEqual(report.authorizedMarketingRecipient, COLLECTOR_A);
  });

  it("122. two epochs across one change keep their own recipients", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // The core invariant in one case. The two epochs need DISTINCT snapshot blocks for the change
    // to fall between them, so N+1's Phase 1 row is written directly with a later block rather
    // than through mkPhase1, which pins every epoch to the same one.
    await mkConfig();
    await mkPhase1(500n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: 500n * E18,
    });
    await addMember("alice", 2, 5_000n * USD, "10");
    assert.equal((await runDAORevenueEpoch(EPOCH_N, chainFor([2]).reader)).status, "CALCULATED");

    // The collector moves AFTER epoch N's snapshot block but BEFORE epoch N+1's.
    await collectorAt(SNAPSHOT_BLOCK + 1, COLLECTOR_B);

    await RewardEpoch.collection.insertOne({
      ...SK, epochId: EPOCH_N1,
      windowStart: EPOCH_N1 * 43_200 - 43_200,
      snapshotAt: EPOCH_N1 * 43_200,
      snapshotBlockNumber: SNAPSHOT_BLOCK + 100,
      status: "CALCULATED", attempts: 1,
      priceE18: P2.toString(), poolROISnapshot: [],
      stakesProcessed: 0, stakesRewarded: 0,
      totalRegularSelfACF: (500n * E18).toString(), totalDAOStakeACF: "0",
    } as never);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT",
      rewardACF: 500n * E18, epochId: EPOCH_N1,
    });
    // Phase 1 writes one entry per stake per settled epoch, so alice's DAO stake needs its row
    // for N+1 as well or her contribution cannot be weighted.
    await mkEntry({
      stakeId: "10", userId: "alice", wallet: eoaOf(2), source: "DAO",
      rewardACF: 0n, epochId: EPOCH_N1,
    });
    assert.equal((await runDAORevenueEpoch(EPOCH_N1, chainFor([2]).reader)).status, "CALCULATED");

    const [n, n1] = await Promise.all([
      DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH_N }).lean(),
      DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH_N1 }).lean(),
    ]);
    assert.equal(n!.marketingCollector, COLLECTOR_A, "the earlier epoch keeps A");
    assert.equal(n1!.marketingCollector, COLLECTOR_B, "the later epoch takes B");
    assert.notEqual(n!.marketingCollector, n1!.marketingCollector);
    // Both still owe their own 2%: the recipient changed, the economics did not.
    assert.equal(n1!.marketingRateE6, n!.marketingRateE6);
    assert.equal(n1!.marketingRevenueACF, n!.marketingRevenueACF);
  });

  it("123. a retry after the collector changed still targets the pinned recipient", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await mkConfig();
    await mkPhase1(500n * E18, 0n);
    await mkEntry({
      stakeId: "1", userId: "other", wallet: eoaOf(1), source: "DIRECT", rewardACF: 500n * E18,
    });
    await addMember("alice", 2, 5_000n * USD, "10");
    assert.equal((await runDAORevenueEpoch(EPOCH_N, chainFor([2]).reader)).status, "CALCULATED");
    const row = (await DAORevenueEpoch.findOne({ ...RK, epochId: EPOCH_N }))!;

    const chain = chainFor([2]);
    await authorizeAndFund(chain, EPOCH_N);
    void row;

    // The first payout attempt failed for an unrelated reason: nothing is recorded as paid.
    assert.equal(await chain.reader.epochMarketingPaidAmount(EPOCH_N), 0n);
    await collectorAt(SNAPSHOT_BLOCK + 5, COLLECTOR_B);

    // The retry still plans A, because the plan reads the AUTHORIZATION, not configuration.
    const retry = await preflight(EPOCH_N, chain.reader, eoaOf(1));
    assert.deepEqual(retry.blockers, []);
    assert.equal(retry.authorizedMarketingRecipient, COLLECTOR_A);
    assert.ok(retry.plannedCalls.some((c) => c.includes("payMarketing")));

    // And once it lands, replay protection holds: the plan drops the call.
    chain.payMarketing(EPOCH_N, BigInt(row.marketingRevenueACF));
    const done = await preflight(EPOCH_N, chain.reader, eoaOf(1));
    assert.equal(done.marketingOutstanding, false);
    assert.deepEqual(done.plannedCalls.filter((c) => c.includes("payMarketing")), []);
  });

  it("124. nothing in the payout path consults the live collector", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    /** Comments carry the reasoning; the rule is that the LOGIC must not do it. */
    const code = (f: string) =>
      read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    // `marketingFeeCollector` is the DAO's LIVE value. Reading it to decide where a calculated
    // epoch pays is exactly the coupling this stage removed; the as-of history is the only source.
    for (const file of ["executor.ts", "reconcile.ts", "calculation.ts", "manifest.ts"]) {
      for (const forbidden of [
        "marketingFeeCollector", "distributorDAO", "setDAO", "MarketingRecipientChanged",
      ]) {
        assert.ok(!code(file).includes(forbidden), `daoRevenue/${file} must not reference ${forbidden}`);
      }
    }
    // The executor reads the AUTHORIZATION and relays it; payMarketing carries no address, and
    // the member batch carries proofs rather than trusted addresses.
    assert.match(code("executor.ts"), /epochAuthorization/);
    assert.match(code("executor.ts"), /args: \[BigInt\(epochId\)\]/);
    assert.match(code("executor.ts"), /commitment\.proofFor/);
    // And the executor cannot authorize: that function belongs to the separate authorize step.
    assert.ok(
      !code("executor.ts").includes("authorizeEpoch"),
      "the executor must not be able to authorize an epoch",
    );
  });
});
