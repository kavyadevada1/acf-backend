import { assertDisposable, TEST_STAKING } from "../settlement/testenv.ts";

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";

const TEST_URI = process.env.MONGODB_TEST_URI;

const { getLedgerPage, getLedgerTotals } = await import("./service.js");
const { Swap } = await import("../models/Swap.js");
const { BondPurchase } = await import("../models/BondPurchase.js");
const { Stake } = await import("../models/Stake.js");
const { StakeRewardEntry } = await import("../models/StakeRewardEntry.js");
const { TeamRewardEntry } = await import("../models/TeamRewardEntry.js");
const { RewardClaim } = await import("../models/RewardClaim.js");
const { DAORevenuePayment } = await import("../models/DAORevenuePayment.js");

const LOW = TEST_STAKING.toLowerCase();
const K = { chainId: 80002, stakingContractAddress: LOW };
const U = "usr_ledger";
const E18 = 10n ** 18n;
const EPOCH = 41_461;

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (!connected) return;
  await Promise.all([
    Swap.deleteMany({}), BondPurchase.deleteMany({}), Stake.deleteMany({}),
    StakeRewardEntry.deleteMany({}), TeamRewardEntry.deleteMany({}),
    RewardClaim.deleteMany({}), DAORevenuePayment.deleteMany({}),
  ]);
});

/** A self-reward entry for one stake in one cycle. Several make a group. */
async function addSelfReward(
  userId: string, stakeId: string, epochId: number, rewardACF: bigint, poolId = 2,
): Promise<void> {
  await StakeRewardEntry.collection.insertOne({
    ...K, stakeId, epochId, userId, externalEOA: "0x" + "1".repeat(40),
    source: "BOND", poolId, principalACF: (200n * E18).toString(),
    compoundBaseACF: (200n * E18).toString(), rewardACF: rewardACF.toString(),
    cumulativeEarnedACF: rewardACF.toString(), rateApplied: "5000", rateDenominator: "1000000",
    rewardEligible: true, ineligibleReason: null, snapshotAt: 4_000_000,
  } as never);
}

/** One record in every source, for one member, at known instants. */
async function seedOneOfEach(userId = U): Promise<void> {
  await Swap.collection.insertOne({
    eventId: `${userId}-swap-1`, userId, externalEOA: "0x" + "1".repeat(40),
    direction: "BUY", acfAmount: (100n * E18).toString(), grossUSDT: "250000000",
    sellFeeUSDT: "0", netUSDT: "250000000",
    blockNumber: 100, txHash: `0x${userId.length.toString(16).padStart(2, "0")}${"a".repeat(62)}`, logIndex: 0,
    blockTimestamp: new Date(1_000_000 * 1000),
  } as never);

  await BondPurchase.collection.insertOne({
    eventId: `${userId}-bond-1`, ...K, bondContractAddress: LOW, purchaseId: `${userId}-p1`,
    userId, externalEOA: "0x" + "1".repeat(40), offerId: 1, poolId: 2,
    usdtPaid: "500000000", discountUsed: "50000", executionPriceE18: E18.toString(),
    acfStaked: (200n * E18).toString(), linkedStakeId: `${userId}-stk-1`,
    txHash: `0x${userId.length.toString(16).padStart(2, "0")}${"b".repeat(62)}`, blockNumber: 200, logIndex: 0,
    blockTimestamp: new Date(2_000_000 * 1000),
  } as never);

  await Stake.collection.insertOne({
    eventId: `${userId}-stake-1`, ...K, stakeId: `${userId}-stk-1`, userId,
    externalEOA: "0x" + "1".repeat(40), poolId: 2,
    principalACF: (200n * E18).toString(), source: "BOND", poolDailyROIAtCreation: "5000",
    stakeTimestamp: new Date(3_000_000 * 1000), unlockTimestamp: new Date(9_000_000 * 1000),
    active: true, withdrawnAt: null, withdrawTxHash: null, withdrawnBlockNumber: null,
    withdrawnBlockTimestamp: null,
    txHash: `0x${userId.length.toString(16).padStart(2, "0")}${"c".repeat(62)}`, blockNumber: 300, logIndex: 0,
  } as never);

  await addSelfReward(userId, `${userId}-stk-1`, EPOCH, 5n * E18);

  await TeamRewardEntry.collection.insertOne({
    ...K, epochId: EPOCH, userId,
    levelRewardACF: (1n * E18).toString(),
    rankRewardACF: (2n * E18).toString(),
    globalRewardACF: (3n * E18).toString(),
    teamRewardACF: (6n * E18).toString(),
    levelAudit: { unlockedLevels: 2, directCount: 4, perLevel: [] },
    rankAudit: { rank: 1 }, globalAudit: {},
  } as never);

  await RewardClaim.collection.insertOne({
    chainId: 80002, withdrawalAddress: LOW, txHash: `0x${userId.length.toString(16).padStart(2, "0")}${"d".repeat(62)}`, logIndex: 0,
    userId, externalEOA: "0x" + "1".repeat(40), checkpointId: 1,
    claimedACF: (10n * E18).toString(), cumulativeSelfACF: (10n * E18).toString(),
    cumulativeTeamACF: "0", usdtFee: "1500000", claimFeePercentage: "150000",
    priceE18: E18.toString(), blockNumber: 500, blockTimestamp: 5_000_000,
  } as never);

  await DAORevenuePayment.collection.insertOne({
    chainId: 80002, distributorAddress: LOW, epochId: EPOCH, userId,
    externalEOA: "0x" + "1".repeat(40),
    expectedAmountACF: (7n * E18).toString(), amountPaidACF: (7n * E18).toString(),
    txHash: `0x${userId.length.toString(16).padStart(2, "0")}${"e".repeat(62)}`, logIndex: 0, blockNumber: 600, blockTimestamp: 6_000_000,
  } as never);
}

