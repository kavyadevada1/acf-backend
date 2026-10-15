import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";

const TEST_URI = process.env.MONGODB_TEST_URI;
function assertDisposable(uri: string): string {
  const name = new URL(uri).pathname.replace(/^\//, "");
  if (!name || !/test/i.test(name)) throw new Error(`MONGODB_TEST_URI must name a test database (got "${name}").`);
  return uri;
}

const STAKING = "0x9eDbbf53f784450CC8Fd50730984Cb7D8DDF743d";
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/unused-by-tests";
process.env.PORT ??= "3001";
process.env.DAO_REVENUE_DISTRIBUTOR_ADDRESS ??= "0xc152dF6448FB68702B661C4aE210E41f5E76931E";
process.env.JWT_SECRET ??= "test-secret-at-least-thirty-two-characters-long";
process.env.REGISTERED_EOA_DIRECT_RULE_START_EPOCH ??= "1";
process.env.JWT_EXPIRES_IN_SECONDS ??= "86400";
process.env.CHAIN_ID ??= "80002";
process.env.CHALLENGE_TTL_SECONDS ??= "300";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ACF_SWAP_ADDRESS ??= "0x16F2d748A5a4359d1948F261662dD9f0d5fEadDD";
process.env.ACF_STAKING_ADDRESS ??= STAKING;
process.env.WITHDRAWAL_ADDRESS ??= "0x882db912586869315C2720dE72224d79B9D99Ea1";
process.env.TREASURY_ADDRESS ??= "0x114fe8e3414bc49A24C6efd9E702cD66B9A80251";
process.env.ACF_TOKEN_ADDRESS ??= "0x7AEB95CaE1e5442Fe1170555ae81280B763D3BF1";
process.env.ACF_BOND_ADDRESS ??= "0x3a97D05a088aDBB79936914F245c2E0bf7F511f2";
process.env.ACF_DAO_ADDRESS ??= "0x9cf32271E052Cbbc1D6C564B6fE6a86B6ED08E45";
process.env.MOCK_USDT_ADDRESS ??= "0x21ff9e803fc496e4db1c1a6c354690636b9fc330";
process.env.SWAP_CONFIRMATIONS ??= "1";
process.env.REWARD_ENGINE_ACTIVATION_EPOCH ??= "41000";

const { runRewardEpoch, EpochNotEligibleError, ClaimLedgerError } = await import("./epoch.js");
const { catchUpRewardEpochs } = await import("./service.js");
const {
  backfillWithdrawalBlocks, discoverStakes, DiscoveryIncompleteError, reconcileActiveStakes,
  UnmappedStakeError,
} = await import("./reconcile.js");
const { EPOCH_SECONDS, snapshotAtOf } = await import("./policy.js");
const { RewardEpoch } = await import("../models/RewardEpoch.js");
const { StakeRewardEntry } = await import("../models/StakeRewardEntry.js");
const { StakeReconciliationState } = await import("../models/StakeReconciliationState.js");
const { Stake } = await import("../models/Stake.js");
const { User } = await import("../models/User.js");
const { CheckpointSelfComponent } = await import("../models/CheckpointSelfComponent.js");
const { UserClaimState } = await import("../models/UserClaimState.js");
import type { ChainStake, RewardChainReader } from "./chain.ts";

const E18 = 10n ** 18n;
const ACTIVATION = 41_000;
const LOW = STAKING.toLowerCase();
const USER_ADDRESS = "0x7c2d6b5f65c820c1cb014313ab17419420d3e3a7";
const KEY = { chainId: 80002, stakingContractAddress: LOW };

/** snapshotAt for an epoch, as seconds. */
const at = (epochId: number) => snapshotAtOf(epochId);

type StakeSpec = {
  id: bigint; source?: 0 | 1 | 2; poolId?: bigint; principal?: bigint;
  stakeTimestamp?: number; unlockTimestamp?: number; active?: boolean; user?: string;
  /** Unix seconds the principal was withdrawn, for as-of tests. */
  withdrawnAtSec?: number;
};

function chainStake(s: StakeSpec, epochId: number): ChainStake {
  if (s.withdrawnAtSec !== undefined) WITHDRAWN.set(s.id.toString(), s.withdrawnAtSec);
  // `active: false` with no time means "withdrawn before anything in this test".
  else if (s.active === false) WITHDRAWN.set(s.id.toString(), 0);
  return {
    stakeId: s.id,
    user: s.user ?? USER_ADDRESS,
    principal: s.principal ?? 1000n * E18,
    poolId: s.poolId ?? 1n,
    stakeTimestamp: BigInt(s.stakeTimestamp ?? at(epochId) - 10 * EPOCH_SECONDS),
    unlockTimestamp: BigInt(s.unlockTimestamp ?? at(epochId) - 10 * EPOCH_SECONDS),
    active: s.active ?? true,
    source: s.source ?? 0,
  };
}

/** Withdrawal time per stake id, in unix seconds. */
const WITHDRAWN: Map<string, number> = new Map();

type ReaderOpts = {
  price?: bigint;
  pools?: { poolId: number; lockDuration: number; rate: bigint }[];
  /** Pool rates that take effect from a given unix second onward — for ROI-change tests. */
  roiSchedule?: { from: number; pools: { poolId: number; lockDuration: number; rate: bigint }[] }[];
  /** Prices that take effect from a given unix second onward. */
  priceSchedule?: { from: number; price: bigint }[];
  /** Chain head timestamp. Defaults far in the future so boundaries are always final. */
  headAt?: number;
};

/**
 * A chain the tests fully control: no RPC, no 12-hour waits, no archive node.
 *
 * Block number IS the unix timestamp — Amoy runs ~1s blocks, so this models it exactly and
 * makes "was this read pinned to the right block?" directly assertable.
 */
function reader(stakes: ChainStake[], o: ReaderOpts = {}): RewardChainReader {
  const byId = new Map(stakes.map((s) => [s.stakeId.toString(), s]));
  const head = o.headAt ?? 2_000_000_000;

  const activeAtTs = (s: ChainStake, ts: number): boolean => {
    const w = WITHDRAWN.get(s.stakeId.toString());
    if (w !== undefined) return ts < w;      // withdrawn AT w => inactive from w onward
    return s.active;
  };
  const poolsAt = (ts: number) => {
    const scheduled = (o.roiSchedule ?? [])
      .filter((r) => r.from <= ts).sort((a, b) => a.from - b.from).at(-1);
    return (scheduled?.pools ?? o.pools ?? [
      { poolId: 1, lockDuration: 0, rate: 2_500n },          // Flexible
      { poolId: 2, lockDuration: 45 * 86400, rate: 2_500n }, // Fixed
      { poolId: 6, lockDuration: 750 * 86400, rate: 5_000n },// DAO pool: 0.5%, must be ignored
    ]).map((p) => ({ poolId: p.poolId, lockDuration: p.lockDuration, currentDailyRewardRate: p.rate, active: true }));
  };
  const priceAt = (ts: number) => {
    const scheduled = (o.priceSchedule ?? [])
      .filter((r) => r.from <= ts).sort((a, b) => a.from - b.from).at(-1);
    return scheduled?.price ?? o.price ?? 1_547_749_657_915_444_035n;
  };

  return {
    async nextStakeId() { return BigInt(stakes.length + 1); },

    async getStakes(ids, pin) {
      const ts = pin?.blockNumber !== undefined ? Number(pin.blockNumber) : head;
      return ids.map((i) => {
        const s = byId.get(i.toString());
        if (!s) return null;
        // Not yet created at that block.
        if (Number(s.stakeTimestamp) > ts) return null;
        return { ...s, active: activeAtTs(s, ts) };
      });
    },

    async getPools(pin) {
      return poolsAt(pin?.blockNumber !== undefined ? Number(pin.blockNumber) : head);
    },

    async priceSnapshot(pin) {
      const ts = pin?.blockNumber !== undefined ? Number(pin.blockNumber) : head;
      const price = priceAt(ts);
      if (price === 0n) throw new Error("Swap.priceE18() returned zero; refusing to settle an epoch.");
      return { priceE18: price, blockNumber: ts, blockTimestamp: ts };
    },

    async blockAtOrBefore(timestampSeconds) {
      if (head <= timestampSeconds) {
        throw new Error(`Chain head has not passed ${timestampSeconds}.`);
      }
      return { blockNumber: BigInt(timestampSeconds), blockTimestamp: timestampSeconds };
    },

    async findWithdrawalBlock(stakeId, afterBlock, atOrBeforeBlock) {
      const w = WITHDRAWN.get(stakeId.toString());
      const at = w ?? Number(afterBlock) + 1;
      if (BigInt(at) <= afterBlock || BigInt(at) > atOrBeforeBlock) {
        throw new Error(`Stake ${stakeId} withdrawal not bracketed.`);
      }
      return { blockNumber: BigInt(at), blockTimestamp: at };
    },
  };
}

const makeUser = (userAddress = USER_ADDRESS, userId = "usr_1") =>
  User.create({
    userId, externalEOA: userAddress,
    referralCode: `ACF-${userId.slice(-1).repeat(8)}`.toUpperCase(),
    referredByUserId: null,
  });

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set — reward tests skipped"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([
    User.init(), Stake.init(), RewardEpoch.init(), StakeRewardEntry.init(),
    StakeReconciliationState.init(), CheckpointSelfComponent.init(), UserClaimState.init(),
  ]);
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  WITHDRAWN.clear();
  if (connected) await Promise.all([
    User.deleteMany({}), Stake.deleteMany({}), RewardEpoch.deleteMany({}),
    StakeRewardEntry.deleteMany({}), StakeReconciliationState.deleteMany({}),
    CheckpointSelfComponent.deleteMany({}), UserClaimState.deleteMany({}),
  ]);
});