describe("ledger reads every source", () => {
  it("1. one record in each source produces one row per movement", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach();
    const page = await getLedgerPage({ userId: U, limit: 50 });

    // Seven documents, but the team entry carries three distinct rewards.
    assert.equal(page.rows.length, 9);
    assert.deepEqual(
      [...new Set(page.rows.map((r) => r.kind))].sort(),
      ["BOND_PURCHASE", "DAO_REVENUE", "GLOBAL_REWARD", "LEVEL_REWARD", "RANK_REWARD",
       "REWARD_CLAIM", "SELF_REWARD", "STAKE_OPENED", "SWAP_BUY"],
    );
  });

  it("2. rows arrive newest first", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach();
    const { rows } = await getLedgerPage({ userId: U, limit: 50 });
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1]!.occurredAt >= rows[i]!.occurredAt, "descending");
    }
  });

  it("3. amounts are the records' own, in base units", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach();
    const { rows } = await getLedgerPage({ userId: U, limit: 50 });
    const byKind = new Map(rows.map((r) => [r.kind, r]));

    const buy = byKind.get("SWAP_BUY")!;
    assert.equal(buy.primary.amount, (100n * E18).toString());
    assert.equal(buy.primary.unit, "ACF");
    assert.equal(buy.counter!.amount, "250000000");
    assert.equal(buy.counter!.unit, "USDT");
    assert.equal(buy.fee, null, "a buy pays no sell fee");

    const claim = byKind.get("REWARD_CLAIM")!;
    assert.equal(claim.primary.amount, (10n * E18).toString());
    assert.equal(claim.fee!.amount, "1500000");
    assert.equal(claim.fee!.unit, "USDT", "the claim fee is USDT, never burned ACF");

    // No float anywhere: every amount is a decimal string of base units.
    for (const r of rows) {
      assert.match(r.primary.amount, /^\d+$/, r.rowId);
      if (r.counter) assert.match(r.counter.amount, /^\d+$/, r.rowId);
      if (r.fee) assert.match(r.fee.amount, /^\d+$/, r.rowId);
    }
  });

  it("4. calculated rewards carry no transaction, on-chain movements do", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach();
    const { rows } = await getLedgerPage({ userId: U, limit: 50 });
    for (const r of rows) {
      const calculated = ["SELF_REWARD", "LEVEL_REWARD", "RANK_REWARD", "GLOBAL_REWARD"]
        .includes(r.kind);
      if (calculated) {
        assert.equal(r.txHash, null, `${r.kind} has no transaction until claimed`);
        assert.equal(r.epochId, EPOCH, `${r.kind} belongs to a cycle`);
      } else {
        assert.match(r.txHash ?? "", /^0x[0-9a-f]{64}$/, r.kind);
      }
    }
  });

  it("5. a stake is a MOVE, not income or spend", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach();
    const { rows } = await getLedgerPage({ userId: U, limit: 50 });
    assert.equal(rows.find((r) => r.kind === "STAKE_OPENED")!.direction, "MOVE");
  });

  it("6. another member's records never appear", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach(U);
    await seedOneOfEach("usr_someone_else");
    const { rows } = await getLedgerPage({ userId: U, limit: 50 });
    assert.equal(rows.length, 9, "only this member's nine");
  });
});