const entry = (stakeId: string, epochId: number) =>
  StakeRewardEntry.findOne({ ...KEY, stakeId, epochId });

describe("activation boundary", () => {
  it("1. an epoch before activation is refused outright", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await assert.rejects(
      runRewardEpoch(ACTIVATION - 1, { reader: reader([]), now: () => at(ACTIVATION + 5) }),
      (e: unknown) => e instanceof EpochNotEligibleError && /precedes REWARD_ENGINE_ACTIVATION/.test((e as Error).message),
    );
    assert.equal(await RewardEpoch.countDocuments({}), 0);
  });

  it("2. an epoch whose window has not completed is refused", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await assert.rejects(
      runRewardEpoch(ACTIVATION + 5, { reader: reader([]), now: () => at(ACTIVATION + 5) - 1 }),
      (e: unknown) => /in the future/.test((e as Error).message),
    );
  });
});

describe("canonical discovery — no browser sync required", () => {
  it("3. a DIRECT stake never synced by a browser is discovered and rewarded", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const epochId = ACTIVATION + 1;
    assert.equal(await Stake.countDocuments({}), 0);   // nothing synced

    const r = await runRewardEpoch(epochId, {
      reader: reader([chainStake({ id: 1n, source: 0 }, epochId)]),
      now: () => at(epochId),
    });

    assert.equal(r.status, "CALCULATED");
    assert.equal(await Stake.countDocuments({}), 1);
    assert.equal((await entry("1", epochId))!.rewardACF, (1250n * E18 / 1000n).toString());
  });

  it("4. BOND and DAO stakes are discovered the same way", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const epochId = ACTIVATION + 1;
    await runRewardEpoch(epochId, {
      reader: reader([
        chainStake({ id: 1n, source: 1, poolId: 2n }, epochId),
        chainStake({ id: 2n, source: 2, poolId: 6n }, epochId),
      ]),
      now: () => at(epochId),
    });
    assert.equal((await Stake.findOne({ stakeId: "1" }))!.source, "BOND");
    assert.equal((await Stake.findOne({ stakeId: "2" }))!.source, "DAO");
  });

  it("5. an unmapped beneficiary FAILS the epoch rather than losing liability", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // No User owns this wallet. Silently skipping would under-pay a real position.
    const epochId = ACTIVATION + 1;
    await assert.rejects(
      runRewardEpoch(epochId, {
        reader: reader([chainStake({ id: 1n, user: "0x" + "b".repeat(40) }, epochId)]),
        now: () => at(epochId),
      }),
      (e: unknown) => e instanceof UnmappedStakeError,
    );
    assert.equal((await RewardEpoch.findOne({ ...KEY, epochId }))!.status, "FAILED");
    assert.equal(await StakeRewardEntry.countDocuments({}), 0);
  });

  it("6. discovery resumes from the high-water mark instead of re-scanning", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const epochId = ACTIVATION + 1;
    const r = reader([chainStake({ id: 1n }, epochId)]);
    await discoverStakes(r);
    assert.equal((await StakeReconciliationState.findOne({}))!.nextStakeIdProcessed, "2");

    let reads = 0;
    const counting: RewardChainReader = { ...r, async getStakes(ids) { reads += ids.length; return r.getStakes(ids); } };
    const second = await discoverStakes(counting);
    assert.equal(second.discovered, 0);
    assert.equal(reads, 0, "a settled range must not be re-read");
  });
});

describe("unmapped stakes are not lost", () => {
  it("6b. a failed epoch does not advance the cursor past an unmapped stake", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const e = ACTIVATION + 1;
    const orphan = "0x" + "d".repeat(40);
    const r = reader([chainStake({ id: 1n, user: orphan }, e)]);

    // First attempt: nobody owns the wallet, so the epoch fails.
    await assert.rejects(runRewardEpoch(e, { reader: r, now: () => at(e) }), UnmappedStakeError);
    // The cursor must still point AT the unmapped stake, not past it.
    assert.equal((await StakeReconciliationState.findOne({}))!.nextStakeIdProcessed, "1");

    // The operator creates the missing user and retries.
    await makeUser(orphan, "usr_2");
    const after = await runRewardEpoch(e, { reader: r, now: () => at(e) });

    assert.equal(after.status, "CALCULATED");
    assert.equal(await Stake.countDocuments({}), 1, "the stake must now be discovered");
    assert.notEqual((await entry("1", e))!.rewardACF, "0");
  });
});

describe("withdrawal reconciliation", () => {
  it("7. a stake withdrawn on chain is retired in the DB and earns nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const first = ACTIVATION + 1;
    await runRewardEpoch(first, { reader: reader([chainStake({ id: 1n }, first)]), now: () => at(first) });
    assert.equal((await Stake.findOne({ stakeId: "1" }))!.active, true);

    // The user withdraws; the chain now says inactive.
    const second = first + 1;
    await runRewardEpoch(second, {
      reader: reader([chainStake({ id: 1n, active: false }, second)]),
      now: () => at(second),
    });

    assert.equal((await Stake.findOne({ stakeId: "1" }))!.active, false);
    const e = (await entry("1", second))!;
    assert.equal(e.rewardACF, "0");
    assert.equal(e.ineligibleReason, "WITHDRAWN");
    // Already-earned history is untouched.
    assert.notEqual((await entry("1", first))!.rewardACF, "0");
  });
});

describe("compounding", () => {
  it("8. the first reward uses principal alone; the next adds it", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e1 = ACTIVATION + 1;
    const e2 = e1 + 1;
    const stake = (ep: number) => chainStake({ id: 1n, principal: 1000n * E18 }, ep);

    await runRewardEpoch(e1, { reader: reader([stake(e1)]), now: () => at(e1) });
    const first = (await entry("1", e1))!;
    assert.equal(first.compoundBaseACF, (1000n * E18).toString());   // principal only
    const reward1 = BigInt(first.rewardACF);

    await runRewardEpoch(e2, { reader: reader([stake(e2)]), now: () => at(e2) });
    const second = (await entry("1", e2))!;
    // Base is now principal + the PRIOR epoch's reward.
    assert.equal(second.compoundBaseACF, (1000n * E18 + reward1).toString());
    assert.ok(BigInt(second.rewardACF) > reward1, "compounded reward must exceed the first");
    assert.equal(second.cumulativeEarnedACF, (reward1 + BigInt(second.rewardACF)).toString());
  });

  it("9. an epoch's own reward never enters its own base", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await runRewardEpoch(e, { reader: reader([chainStake({ id: 1n }, e)]), now: () => at(e) });
    const row = (await entry("1", e))!;
    assert.equal(row.compoundBaseACF, row.principalACF);
  });

  it("10. a FAILED epoch's rows never feed a later compound base", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e1 = ACTIVATION + 1;
    const e2 = e1 + 1;
    await runRewardEpoch(e1, { reader: reader([chainStake({ id: 1n }, e1)]), now: () => at(e1) });

    // Force e1 to look incomplete, as a crash mid-epoch would leave it.
    await RewardEpoch.updateOne({ ...KEY, epochId: e1 }, { $set: { status: "FAILED" } });

    await runRewardEpoch(e2, { reader: reader([chainStake({ id: 1n }, e2)]), now: () => at(e2) });
    const row = (await entry("1", e2))!;
    // Base is principal only: the unsettled epoch contributed nothing.
    assert.equal(row.compoundBaseACF, row.principalACF);
  });
});

describe("DAO reward", () => {
  it("11. uses the fixed 1% policy, not pool 6's 0.5% current ROI", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await runRewardEpoch(e, {
      reader: reader([chainStake({ id: 1n, source: 2, poolId: 6n, principal: 1000n * E18 }, e)]),
      now: () => at(e),
    });
    const row = (await entry("1", e))!;
    assert.equal(row.rateApplied, "10000");              // the policy, not 5000
    assert.equal(row.rewardACF, (5n * E18).toString());  // 0.5% of 1000, not 0.25%
  });

  it("12. keeps earning past 750-day maturity while active", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await runRewardEpoch(e, {
      reader: reader([chainStake({ id: 1n, source: 2, poolId: 6n, unlockTimestamp: at(e) - 1 }, e)]),
      now: () => at(e),
    });
    assert.equal((await entry("1", e))!.rewardEligible, true);
  });
});

describe("maturity never stops a reward", () => {
  // The corrected product rule: unlock decides when PRINCIPAL may be withdrawn. An active
  // matured stake is still staked, so it still earns.
  const MATRIX = [
    { label: "DIRECT fixed", source: 0 as const, poolId: 2n },
    { label: "BOND fixed", source: 1 as const, poolId: 2n },
    { label: "DAO", source: 2 as const, poolId: 6n },
  ];

  for (const { label, source, poolId } of MATRIX) {
    it(`12-${label}: earns before, exactly at, and after maturity while active`, async (t) => {
      if (!connected) return t.skip("no MONGODB_TEST_URI");
      const e = ACTIVATION + 1;
      const cases = [
        { when: "before maturity", unlock: at(e) + 100 * EPOCH_SECONDS },
        { when: "exactly at maturity", unlock: at(e) },
        { when: "long after maturity", unlock: at(e) - 500 * EPOCH_SECONDS },
      ];

      for (const c of cases) {
        await Promise.all([
          User.deleteMany({}), Stake.deleteMany({}), RewardEpoch.deleteMany({}),
          StakeRewardEntry.deleteMany({}), StakeReconciliationState.deleteMany({}),
          CheckpointSelfComponent.deleteMany({}), UserClaimState.deleteMany({}),
    CheckpointSelfComponent.deleteMany({}), UserClaimState.deleteMany({}),
        ]);
        await makeUser();
        await runRewardEpoch(e, {
          reader: reader([chainStake({ id: 1n, source, poolId, unlockTimestamp: c.unlock }, e)]),
          now: () => at(e),
        });
        const row = (await entry("1", e))!;
        assert.equal(row.rewardEligible, true, `${label} ${c.when} must earn`);
        assert.notEqual(row.rewardACF, "0", `${label} ${c.when} must be paid`);
        assert.equal(row.ineligibleReason, null, `${label} ${c.when} must have no denial reason`);
      }
    });

    it(`12-${label}: a matured stake that is WITHDRAWN earns nothing`, async (t) => {
      if (!connected) return t.skip("no MONGODB_TEST_URI");
      await makeUser();
      const e = ACTIVATION + 1;
      await runRewardEpoch(e, {
        reader: reader([chainStake(
          { id: 1n, source, poolId, unlockTimestamp: at(e) - 1, active: false }, e,
        )]),
        now: () => at(e),
      });
      const row = (await entry("1", e))!;
      assert.equal(row.rewardACF, "0");
      assert.equal(row.ineligibleReason, "WITHDRAWN");
    });
  }

  it("12-ROI: a matured DIRECT stake uses the CURRENT epoch pool ROI, not zero or a frozen rate", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    // Pool 2's ROI is raised to 0.4% daily AFTER the stake matured.
    await runRewardEpoch(e, {
      reader: reader(
        [chainStake({ id: 1n, source: 0, poolId: 2n, unlockTimestamp: at(e) - 1, principal: 1000n * E18 }, e)],
        { pools: [{ poolId: 2, lockDuration: 45 * 86400, rate: 4_000n }] },
      ),
      now: () => at(e),
    });
    const row = (await entry("1", e))!;
    assert.equal(row.rateApplied, "4000", "must use the epoch snapshot, not a creation-time rate");
    assert.equal(row.rewardACF, (2n * E18).toString());   // 1000 x 0.4% / 2 = 2 ACF
  });

  it("12-compound: a matured active stake keeps compounding prior unclaimed reward", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e1 = ACTIVATION + 1;
    const e2 = e1 + 1;
    // Already matured before either epoch, and never withdrawn.
    const stake = (ep: number) => chainStake(
      { id: 1n, source: 0, poolId: 2n, unlockTimestamp: at(e1) - 1, principal: 1000n * E18 }, ep,
    );

    await runRewardEpoch(e1, { reader: reader([stake(e1)]), now: () => at(e1) });
    const first = BigInt((await entry("1", e1))!.rewardACF);
    assert.notEqual(first, 0n, "a matured active stake must earn");

    await runRewardEpoch(e2, { reader: reader([stake(e2)]), now: () => at(e2) });
    const second = (await entry("1", e2))!;
    assert.equal(second.compoundBaseACF, (1000n * E18 + first).toString(),
      "maturity must not freeze or reset the compound base");
    assert.ok(BigInt(second.rewardACF) > first, "compounding must continue past maturity");
  });

  it("12-reconcile: maturity alone never marks a DB stake inactive", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    // Chain says active even though unlock passed long ago. Mature != withdrawn.
    await runRewardEpoch(e, {
      reader: reader([chainStake(
        { id: 1n, source: 0, poolId: 2n, unlockTimestamp: at(e) - 1000 * EPOCH_SECONDS, active: true }, e,
      )]),
      now: () => at(e),
    });
    assert.equal((await Stake.findOne({ stakeId: "1" }))!.active, true,
      "a matured but unwithdrawn stake must stay active");
    assert.equal((await entry("1", e))!.rewardEligible, true);
  });

  it("12-history: withdrawal stops future reward but keeps earned history", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e1 = ACTIVATION + 1;
    const e2 = e1 + 1;
    const matured = { id: 1n, source: 0 as const, poolId: 2n, unlockTimestamp: at(e1) - 1 };

    await runRewardEpoch(e1, { reader: reader([chainStake(matured, e1)]), now: () => at(e1) });
    const earned = (await entry("1", e1))!.rewardACF;
    assert.notEqual(earned, "0");

    await runRewardEpoch(e2, {
      reader: reader([chainStake({ ...matured, active: false }, e2)]), now: () => at(e2),
    });

    assert.equal((await entry("1", e2))!.rewardACF, "0", "no future reward after withdrawal");
    assert.equal((await entry("1", e1))!.rewardACF, earned, "earned history must be intact");
  });
});

describe("idempotency and locking", () => {
  it("13. re-running a settled epoch creates no second entry", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const r = reader([chainStake({ id: 1n }, e)]);
    const a = await runRewardEpoch(e, { reader: r, now: () => at(e) });
    const b = await runRewardEpoch(e, { reader: r, now: () => at(e) });

    assert.equal(a.status, "CALCULATED");
    assert.equal(b.status, "SKIPPED");
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e }), 1);
  });

  it("14. two concurrent workers settle an epoch exactly once", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const r = reader([chainStake({ id: 1n }, e)]);
    const [x, y] = await Promise.all([
      runRewardEpoch(e, { reader: r, now: () => at(e) }),
      runRewardEpoch(e, { reader: r, now: () => at(e) }),
    ]);
    const calculated = [x, y].filter((v) => v.status === "CALCULATED");
    assert.equal(calculated.length, 1, "exactly one worker may own an epoch");
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e }), 1);
  });

  it("15. a crashed PROCESSING epoch is reclaimable once its lease expires", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await RewardEpoch.create({
      ...KEY, epochId: e, windowStart: at(e) - EPOCH_SECONDS, snapshotAt: at(e),
      status: "PROCESSING", leaseExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const r = await runRewardEpoch(e, { reader: reader([chainStake({ id: 1n }, e)]), now: () => at(e) });
    assert.equal(r.status, "CALCULATED");
  });
});

describe("catch-up", () => {
  it("16. missed epochs are settled oldest first, compounding in order", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const start = ACTIVATION + 1;
    const now = at(start + 2);
    const stakes = [chainStake({ id: 1n }, start)];

    const { processed, stoppedAt } = await catchUpRewardEpochs({
      reader: reader(stakes), now: () => now,
    });

    assert.equal(stoppedAt, null);
    const settled = processed.filter((p) => p.status === "CALCULATED").map((p) => p.epochId);
    assert.deepEqual(settled, [...settled].sort((a, b) => a - b), "must be chronological");
    assert.ok(settled.length >= 3);

    // Compounding is visible across the sequence.
    const first = BigInt((await entry("1", settled[0]!))!.rewardACF);
    const last = BigInt((await entry("1", settled.at(-1)!))!.rewardACF);
    assert.ok(last > first, "later epochs compound on earlier ones");
  });

  it("17. a failure halts catch-up instead of skipping ahead", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const start = ACTIVATION + 1;
    // No User for this wallet in the SECOND epoch's discovery -> failure.
    const failing: RewardChainReader = {
      ...reader([chainStake({ id: 1n, user: "0x" + "c".repeat(40) }, start)]),
    };
    const { processed, stoppedAt } = await catchUpRewardEpochs({
      reader: failing, now: () => at(start + 2),
    });
    assert.equal(stoppedAt, ACTIVATION, "must stop at the FIRST candidate, not skip ahead");
    assert.equal(processed.length, 0);
    // Nothing later was attempted: epoch N+1 must never compound from an unsettled N.
    assert.equal(await RewardEpoch.countDocuments({ status: "CALCULATED" }), 0);
  });
});