describe("ledger filtering and paging against a database", () => {
  it("7. a kind filter returns only that kind", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach();
    const { rows } = await getLedgerPage({ userId: U, limit: 50, kinds: ["RANK_REWARD"] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "RANK_REWARD");
    assert.equal(rows[0]!.primary.amount, (2n * E18).toString());
  });

  it("8. paging covers the history once, with no repeats", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach();
    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await getLedgerPage({ userId: U, limit: 2, before });
      seen.push(...page.rows.map((r) => r.rowId));
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    assert.equal(seen.length, 9, "every row, once");
    assert.equal(new Set(seen).size, 9, "and none twice");
  });

  it("9. the three team rewards share a cycle boundary and still page cleanly", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach();
    const { rows } = await getLedgerPage({
      userId: U, limit: 50,
      kinds: ["LEVEL_REWARD", "RANK_REWARD", "GLOBAL_REWARD"],
    });
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((r) => r.occurredAt)).size, 1, "one instant");

    // Paged one at a time, the shared instant must not stall or repeat.
    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await getLedgerPage({
        userId: U, limit: 1, before,
        kinds: ["LEVEL_REWARD", "RANK_REWARD", "GLOBAL_REWARD"],
      });
      seen.push(...page.rows.map((r) => r.rowId));
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    assert.deepEqual([...new Set(seen)].sort(), seen.sort(), "no repeats");
    assert.equal(seen.length, 3);
  });

  it("10. an empty history is an empty page, not an error", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const page = await getLedgerPage({ userId: "usr_nobody", limit: 25 });
    assert.deepEqual(page.rows, []);
    assert.equal(page.nextCursor, null);
  });
});

describe("ledger totals", () => {
  it("11. totals are per unit and summed as integers", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach();
    const totals = await getLedgerTotals(U);

    assert.equal(totals.rowCount, 9);
    // ACF in: 100 swap + 200 bond + 5 self + 1 level + 2 rank + 3 global + 10 claim + 7 dao.
    // The bond's ACF arrives and is staked; the stake row is a MOVE, so it is counted once.
    assert.equal(totals.acfIn, (328n * E18).toString());
    assert.equal(totals.acfOut, "0", "nothing left in ACF: the stake only locked it");
    // USDT out: 250 paid for the swap + 500 for the bond.
    assert.equal(totals.usdtOut, "750000000");
    assert.equal(totals.feesUSDT, "1500000", "the claim fee");
    assert.equal(totals.feesACF, "0", "nothing is charged in ACF");
    for (const value of Object.values(totals)) {
      if (typeof value === "string") assert.match(value, /^\d+$/);
    }
  });

  it("12. totals ignore the page and the filter", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach();
    const totals = await getLedgerTotals(U);
    const filtered = await getLedgerPage({ userId: U, limit: 1, kinds: ["RANK_REWARD"] });
    assert.equal(filtered.rows.length, 1);
    // A summary computed from what is on screen would change as the reader pages.
    assert.equal(totals.rowCount, 9);
  });
});