describe("source separation", () => {
  it("18. DAO and regular rewards are separable per user per epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await runRewardEpoch(e, {
      reader: reader([
        chainStake({ id: 1n, source: 0, poolId: 1n, principal: 1000n * E18 }, e),
        chainStake({ id: 2n, source: 2, poolId: 6n, principal: 1000n * E18 }, e),
      ]),
      now: () => at(e),
    });

    // Every entry carries userId + source, so Phase 2 can total Level/Rank inputs from
    // DIRECT/BOND alone and never accidentally include DAO.
    const rows = await StakeRewardEntry.find({ ...KEY, epochId: e });
    const sum = (src: string) => rows
      .filter((r) => r.source === src)
      .reduce((a, r) => a + BigInt(r.rewardACF), 0n);

    assert.deepEqual([...new Set(rows.map((r) => r.userId))], ["usr_1"]);
    assert.equal(sum("DIRECT"), 1250n * E18 / 1000n);   // 0.25% daily, halved
    assert.equal(sum("DAO"), 5n * E18);                 // 1% daily, halved
    assert.equal(sum("BOND"), 0n);
  });

  it("19. the epoch record keeps the two totals apart", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const r = await runRewardEpoch(e, {
      reader: reader([
        chainStake({ id: 1n, source: 0, poolId: 1n, principal: 1000n * E18 }, e),
        chainStake({ id: 2n, source: 2, poolId: 6n, principal: 1000n * E18 }, e),
      ]),
      now: () => at(e),
    });
    assert.equal(r.totalRegularSelfACF, (1250n * E18 / 1000n).toString());
    assert.equal(r.totalDAOStakeACF, (5n * E18).toString());
  });
});

describe("discovery completeness", () => {
  // ACFStaking allocates ids with nextStakeId++ from 1 and never deletes a position, so every
  // id below the captured target is guaranteed readable. A walk cut short by a transient read
  // failure must therefore fail the epoch, not settle a partial one.

  /** Makes the UNPINNED (discovery) read fail for one id; the pinned reward read still works. */
  const unreadableAt = (base: RewardChainReader, badId: bigint): RewardChainReader => ({
    ...base,
    async getStakes(ids, pin) {
      const rows = await base.getStakes(ids, pin);
      if (pin?.blockNumber !== undefined) return rows;
      return rows.map((r, i) => (ids[i] === badId ? null : r));
    },
  });

  const manyStakes = (count: number, e: number) =>
    Array.from({ length: count }, (_, i) =>
      chainStake({ id: BigInt(i + 1), principal: 1000n * E18 }, e));

  it("44. a complete walk reports completed and the epoch calculates", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const r = reader(manyStakes(5, e));

    const discovery = await discoverStakes(r);
    assert.equal(discovery.completed, true);
    assert.equal(discovery.unmapped.length, 0);
    assert.equal(discovery.stoppedAtStakeId, null);
    assert.equal(discovery.reason, null);
    assert.equal(discovery.targetNextStakeId, "6");

    const result = await runRewardEpoch(e, { reader: r, now: () => at(e) + 3600 });
    assert.equal(result.status, "CALCULATED");
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e }), 5);
  });

  it("45. a read failure MID-walk fails the epoch and never reaches CALCULATED", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const broken = unreadableAt(reader(manyStakes(10, e)), 5n);

    await assert.rejects(
      runRewardEpoch(e, { reader: broken, now: () => at(e) + 3600 }),
      (err: unknown) => err instanceof DiscoveryIncompleteError
        && /stopped at 5 of target 11/.test((err as Error).message),
    );

    const epoch = (await RewardEpoch.findOne({ ...KEY, epochId: e }))!;
    assert.equal(epoch.status, "FAILED", "must never be CALCULATED on a partial walk");
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e }), 0);
    // The cursor stops AT the failure, so a retry attempts id 5 again.
    assert.equal((await StakeReconciliationState.findOne({ ...KEY }))!.nextStakeIdProcessed, "5");
    // Stakes past the failure were never persisted.
    assert.equal(await Stake.countDocuments({ ...KEY }), 4);
  });

  it("46. the retry recovers: every applicable stake ends with exactly one entry", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const healthy = reader(manyStakes(10, e));

    await assert.rejects(runRewardEpoch(e, {
      reader: unreadableAt(healthy, 5n), now: () => at(e) + 3600,
    }), DiscoveryIncompleteError);

    // The read recovers.
    const result = await runRewardEpoch(e, { reader: healthy, now: () => at(e) + 7200 });

    assert.equal(result.status, "CALCULATED");
    assert.equal(await Stake.countDocuments({ ...KEY }), 10, "the failed id and the rest arrive");
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e }), 10);
    const ids = (await StakeRewardEntry.find({ ...KEY, epochId: e }, { stakeId: 1 }))
      .map((x) => Number(x.stakeId)).sort((a, b) => a - b);
    assert.deepEqual(ids, Array.from({ length: 10 }, (_, i) => i + 1), "exactly one each");
  });

  it("47. a failure at the FIRST undiscovered stake advances nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await assert.rejects(runRewardEpoch(e, {
      reader: unreadableAt(reader(manyStakes(5, e)), 1n), now: () => at(e) + 3600,
    }), DiscoveryIncompleteError);

    assert.equal((await StakeReconciliationState.findOne({ ...KEY }))!.nextStakeIdProcessed, "1");
    assert.equal(await Stake.countDocuments({ ...KEY }), 0);
    assert.equal((await RewardEpoch.findOne({ ...KEY, epochId: e }))!.status, "FAILED");
  });

  it("48. a failure at the LAST id in range still fails the epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await assert.rejects(runRewardEpoch(e, {
      reader: unreadableAt(reader(manyStakes(10, e)), 10n), now: () => at(e) + 3600,
    }), DiscoveryIncompleteError);

    assert.equal((await StakeReconciliationState.findOne({ ...KEY }))!.nextStakeIdProcessed, "10");
    assert.equal(await Stake.countDocuments({ ...KEY }), 9, "9 persisted, the 10th withheld");
    assert.equal((await RewardEpoch.findOne({ ...KEY, epochId: e }))!.status, "FAILED");
  });

  it("49. an unmapped beneficiary still raises UnmappedStakeError, not the new error", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const e = ACTIVATION + 1;
    // No User owns this wallet. The certified behaviour must be unchanged.
    await assert.rejects(
      runRewardEpoch(e, {
        reader: reader([chainStake({ id: 1n, user: "0x" + "e".repeat(40) }, e)]),
        now: () => at(e) + 3600,
      }),
      (err: unknown) => err instanceof UnmappedStakeError,
    );
    const discovery = await discoverStakes(
      reader([chainStake({ id: 1n, user: "0x" + "e".repeat(40) }, e)]));
    assert.equal(discovery.completed, false, "an unmapped stop is also incomplete");
    assert.equal(discovery.reason, "UNMAPPED_BENEFICIARY");
    assert.deepEqual(discovery.unmapped, ["1"]);
  });

  it("50. the discovery target is captured ONCE, so concurrent creations are deferred", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const base = reader(manyStakes(3, e));
    let calls = 0;
    // Simulates the chain growing during the walk.
    const growing: RewardChainReader = {
      ...base,
      async nextStakeId() { calls += 1; return BigInt(3 + calls); },
    };

    const discovery = await discoverStakes(growing);

    assert.equal(calls, 1, "the target must be read once, not re-read mid-walk");
    assert.equal(discovery.targetNextStakeId, "4");
    assert.equal(discovery.completed, true, "complete against the CAPTURED target");
    // A stake created during the run is outside the target and waits for the next pass. That is
    // safe: discovery only runs once the chain has passed snapshotAt, so such a stake has
    // stakeTimestamp > snapshotAt and cannot be reward-eligible for this epoch (see test 32).
    assert.equal(await Stake.countDocuments({ ...KEY }), 3);
  });
});

describe("as-of-snapshot determinism", () => {
  // The historical catch-up defect: a withdrawal AFTER the boundary must not void an epoch the
  // position was active throughout. Every read is pinned to the epoch's snapshot block.

  const HOUR = 3600;

  it("25. the snapshot block is the highest block at or before snapshotAt", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await runRewardEpoch(e, { reader: reader([chainStake({ id: 1n }, e)]), now: () => at(e) + HOUR });

    const epoch = (await RewardEpoch.findOne({ ...KEY, epochId: e }))!;
    // The harness models 1s blocks, so the boundary block number IS snapshotAt.
    assert.equal(epoch.snapshotBlockTimestamp, at(e));
    assert.equal(epoch.snapshotBlockNumber, at(e));
    assert.ok(epoch.snapshotBlockTimestamp! <= at(e), "must not be after the boundary");
  });

  it("26. the snapshot block is deterministic regardless of when the worker runs", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const e = ACTIVATION + 1;
    const resolved: number[] = [];
    for (const lateness of [HOUR, 6 * HOUR, 72 * HOUR]) {
      await Promise.all([
        User.deleteMany({}), Stake.deleteMany({}), RewardEpoch.deleteMany({}),
        StakeRewardEntry.deleteMany({}), StakeReconciliationState.deleteMany({}),
    CheckpointSelfComponent.deleteMany({}), UserClaimState.deleteMany({}),
      ]);
      await makeUser();
      await runRewardEpoch(e, {
        reader: reader([chainStake({ id: 1n }, e)]), now: () => at(e) + lateness,
      });
      resolved.push((await RewardEpoch.findOne({ ...KEY, epochId: e }))!.snapshotBlockNumber!);
    }
    assert.deepEqual(resolved, [at(e), at(e), at(e)], "wall clock must not change the anchor");
  });

  it("27. a retry REUSES the persisted snapshot block, never re-resolves it", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    // First attempt fails on a zero price, after the block has been resolved and stored.
    await assert.rejects(runRewardEpoch(e, {
      reader: reader([chainStake({ id: 1n }, e)], { price: 0n }), now: () => at(e) + HOUR,
    }));
    const first = (await RewardEpoch.findOne({ ...KEY, epochId: e }))!.snapshotBlockNumber;
    assert.equal(first, at(e));

    // Retry much later: a fresh resolution would still give at(e) here, so prove reuse by
    // counting calls instead.
    const base = reader([chainStake({ id: 1n }, e)]);
    let resolutions = 0;
    const counting: RewardChainReader = {
      ...base,
      async blockAtOrBefore(ts) { resolutions += 1; return base.blockAtOrBefore(ts); },
    };
    const r = await runRewardEpoch(e, { reader: counting, now: () => at(e) + 100 * HOUR });

    assert.equal(r.status, "CALCULATED");
    assert.equal((await RewardEpoch.findOne({ ...KEY, epochId: e }))!.snapshotBlockNumber, first);
    assert.equal(resolutions, 0, "the epoch anchor must not be re-resolved on retry");
  });

  it("28. THE FIXTURE — active at snapshot, withdrawn after, worker catches up late", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const next = e + 1;
    // 1000 ACF created well before epoch N; withdrawn at 13:00; worker runs at 18:00.
    const spec = {
      id: 1n, principal: 1000n * E18,
      stakeTimestamp: at(e) - 50 * EPOCH_SECONDS,
      withdrawnAtSec: at(e) + HOUR,
    };
    const r = reader([chainStake(spec, e)]);

    const epochN = await runRewardEpoch(e, { reader: r, now: () => at(e) + 6 * HOUR });
    assert.equal(epochN.status, "CALCULATED");
    const rowN = (await entry("1", e))!;
    assert.equal(rowN.rewardEligible, true, "active at the boundary => must earn");
    assert.equal(rowN.ineligibleReason, null);
    assert.equal(rowN.rewardACF, (1250n * E18 / 1000n).toString());   // 1000 @ 0.25%/2

    // The next epoch's boundary is after the withdrawal.
    await runRewardEpoch(next, { reader: r, now: () => at(next) + 6 * HOUR });
    const rowNext = (await entry("1", next))!;
    assert.equal(rowNext.rewardEligible, false);
    assert.equal(rowNext.ineligibleReason, "WITHDRAWN");
    assert.equal(rowNext.rewardACF, "0");
  });

  it("29. the result does not change with the wall clock at execution", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const e = ACTIVATION + 1;
    const rewards: string[] = [];
    for (const lateness of [HOUR / 2, 6 * HOUR, 240 * HOUR]) {
      await Promise.all([
        User.deleteMany({}), Stake.deleteMany({}), RewardEpoch.deleteMany({}),
        StakeRewardEntry.deleteMany({}), StakeReconciliationState.deleteMany({}),
    CheckpointSelfComponent.deleteMany({}), UserClaimState.deleteMany({}),
      ]);
      await makeUser();
      await runRewardEpoch(e, {
        reader: reader([chainStake({
          id: 1n, principal: 1000n * E18,
          stakeTimestamp: at(e) - 50 * EPOCH_SECONDS, withdrawnAtSec: at(e) + HOUR,
        }, e)]),
        now: () => at(e) + lateness,
      });
      rewards.push((await entry("1", e))!.rewardACF);
    }
    assert.equal(new Set(rewards).size, 1, `identical every time, got ${rewards.join(", ")}`);
    assert.notEqual(rewards[0], "0");
  });

  it("30. withdrawal BEFORE the snapshot does not earn", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await runRewardEpoch(e, {
      reader: reader([chainStake({
        id: 1n, stakeTimestamp: at(e) - 50 * EPOCH_SECONDS, withdrawnAtSec: at(e) - 1,
      }, e)]),
      now: () => at(e) + HOUR,
    });
    assert.equal((await entry("1", e))!.ineligibleReason, "WITHDRAWN");
  });

  it("31. withdrawal EXACTLY AT the snapshot does not earn", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    // At the boundary the principal is already gone, so the position is inactive for it.
    await runRewardEpoch(e, {
      reader: reader([chainStake({
        id: 1n, stakeTimestamp: at(e) - 50 * EPOCH_SECONDS, withdrawnAtSec: at(e),
      }, e)]),
      now: () => at(e) + HOUR,
    });
    const row = (await entry("1", e))!;
    assert.equal(row.rewardEligible, false);
    assert.equal(row.ineligibleReason, "WITHDRAWN");
    assert.equal(row.rewardACF, "0");
  });

  it("32. a stake created AFTER the snapshot does not earn", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await runRewardEpoch(e, {
      reader: reader([chainStake({ id: 1n, stakeTimestamp: at(e) + HOUR }, e)]),
      now: () => at(e) + 6 * HOUR,
    });
    const row = (await entry("1", e))!;
    assert.equal(row.rewardEligible, false);
    assert.equal(row.ineligibleReason, "TOO_YOUNG");
  });

  it("33. a stake created EXACTLY AT the snapshot does not earn (age 0)", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await runRewardEpoch(e, {
      reader: reader([chainStake({ id: 1n, stakeTimestamp: at(e) }, e)]),
      now: () => at(e) + 6 * HOUR,
    });
    assert.equal((await entry("1", e))!.ineligibleReason, "TOO_YOUNG");
  });

  it("34. HISTORICAL pool ROI is used, not the rate at catch-up time", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    // 0.25% at the boundary; an admin raises it to 0.40% an hour later.
    await runRewardEpoch(e, {
      reader: reader([chainStake({ id: 1n, poolId: 2n, principal: 1000n * E18 }, e)], {
        roiSchedule: [
          { from: 0, pools: [{ poolId: 2, lockDuration: 45 * 86400, rate: 2_500n }] },
          { from: at(e) + HOUR, pools: [{ poolId: 2, lockDuration: 45 * 86400, rate: 4_000n }] },
        ],
      }),
      now: () => at(e) + 6 * HOUR,
    });
    const row = (await entry("1", e))!;
    assert.equal(row.rateApplied, "2500", "must be the boundary rate, not 4000");
    assert.equal(row.rewardACF, (1250n * E18 / 1000n).toString());

    const snap = (await RewardEpoch.findOne({ ...KEY, epochId: e }))!.poolROISnapshot
      .find((x) => x.poolId === 2)!;
    assert.equal(snap.currentDailyRewardRate, "2500");
  });

  it("35. HISTORICAL price is used, not the price at catch-up time", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const P1 = 1_000_000_000_000_000_000n;
    const P2 = 9_999_000_000_000_000_000n;
    await runRewardEpoch(e, {
      reader: reader([chainStake({ id: 1n }, e)], {
        priceSchedule: [{ from: 0, price: P1 }, { from: at(e) + HOUR, price: P2 }],
      }),
      now: () => at(e) + 6 * HOUR,
    });
    const epoch = (await RewardEpoch.findOne({ ...KEY, epochId: e }))!;
    assert.equal(epoch.priceE18, P1.toString(), "must be the boundary price");
    assert.notEqual(epoch.priceE18, P2.toString());
  });

  it("36. every reward-critical read uses the SAME snapshot block", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const base = reader([chainStake({ id: 1n }, e)]);
    const pinned = { stakes: [] as (bigint | undefined)[], pools: [] as (bigint | undefined)[], price: [] as (bigint | undefined)[] };
    const spy: RewardChainReader = {
      ...base,
      async getStakes(ids, pin) { pinned.stakes.push(pin?.blockNumber); return base.getStakes(ids, pin); },
      async getPools(pin) { pinned.pools.push(pin?.blockNumber); return base.getPools(pin); },
      async priceSnapshot(pin) { pinned.price.push(pin?.blockNumber); return base.priceSnapshot(pin); },
    };
    await runRewardEpoch(e, { reader: spy, now: () => at(e) + 6 * HOUR });

    const block = BigInt((await RewardEpoch.findOne({ ...KEY, epochId: e }))!.snapshotBlockNumber!);
    assert.deepEqual(pinned.pools, [block], "pool ROI must be pinned");
    assert.deepEqual(pinned.price, [block], "price must be pinned");
    // Discovery and current-state reconciliation legitimately read latest (undefined); the
    // reward evaluation read must be pinned.
    assert.ok(pinned.stakes.includes(block), "the reward read must be pinned");
    assert.equal(
      (await RewardEpoch.findOne({ ...KEY, epochId: e }))!.priceBlockNumber,
      Number(block), "the recorded price block must be the snapshot block",
    );
  });

  it("37. an unreadable stake at the snapshot block FAILS the epoch, no latest fallback", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const base = reader([chainStake({ id: 1n, stakeTimestamp: at(e) - 50 * EPOCH_SECONDS }, e)]);
    const broken: RewardChainReader = {
      ...base,
      // Fails only the pinned (historical) read, exactly as a non-archive node would.
      async getStakes(ids, pin) {
        if (pin?.blockNumber !== undefined) return ids.map(() => null);
        return base.getStakes(ids, pin);
      },
    };
    await assert.rejects(
      runRewardEpoch(e, { reader: broken, now: () => at(e) + 6 * HOUR }),
      (err: unknown) => /could not be read at snapshot block/.test((err as Error).message),
    );
    assert.equal((await RewardEpoch.findOne({ ...KEY, epochId: e }))!.status, "FAILED");
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e }), 0);
  });

  it("38. a failure to resolve the snapshot block FAILS the epoch", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    // headAt before the boundary: the epoch boundary is not final on chain yet.
    await assert.rejects(
      runRewardEpoch(e, {
        reader: reader([chainStake({ id: 1n }, e)], { headAt: at(e) - 10 }),
        now: () => at(e) + HOUR,
      }),
      (err: unknown) => /has not passed/.test((err as Error).message),
    );
    assert.equal((await RewardEpoch.findOne({ ...KEY, epochId: e }))!.status, "FAILED");
  });

  it("39. the on-chain withdrawal block and timestamp are recovered", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const withdrawnAtSec = at(e) + HOUR;
    await runRewardEpoch(e, {
      reader: reader([chainStake({
        id: 1n, stakeTimestamp: at(e) - 50 * EPOCH_SECONDS, withdrawnAtSec,
      }, e)]),
      now: () => at(e) + 6 * HOUR,
    });

    const row = (await Stake.findOne({ ...KEY, stakeId: "1" }))!;
    assert.equal(row.active, false, "current state reflects the withdrawal");
    assert.equal(row.withdrawnBlockTimestamp, withdrawnAtSec, "the REAL on-chain time");
    assert.equal(row.withdrawnBlockNumber, withdrawnAtSec);
  });

  it("39b. detection time and on-chain withdrawal time are different values", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const spec = { id: 1n, principal: 1000n * E18, stakeTimestamp: at(e) - 50 * EPOCH_SECONDS };

    // Attempt 1 persists the stake while it is still active, then fails on price.
    await assert.rejects(runRewardEpoch(e, {
      reader: reader([chainStake(spec, e)], { price: 0n }), now: () => at(e) + HOUR,
    }));
    assert.equal((await Stake.findOne({ ...KEY, stakeId: "1" }))!.active, true);

    // It is withdrawn, then reconciliation RETIRES the previously-active row.
    const withdrawnAtSec = at(e) + 2 * HOUR;
    WITHDRAWN.set("1", withdrawnAtSec);
    await runRewardEpoch(e, { reader: reader([chainStake(spec, e)]), now: () => at(e) + 6 * HOUR });

    const row = (await Stake.findOne({ ...KEY, stakeId: "1" }))!;
    assert.equal(row.active, false);
    // The financial timestamp is the chain's.
    assert.equal(row.withdrawnBlockTimestamp, withdrawnAtSec);
    // The breadcrumb is the backend's own clock, and is NOT the same thing.
    assert.ok(row.withdrawnAt instanceof Date, "detection time recorded on the retire path");
    assert.notEqual(
      Math.floor(row.withdrawnAt!.getTime() / 1000), row.withdrawnBlockTimestamp,
      "detection time must not be mistaken for the on-chain withdrawal time",
    );
  });

  it("40. an already-withdrawn row with no metadata is backfilled", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const withdrawnAtSec = at(e) - 5 * HOUR;
    const spec = { id: 1n, stakeTimestamp: at(e) - 50 * EPOCH_SECONDS, withdrawnAtSec };
    const r = reader([chainStake(spec, e)]);

    // A row retired by the OLD code path: active false, no chain metadata.
    await Stake.collection.insertOne({
      eventId: `${KEY.chainId}:legacy:1`, chainId: KEY.chainId, stakingContractAddress: LOW,
      stakeId: "1", userId: "usr_1", externalEOA: USER_ADDRESS, poolId: 1,
      principalACF: (1000n * E18).toString(), source: "DIRECT", poolDailyROIAtCreation: "0",
      stakeTimestamp: new Date((at(e) - 50 * EPOCH_SECONDS) * 1000),
      unlockTimestamp: new Date((at(e) - 50 * EPOCH_SECONDS) * 1000),
      active: false, withdrawnAt: new Date(), withdrawnBlockNumber: null,
      withdrawnBlockTimestamp: null, txHash: `0x${"0".repeat(64)}`, blockNumber: 0, logIndex: -1,
    } as never);
    await StakeReconciliationState.create({ ...KEY, nextStakeIdProcessed: "2" });

    const result = await backfillWithdrawalBlocks(r);

    assert.equal(result.attempted, 1);
    assert.equal(result.recovered, 1);
    const row = (await Stake.findOne({ ...KEY, stakeId: "1" }))!;
    assert.equal(row.withdrawnBlockTimestamp, withdrawnAtSec);
    // Idempotent: a second run finds nothing to do.
    assert.equal((await backfillWithdrawalBlocks(r)).attempted, 0);
  });

  it("41. current Stake.active may be false while a historical epoch still earns", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await runRewardEpoch(e, {
      reader: reader([chainStake({
        id: 1n, principal: 1000n * E18,
        stakeTimestamp: at(e) - 50 * EPOCH_SECONDS, withdrawnAtSec: at(e) + HOUR,
      }, e)]),
      now: () => at(e) + 6 * HOUR,
    });
    // The two coexist, which is the entire point of the correction.
    assert.equal((await Stake.findOne({ ...KEY, stakeId: "1" }))!.active, false);
    assert.equal((await entry("1", e))!.rewardEligible, true);
  });

  it("42. an immutable-field mismatch fails the epoch loudly and is never repaired", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    // DB says 1000 ACF; the chain says 500.
    await Stake.collection.insertOne({
      eventId: `${KEY.chainId}:bad:1`, chainId: KEY.chainId, stakingContractAddress: LOW,
      stakeId: "1", userId: "usr_1", externalEOA: USER_ADDRESS, poolId: 1,
      principalACF: (1000n * E18).toString(), source: "DIRECT", poolDailyROIAtCreation: "0",
      stakeTimestamp: new Date((at(e) - 50 * EPOCH_SECONDS) * 1000),
      unlockTimestamp: new Date((at(e) - 50 * EPOCH_SECONDS) * 1000),
      active: true, txHash: `0x${"0".repeat(64)}`, blockNumber: 0, logIndex: -1,
    } as never);
    await StakeReconciliationState.create({ ...KEY, nextStakeIdProcessed: "2" });

    await assert.rejects(
      runRewardEpoch(e, {
        reader: reader([chainStake({
          id: 1n, principal: 500n * E18, stakeTimestamp: at(e) - 50 * EPOCH_SECONDS,
        }, e)]),
        now: () => at(e) + 6 * HOUR,
      }),
      (err: unknown) => /does not match chain state/.test((err as Error).message)
        && /principal/.test((err as Error).message),
    );
    // The row is reported, never rewritten.
    assert.equal((await Stake.findOne({ ...KEY, stakeId: "1" }))!.principalACF, (1000n * E18).toString());
    assert.equal((await RewardEpoch.findOne({ ...KEY, epochId: e }))!.status, "FAILED");
  });

  it("43. a retry after the chain advances produces identical reward rows", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const spec = { id: 1n, principal: 1000n * E18, stakeTimestamp: at(e) - 50 * EPOCH_SECONDS };

    // Attempt 1 fails after resolving the block; nothing about the epoch is settled.
    await assert.rejects(runRewardEpoch(e, {
      reader: reader([chainStake(spec, e)], { price: 0n }), now: () => at(e) + HOUR,
    }));
    const block = (await RewardEpoch.findOne({ ...KEY, epochId: e }))!.snapshotBlockNumber;

    // Now the world moves on: withdrawal, ROI change, price change.
    WITHDRAWN.set("1", at(e) + 2 * HOUR);
    const r = await runRewardEpoch(e, {
      reader: reader([chainStake(spec, e)], {
        roiSchedule: [
          { from: 0, pools: [{ poolId: 1, lockDuration: 0, rate: 2_500n }] },
          { from: at(e) + HOUR, pools: [{ poolId: 1, lockDuration: 0, rate: 9_000n }] },
        ],
        priceSchedule: [{ from: 0, price: 10n ** 18n }, { from: at(e) + HOUR, price: 5n * 10n ** 18n }],
      }),
      now: () => at(e) + 500 * HOUR,
    });

    assert.equal(r.status, "CALCULATED");
    const epoch = (await RewardEpoch.findOne({ ...KEY, epochId: e }))!;
    assert.equal(epoch.snapshotBlockNumber, block, "same anchor");
    assert.equal(epoch.priceE18, (10n ** 18n).toString(), "boundary price");
    const row = (await entry("1", e))!;
    assert.equal(row.rateApplied, "2500", "boundary ROI");
    assert.equal(row.rewardEligible, true, "active at the boundary despite a later withdrawal");
    assert.equal(row.rewardACF, (1250n * E18 / 1000n).toString());
  });
});