/**
 * Self reward is calculated PER STAKE per cycle.
 *
 * A member with five stakes earns five entries every twelve hours, all at one instant and mostly
 * dust. Shown as five rows that is noise, and it reads like another member's history mixed in.
 * One row per cycle carries the exact total and lists its parts.
 */
describe("self rewards are grouped per cycle", () => {
  it("13. five stakes in one cycle become one row carrying the exact sum", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Deliberately dust-heavy, as the live data is.
    const amounts = [
      16_233_245_390_497_522_000n,
      125_312_695_312_500_000n,
      87_502_035_735_662_940n,
      2_506_253_906_250_000n,
      1_253_126_953_125_000n,
    ];
    for (const [i, amount] of amounts.entries()) {
      await addSelfReward(U, `stk-${i}`, EPOCH, amount, i);
    }

    const { rows } = await getLedgerPage({ userId: U, limit: 50, kinds: ["SELF_REWARD"] });
    assert.equal(rows.length, 1, "one row for the cycle, not five");

    const total = amounts.reduce((sum, a) => sum + a, 0n);
    assert.equal(rows[0]!.primary.amount, total.toString(), "the exact sum, not a rounded one");
    assert.equal(rows[0]!.epochId, EPOCH);
    assert.equal(rows[0]!.rowId, `self:${EPOCH}`);
  });

  it("14. the parts are listed, so nothing is hidden by grouping", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await addSelfReward(U, "stk-a", EPOCH, 3n * E18, 1);
    await addSelfReward(U, "stk-b", EPOCH, 1n * E18, 2);

    const { rows } = await getLedgerPage({ userId: U, limit: 50, kinds: ["SELF_REWARD"] });
    const row = rows[0]!;
    assert.equal(row.breakdown?.length, 2);
    assert.equal(row.detail.stakeCount, 2);

    // Largest first, so the row that matters is read first.
    assert.equal(row.breakdown![0]!.amount.amount, (3n * E18).toString());
    assert.equal(row.breakdown![1]!.amount.amount, (1n * E18).toString());
    assert.match(row.breakdown![0]!.label, /stk-a/);

    // The sum of the parts is the headline, exactly.
    const parts = row.breakdown!.reduce((s, b) => s + BigInt(b.amount.amount), 0n);
    assert.equal(row.primary.amount, parts.toString());
  });

  it("15. separate cycles stay separate rows", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await addSelfReward(U, "stk-a", 41_459, 1n * E18);
    await addSelfReward(U, "stk-b", 41_459, 2n * E18);
    await addSelfReward(U, "stk-a", 41_460, 4n * E18);

    const { rows } = await getLedgerPage({ userId: U, limit: 50, kinds: ["SELF_REWARD"] });
    assert.equal(rows.length, 2, "grouping is per cycle, never across cycles");
    const byEpoch = new Map(rows.map((r) => [r.epochId, r]));
    assert.equal(byEpoch.get(41_459)!.primary.amount, (3n * E18).toString());
    assert.equal(byEpoch.get(41_460)!.primary.amount, (4n * E18).toString());
  });

  it("16. a page of cycles is never a partial cycle", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Three cycles, five stakes each. Paged one cycle at a time, every total must be whole —
    // grouping a flat page afterwards would have split one and shown a partial sum.
    for (const epochId of [41_459, 41_460, 41_461]) {
      for (let i = 0; i < 5; i++) await addSelfReward(U, `stk-${i}`, epochId, 2n * E18, i);
    }

    const seen: number[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await getLedgerPage({ userId: U, limit: 1, before, kinds: ["SELF_REWARD"] });
      for (const row of page.rows) {
        assert.equal(row.primary.amount, (10n * E18).toString(), "whole cycle, all five stakes");
        assert.equal(row.breakdown?.length, 5);
        seen.push(row.epochId!);
      }
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    assert.deepEqual(seen.sort(), [41_459, 41_460, 41_461]);
  });

  it("17. other kinds are untouched by grouping", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedOneOfEach();
    const { rows } = await getLedgerPage({ userId: U, limit: 50 });
    for (const row of rows) {
      if (row.kind === "SELF_REWARD") continue;
      assert.equal(row.breakdown, null, `${row.kind} stands for one record`);
    }
  });
});