describe("reward rows must provably persist", () => {
  // Regression for B1: insertMany(ordered:false) reports a top-level code of 11000 whenever ANY
  // row duplicated, and reports a validation-rejected row in no channel at all. Branching on
  // that error silently dropped reward liability while the epoch still reached CALCULATED.

  /** A stake row written straight through the driver, bypassing schema validation. */
  const rawStake = async (stakeId: string, over: Record<string, unknown> = {}) => {
    await Stake.collection.insertOne({
      eventId: `${KEY.chainId}:raw:${stakeId}`,
      chainId: KEY.chainId,
      stakingContractAddress: LOW,
      stakeId,
      userId: "usr_1",
      externalEOA: USER_ADDRESS,
      poolId: 1,
      principalACF: (1000n * E18).toString(),
      source: "DIRECT",
      poolDailyROIAtCreation: "0",
      stakeTimestamp: new Date((at(ACTIVATION + 1) - 10 * EPOCH_SECONDS) * 1000),
      unlockTimestamp: new Date((at(ACTIVATION + 1) - 10 * EPOCH_SECONDS) * 1000),
      active: true,
      txHash: `0x${"0".repeat(64)}`,
      blockNumber: 0,
      logIndex: -1,
      ...over,
    } as never);
  };

  it("22. a reward row that cannot persist FAILS the epoch instead of being dropped", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;

    // Stake 1 is normal. Stake 2 has no userId, so its StakeRewardEntry fails `required`
    // validation — the failure mode that appears in NO error channel.
    await rawStake("1");
    await rawStake("2", { userId: undefined });

    // Discovery must not re-add them, so park the cursor past both.
    await StakeReconciliationState.create({ ...KEY, nextStakeIdProcessed: "3" });

    await assert.rejects(
      runRewardEpoch(e, {
        reader: reader([chainStake({ id: 1n }, e), chainStake({ id: 2n }, e)]),
        now: () => at(e),
      }),
      (err: unknown) => /did not persist/.test((err as Error).message)
        && /stake 2/.test((err as Error).message),
      "the epoch must fail and name the stake whose row was lost",
    );

    const epoch = (await RewardEpoch.findOne({ ...KEY, epochId: e }))!;
    assert.equal(epoch.status, "FAILED", "must never be CALCULATED with a missing row");
    assert.notEqual(epoch.status, "CALCULATED");
  });

  it("23. after repair, the recovered epoch counts each reward exactly once", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e1 = ACTIVATION + 1;
    const e2 = e1 + 1;
    await rawStake("1");
    await rawStake("2", { userId: undefined });
    await StakeReconciliationState.create({ ...KEY, nextStakeIdProcessed: "3" });
    const r = reader([chainStake({ id: 1n }, e1), chainStake({ id: 2n }, e1)]);

    await assert.rejects(runRewardEpoch(e1, { reader: r, now: () => at(e1) }));

    // Stake 1's row DID land. Partial rows are allowed to persist — they are excluded from
    // compounding by the epoch's status, not by being absent.
    assert.equal((await RewardEpoch.findOne({ ...KEY, epochId: e1 }))!.status, "FAILED");
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e1 }), 1);
    const partial = (await entry("1", e1))!.rewardACF;

    // Repair the cause and re-run the SAME epoch.
    await Stake.collection.updateOne({ stakeId: "2" }, { $set: { userId: "usr_1" } });
    const repaired = await runRewardEpoch(e1, { reader: r, now: () => at(e1) });
    assert.equal(repaired.status, "CALCULATED");
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e1 }), 2);
    // Stake 1 keeps its original row rather than gaining a second one.
    assert.equal((await entry("1", e1))!.rewardACF, partial);

    // The next epoch compounds that reward once, not twice.
    await runRewardEpoch(e2, { reader: r, now: () => at(e2) });
    assert.equal((await entry("1", e2))!.compoundBaseACF, (1000n * E18 + BigInt(partial)).toString());
  });

  it("24. a mid-batch crash resumes without double-crediting the rows already written", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    const COUNT = 25;
    const stakes = Array.from({ length: COUNT }, (_, i) =>
      chainStake({ id: BigInt(i + 1), principal: 1000n * E18 }, e));

    // A first attempt that died after writing 10 of 25 rows, leaving the epoch PROCESSING with
    // an expired lease — the exact state audit 17 describes.
    await runRewardEpoch(e, { reader: reader(stakes.slice(0, 10)), now: () => at(e) });
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e }), 10);
    const firstTen = await StakeRewardEntry.find({ ...KEY, epochId: e }).lean();
    await RewardEpoch.updateOne({ ...KEY, epochId: e }, {
      $set: { status: "PROCESSING", leaseExpiresAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    // The retry sees all 25 on chain.
    const retry = await runRewardEpoch(e, { reader: reader(stakes), now: () => at(e) });

    assert.equal(retry.status, "CALCULATED");
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e }), COUNT,
      "every stake must end with exactly one row");
    // The 10 pre-existing rows are untouched: no double credit, no rewrite.
    for (const before of firstTen) {
      const after = (await entry(before.stakeId as string, e))!;
      assert.equal(after.rewardACF, before.rewardACF);
      assert.equal(after.compoundBaseACF, before.compoundBaseACF);
      assert.equal(String(after._id), String(before._id), "the original row must be kept, not replaced");
    }
  });
});

describe("pagination completeness", () => {
  it("20. more stakes than one page are all settled, past the single-digit ids", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    // stakeId is stored as a string, so both page loops order lexicographically ("10" < "9").
    // That is complete and duplicate-free only because the sort and the $gt cursor share one
    // ordering. 25 stakes crosses the 9->10 boundary where a numeric assumption would break.
    const many = Array.from({ length: 25 }, (_, i) =>
      chainStake({ id: BigInt(i + 1), principal: 1000n * E18 }, e));

    const r = await runRewardEpoch(e, { reader: reader(many), now: () => at(e) });

    assert.equal(r.stakesProcessed, 25);
    assert.equal(r.stakesRewarded, 25);
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e }), 25);
    // Every id present exactly once, including the two-digit ones.
    const ids = (await StakeRewardEntry.find({ ...KEY, epochId: e }, { stakeId: 1 }))
      .map((x) => Number(x.stakeId)).sort((a, b) => a - b);
    assert.deepEqual(ids, Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("21. reconciliation retires withdrawn stakes across page boundaries", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e1 = ACTIVATION + 1;
    const live = Array.from({ length: 25 }, (_, i) =>
      chainStake({ id: BigInt(i + 1), principal: 1000n * E18 }, e1));
    await runRewardEpoch(e1, { reader: reader(live), now: () => at(e1) });
    assert.equal(await Stake.countDocuments({ active: true }), 25);

    // Every stake is withdrawn at once: the old skip/limit arithmetic drifted here because
    // retired rows left the active filter mid-scan.
    const e2 = e1 + 1;
    const withdrawn = Array.from({ length: 25 }, (_, i) =>
      chainStake({ id: BigInt(i + 1), principal: 1000n * E18, active: false }, e2));
    await runRewardEpoch(e2, { reader: reader(withdrawn), now: () => at(e2) });

    assert.equal(await Stake.countDocuments({ active: true }), 0, "all 25 must be retired");
    const paid = await StakeRewardEntry.countDocuments({ ...KEY, epochId: e2, rewardEligible: true });
    assert.equal(paid, 0, "a withdrawn stake must not be paid");
  });
});

describe("epoch failure atomicity", () => {
  it("19. a price failure settles nothing and marks the epoch FAILED", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await assert.rejects(
      runRewardEpoch(e, {
        reader: reader([chainStake({ id: 1n }, e)], { price: 0n }),
        now: () => at(e),
      }),
      /refusing to settle an epoch/i,
    );
    assert.equal((await RewardEpoch.findOne({ ...KEY, epochId: e }))!.status, "FAILED");
    assert.equal(await StakeRewardEntry.countDocuments({ ...KEY, epochId: e }), 0);
  });

  it("20. a FAILED epoch can be retried and then settles cleanly", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await assert.rejects(runRewardEpoch(e, { reader: reader([], { price: 0n }), now: () => at(e) }));
    const r = await runRewardEpoch(e, {
      reader: reader([chainStake({ id: 1n }, e)]), now: () => at(e),
    });
    assert.equal(r.status, "CALCULATED");
    assert.equal((await RewardEpoch.findOne({ ...KEY, epochId: e }))!.attempts, 2);
  });

  it("21. an epoch is never marked FINALIZED by Phase 1", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e = ACTIVATION + 1;
    await runRewardEpoch(e, { reader: reader([chainStake({ id: 1n }, e)]), now: () => at(e) });
    // FINALIZED belongs to Merkle settlement, which does not exist yet.
    assert.equal(await RewardEpoch.countDocuments({ status: "FINALIZED" }), 0);
  });
});

// ════════════════════════════════════ CLAIM-DRIVEN COMPOUND RESET ════
//
// Phase 3 publishes earned reward in checkpoints and the user claims them on chain. Earned
// reward compounds until it is CLAIMED: publishing changes nothing, and a confirmed claim
// retires exactly the epochs that checkpoint covered — not the whole balance.

describe("claim-driven compound reset", () => {
  const WD = "0x882db912586869315c2720de72224d79b9d99ea1";
  const SETTLE = { chainId: 80002, withdrawalAddress: WD };

  /** Records that `checkpointId` published this stake's reward for `rewardEpochId`. */
  const publish = (checkpointId: number, rewardEpochId: number, stakeId: string, acf: bigint) =>
    CheckpointSelfComponent.create({
      ...SETTLE, stakingContractAddress: LOW, checkpointId, userId: "usr_1",
      externalEOA: USER_ADDRESS.toLowerCase(), stakeId, source: "DIRECT", rewardEpochId,
      rewardACF: acf.toString(),
    });

  /** Records a CONFIRMED on-chain claim up to and including `checkpointId`. */
  const confirmClaim = (checkpointId: number, total: bigint) =>
    UserClaimState.create({
      ...SETTLE, userId: "usr_1", externalEOA: USER_ADDRESS.toLowerCase(),
      alreadyClaimedACF: total.toString(), highestClaimedCheckpointId: checkpointId,
    });

  it("31. publishing alone does NOT reset the base — only claiming does", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const e1 = ACTIVATION + 1;
    const e2 = e1 + 1;
    const stake = (ep: number) => chainStake({ id: 1n, principal: 1000n * E18 }, ep);

    await runRewardEpoch(e1, { reader: reader([stake(e1)]), now: () => at(e1) });
    const r1 = BigInt((await entry("1", e1))!.rewardACF);

    // A checkpoint publishes e1's reward, but nothing is claimed.
    await publish(500, e1, "1", r1);

    await runRewardEpoch(e2, { reader: reader([stake(e2)]), now: () => at(e2) });
    assert.equal(
      (await entry("1", e2))!.compoundBaseACF, (1000n * E18 + r1).toString(),
      "an unclaimed published reward still compounds",
    );
  });

  it("32. THE MANDATORY SCENARIO — claiming P+100+105 leaves epoch 12's 110 compounding", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const [e1, e2, e3, e4] = [ACTIVATION + 1, ACTIVATION + 2, ACTIVATION + 3, ACTIVATION + 4];
    const principal = 1000n * E18;
    const stake = (ep: number) => chainStake({ id: 1n, principal }, ep);

    await runRewardEpoch(e1, { reader: reader([stake(e1)]), now: () => at(e1) });
    await runRewardEpoch(e2, { reader: reader([stake(e2)]), now: () => at(e2) });
    await runRewardEpoch(e3, { reader: reader([stake(e3)]), now: () => at(e3) });
    const r1 = BigInt((await entry("1", e1))!.rewardACF);
    const r2 = BigInt((await entry("1", e2))!.rewardACF);
    const r3 = BigInt((await entry("1", e3))!.rewardACF);

    // Checkpoint C published epochs 1 and 2 only; epoch 3 was earned afterwards.
    await publish(500, e1, "1", r1);
    await publish(500, e2, "1", r2);
    await confirmClaim(500, r1 + r2);

    await runRewardEpoch(e4, { reader: reader([stake(e4)]), now: () => at(e4) });
    assert.equal(
      (await entry("1", e4))!.compoundBaseACF, (principal + r3).toString(),
      "principal plus ONLY the unclaimed epoch-3 reward — not the full history, not principal alone",
    );
    assert.notEqual(r3, 0n, "the scenario is vacuous if epoch 3 earned nothing");
  });

  it("33. claiming everything returns the base to principal alone", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const [e1, e2] = [ACTIVATION + 1, ACTIVATION + 2];
    const principal = 1000n * E18;
    const stake = (ep: number) => chainStake({ id: 1n, principal }, ep);

    await runRewardEpoch(e1, { reader: reader([stake(e1)]), now: () => at(e1) });
    const r1 = BigInt((await entry("1", e1))!.rewardACF);
    await publish(500, e1, "1", r1);
    await confirmClaim(500, r1);

    await runRewardEpoch(e2, { reader: reader([stake(e2)]), now: () => at(e2) });
    const row = (await entry("1", e2))!;
    assert.equal(row.compoundBaseACF, principal.toString());
    assert.equal(row.cumulativeEarnedACF, (r1 + BigInt(row.rewardACF)).toString(),
      "cumulativeEarnedACF is lifetime earned and is NOT reduced by a claim",
    );
  });

  it("34. a component published after the claimed checkpoint keeps compounding", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const [e1, e2, e3] = [ACTIVATION + 1, ACTIVATION + 2, ACTIVATION + 3];
    const principal = 1000n * E18;
    const stake = (ep: number) => chainStake({ id: 1n, principal }, ep);

    await runRewardEpoch(e1, { reader: reader([stake(e1)]), now: () => at(e1) });
    await runRewardEpoch(e2, { reader: reader([stake(e2)]), now: () => at(e2) });
    const r1 = BigInt((await entry("1", e1))!.rewardACF);
    const r2 = BigInt((await entry("1", e2))!.rewardACF);

    await publish(500, e1, "1", r1);
    await publish(501, e2, "1", r2);        // published by a LATER checkpoint
    await confirmClaim(500, r1);            // only 500 is claimed

    await runRewardEpoch(e3, { reader: reader([stake(e3)]), now: () => at(e3) });
    assert.equal((await entry("1", e3))!.compoundBaseACF, (principal + r2).toString());
  });

  it("35. another stake's claim never touches this stake's base", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const [e1, e2] = [ACTIVATION + 1, ACTIVATION + 2];
    const principal = 1000n * E18;
    const stakes = (ep: number) => [
      chainStake({ id: 1n, principal }, ep),
      chainStake({ id: 2n, principal }, ep),
    ];

    await runRewardEpoch(e1, { reader: reader(stakes(e1)), now: () => at(e1) });
    const r1 = BigInt((await entry("1", e1))!.rewardACF);
    const other = BigInt((await entry("2", e1))!.rewardACF);

    // Stake 2's reward is claimed; stake 1's is not.
    await publish(500, e1, "2", other);
    await confirmClaim(500, other);

    await runRewardEpoch(e2, { reader: reader(stakes(e2)), now: () => at(e2) });
    assert.equal((await entry("1", e2))!.compoundBaseACF, (principal + r1).toString(),
      "stake 1 is unaffected");
    assert.equal((await entry("2", e2))!.compoundBaseACF, principal.toString(),
      "stake 2 reset");
  });

  it("36. claimed EXCEEDING earned fails the epoch loudly, never floors to zero", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const [e1, e2] = [ACTIVATION + 1, ACTIVATION + 2];
    const principal = 1000n * E18;
    const stake = (ep: number) => chainStake({ id: 1n, principal }, ep);

    await runRewardEpoch(e1, { reader: reader([stake(e1)]), now: () => at(e1) });
    const r1 = BigInt((await entry("1", e1))!.rewardACF);

    // A corrupt component claims more than was ever earned.
    await publish(500, e1, "1", r1 + 1n);
    await confirmClaim(500, r1 + 1n);

    await assert.rejects(
      runRewardEpoch(e2, { reader: reader([stake(e2)]), now: () => at(e2) }),
      ClaimLedgerError,
    );
    // The epoch did not silently produce a reward on a floored base.
    assert.equal(await entry("1", e2), null);
  });
});
