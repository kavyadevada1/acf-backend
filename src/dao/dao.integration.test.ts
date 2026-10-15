import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { encodeAbiParameters, keccak256, toHex, pad } from "viem";
import type { DAOServiceReader } from "./service.ts";

const TEST_URI = process.env.MONGODB_TEST_URI;
function assertDisposable(uri: string): string {
  const name = new URL(uri).pathname.replace(/^\//, "");
  if (!name || !/test/i.test(name)) throw new Error(`MONGODB_TEST_URI must name a test database (got "${name}").`);
  return uri;
}

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
process.env.ACF_STAKING_ADDRESS ??= "0x9eDbbf53f784450CC8Fd50730984Cb7D8DDF743d";
process.env.WITHDRAWAL_ADDRESS ??= "0x882db912586869315C2720dE72224d79B9D99Ea1";
process.env.TREASURY_ADDRESS ??= "0x114fe8e3414bc49A24C6efd9E702cD66B9A80251";
process.env.ACF_TOKEN_ADDRESS ??= "0x7AEB95CaE1e5442Fe1170555ae81280B763D3BF1";
process.env.ACF_BOND_ADDRESS ??= "0x3a97D05a088aDBB79936914F245c2E0bf7F511f2";
process.env.ACF_DAO_ADDRESS ??= "0x9cf32271E052Cbbc1D6C564B6fE6a86B6ED08E45";
process.env.MOCK_USDT_ADDRESS ??= "0x21ff9e803fc496e4db1c1a6c354690636b9fc330";
process.env.SWAP_CONFIRMATIONS ??= "1";

const { recordDAOContribution, listDAOContributions, getDAOMembership } = await import("./service.js");
const { daoRewardPolicy } = await import("./policy.js");
const { DAOContribution } = await import("../models/DAOContribution.js");
const { DAOReconciliationState } = await import("../models/DAOReconciliationState.js");
const { Stake } = await import("../models/Stake.js");
const { User } = await import("../models/User.js");
const { HttpError } = await import("../lib/errors.js");

const DAO = "0x9cf32271e052cbbc1d6c564b6fe6a86b6ed08e45";
const STAKING = "0x9edbbf53f784450cc8fd50730984cb7d8ddf743d";
const OTHER = "0x1111111111111111111111111111111111111111";
/** The user's own address: what they authenticate with AND what the DAO records. */
const USER_ADDRESS = "0x7c2d6b5f65c820c1cb014313ab17419420d3e3a7";
const STRANGER = "0x2222222222222222222222222222222222222222";
const TX = "0x" + "cd".repeat(32);

const DAO_T0 = keccak256(toHex("DAOContributionCreated(uint256,address,uint256,uint256,uint256,uint256,uint256)"));
const STAKE_T0 = keccak256(toHex("StakeCreated(address,uint256,uint256,uint256,uint256,uint256,uint256,uint8)"));

const U = 1_000_000n;                                  // USDT 6dp
const SILVER = 5_000n * U;
const GOLD = 25_000n * U;
const DAO_POOL = 6n;
const ACF_STAKED = 3_231_000_000_000_000_000_000n;      // 18dp
const LOCK = 750n * 86_400n;

function daoLog(o: {
  address?: string; beneficiary?: string; contributionId?: bigint; stakeId?: bigint;
  poolId?: bigint; usdtContributed?: bigint; acfStaked?: bigint; logIndex?: number;
} = {}) {
  const { address = DAO, beneficiary = USER_ADDRESS, contributionId = 1n, stakeId = 9n,
          poolId = DAO_POOL, usdtContributed = SILVER, acfStaked = ACF_STAKED, logIndex = 6 } = o;
  return {
    address,
    topics: [DAO_T0, pad(toHex(contributionId), { size: 32 }),
             pad(beneficiary as `0x${string}`, { size: 32 }), pad(toHex(stakeId), { size: 32 })],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [poolId, usdtContributed, acfStaked, 1_547_749_657_915_444_035n],
    ),
    logIndex,
  };
}

function stakeLog(o: {
  address?: string; user?: string; stakeId?: bigint; poolId?: bigint;
  principal?: bigint; source?: 0 | 1 | 2; logIndex?: number;
} = {}) {
  const { address = STAKING, user = USER_ADDRESS, stakeId = 9n, poolId = DAO_POOL,
          principal = ACF_STAKED, source = 2, logIndex = 4 } = o;
  return {
    address,
    topics: [STAKE_T0, pad(user as `0x${string}`, { size: 32 }),
             pad(toHex(stakeId), { size: 32 }), pad(toHex(poolId), { size: 32 })],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint8" }],
      [principal, 5_000n, 1_790_000_000n, 1_790_000_000n + LOCK, source],
    ),
    logIndex,
  };
}

/** Chain fake. `contributions` is the contract's own storage; `active` its live stake state. */
function reader(
  logs: ReturnType<typeof daoLog | typeof stakeLog>[] | null,
  o: {
    status?: "success" | "reverted"; block?: bigint; head?: bigint;
    contributions?: Map<string, { beneficiary: string; usdtContributed: bigint; acfStaked: bigint; poolId: bigint; stakeId: bigint; timestamp: bigint }>;
    active?: Map<string, boolean>;
    nextContributionId?: bigint;
    silver?: bigint; gold?: bigint; closed?: boolean; revenueEnabled?: boolean;
  } = {},
): DAOServiceReader {
  const contributions = o.contributions ?? new Map([
    ["1", { beneficiary: USER_ADDRESS, usdtContributed: SILVER, acfStaked: ACF_STAKED, poolId: DAO_POOL, stakeId: 9n, timestamp: 1_790_000_000n }],
  ]);
  const active = o.active ?? new Map<string, boolean>();
  return {
    async receiptOf() { return logs === null ? null : { status: o.status ?? "success", blockNumber: o.block ?? 900n, logs }; },
    async headBlock() { return o.head ?? 1_000n; },
    async blockTimestamp() { return 1_790_000_000n; },
    async daoRevenueConfig() {
      return { silverMinimumUSDT: o.silver ?? SILVER, goldMinimumUSDT: o.gold ?? GOLD,
               memberRevenuePercentage: 50_000n, marketingPercentage: 20_000n };
    },
    async daoPoolId() { return DAO_POOL; },
    async daoLockDuration() { return LOCK; },
    async daoRevenueEnabled() { return o.revenueEnabled ?? true; },
    async daoClosed() { return o.closed ?? false; },
    async daoNextContributionId() { return o.nextContributionId ?? BigInt(contributions.size + 1); },
    async daoContribution(id) {
      const c = contributions.get(id.toString());
      if (!c) throw new Error("UnknownContribution");
      return c;
    },
    async daoContributionActive(id) { return active.get(id.toString()) ?? true; },
  };
}

const codeIs = (c: string) => (e: unknown) => e instanceof HttpError && e.code === c;

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set — DAO tests skipped"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([User.init(), Stake.init(), DAOContribution.init(), DAOReconciliationState.init()]);
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (connected) await Promise.all([
    User.deleteMany({}), Stake.deleteMany({}),
    DAOContribution.deleteMany({}), DAOReconciliationState.deleteMany({}),
  ]);
});

const makeUser = () =>
  User.create({ userId: "usr_1", externalEOA: USER_ADDRESS, referralCode: "ACF-AAAAAAAA" });

describe("recordDAOContribution", () => {
  it("1. decodes a valid contribution and persists BOTH records", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const r = await recordDAOContribution("usr_1", TX, reader([stakeLog(), daoLog()]));
    assert.equal(r.contributionId, "1");
    assert.equal(r.stakeId, "9");
    assert.equal(r.usdtContributed, SILVER.toString());
    assert.equal(r.daoPoolId, Number(DAO_POOL));
    assert.equal(await DAOContribution.countDocuments({}), 1);
    const stake = await Stake.findOne({ stakeId: "9" });
    assert.equal(stake?.source, "DAO");
  });

  it("2. rejects an event from a contract that is not the canonical DAO", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordDAOContribution("usr_1", TX, reader([stakeLog(), daoLog({ address: OTHER })])),
      codeIs("NO_CONTRIBUTION_FOR_WALLET"));
    assert.equal(await DAOContribution.countDocuments({}), 0);
  });

  it("3. rejects a contribution whose beneficiary is another wallet", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordDAOContribution("usr_1", TX, reader([stakeLog(), daoLog({ beneficiary: STRANGER })])),
      codeIs("NO_CONTRIBUTION_FOR_WALLET"));
  });

  it("4. rejects when the linked stake belongs to someone else", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordDAOContribution("usr_1", TX, reader([stakeLog({ user: STRANGER }), daoLog()])),
      codeIs("STAKE_BENEFICIARY_MISMATCH"));
  });

  it("5. rejects a non-DAO source, so /dao/sync cannot absorb a DIRECT or BOND stake", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    for (const source of [0, 1] as const) {
      await assert.rejects(
        recordDAOContribution("usr_1", TX, reader([stakeLog({ source }), daoLog()])),
        codeIs("NOT_DAO_STAKE"));
    }
    assert.equal(await Stake.countDocuments({}), 0);
  });

  it("6. rejects a position outside the canonical DAO pool", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordDAOContribution("usr_1", TX, reader([stakeLog({ poolId: 2n }), daoLog({ poolId: 2n })],
        { contributions: new Map([["1", { beneficiary: USER_ADDRESS, usdtContributed: SILVER, acfStaked: ACF_STAKED, poolId: 2n, stakeId: 9n, timestamp: 1_790_000_000n }]]) })),
      codeIs("NOT_DAO_POOL"));
  });

  it("7. rejects a principal mismatch between the two events", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordDAOContribution("usr_1", TX, reader([stakeLog({ principal: 1n }), daoLog()])),
      codeIs("PRINCIPAL_MISMATCH"));
  });

  it("8. rejects when contract storage disagrees with the event", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const tampered = new Map([["1", { beneficiary: USER_ADDRESS, usdtContributed: 1n, acfStaked: ACF_STAKED, poolId: DAO_POOL, stakeId: 9n, timestamp: 1_790_000_000n }]]);
    await assert.rejects(
      recordDAOContribution("usr_1", TX, reader([stakeLog(), daoLog()], { contributions: tampered })),
      codeIs("CONTRIBUTION_MISMATCH"));
  });

  it("9. is idempotent: replaying the same transaction creates nothing new", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const r = reader([stakeLog(), daoLog()]);
    const a = await recordDAOContribution("usr_1", TX, r);
    const b = await recordDAOContribution("usr_1", TX, r);
    assert.deepEqual(a, b);
    assert.equal(await DAOContribution.countDocuments({}), 1);
    assert.equal(await Stake.countDocuments({}), 1);
  });

  it("10. rejects an unconfirmed or reverted transaction before writing anything", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordDAOContribution("usr_1", TX, reader([stakeLog(), daoLog()], { block: 1_000n, head: 999n })),
      codeIs("NOT_CONFIRMED"));
    await assert.rejects(
      recordDAOContribution("usr_1", TX, reader([stakeLog(), daoLog()], { status: "reverted" })),
      codeIs("TX_REVERTED"));
    assert.equal(await DAOContribution.countDocuments({}), 0);
  });
});

describe("reconciliation", () => {
  it("11. discovers a chain-only contribution that never reached /dao/sync", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    // Nothing was ever synced from the browser.
    assert.equal(await DAOContribution.countDocuments({}), 0);
    const { contributions } = await listDAOContributions("usr_1", reader(null));
    assert.equal(contributions.length, 1);
    assert.equal(contributions[0]!.contributionId, "1");
    assert.equal(contributions[0]!.usdtContributed, SILVER.toString());
  });

  it("12. ignores contributions belonging to other wallets", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const foreign = new Map([["1", { beneficiary: STRANGER, usdtContributed: GOLD, acfStaked: ACF_STAKED, poolId: DAO_POOL, stakeId: 9n, timestamp: 1_790_000_000n }]]);
    const { contributions } = await listDAOContributions("usr_1", reader(null, { contributions: foreign }));
    assert.equal(contributions.length, 0);
  });

  it("12b. one user's reconciliation must not hide another user's contribution", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Two contributions: #1 belongs to a stranger, #2 to our user.
    const both = new Map([
      ["1", { beneficiary: STRANGER, usdtContributed: GOLD, acfStaked: ACF_STAKED, poolId: DAO_POOL, stakeId: 1n, timestamp: 1_790_000_000n }],
      ["2", { beneficiary: USER_ADDRESS, usdtContributed: SILVER, acfStaked: ACF_STAKED, poolId: DAO_POOL, stakeId: 2n, timestamp: 1_790_000_000n }],
    ]);

    // The stranger reads first and walks the whole range, persisting only their own row.
    await User.create({ userId: "usr_other", externalEOA: STRANGER, referralCode: "ACF-BBBBBBBB" });
    await listDAOContributions("usr_other", reader(null, { contributions: both }));

    // Our user must still discover contribution #2, even though the scan already passed it.
    await makeUser();
    const { contributions } = await listDAOContributions("usr_1", reader(null, { contributions: both }));
    assert.equal(contributions.length, 1);
    assert.equal(contributions[0]!.contributionId, "2");
  });

  it("13. persists the high-water mark so a restart does not re-scan", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await listDAOContributions("usr_1", reader(null));
    const state = await DAOReconciliationState.findOne({ externalEOA: USER_ADDRESS });
    assert.equal(state?.nextContributionIdProcessed, "2");
    // One cursor per wallet, so another user's progress cannot be confused with this one's.
    assert.equal(await DAOReconciliationState.countDocuments({}), 1);
  });

  it("14. re-reads activity from chain and never trusts the cached flag", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await listDAOContributions("usr_1", reader(null));
    assert.equal((await DAOContribution.findOne({}))!.lastKnownActive, true);

    // The position is withdrawn on chain; the row still says active until the next read.
    const withdrawn = reader(null, { active: new Map([["1", false]]) });
    const { contributions } = await listDAOContributions("usr_1", withdrawn);
    assert.equal(contributions[0]!.active, false);
    assert.equal((await DAOContribution.findOne({}))!.lastKnownActive, false);
  });
});

describe("audit: the two write paths must agree", () => {
  it("A1. syncing a contribution already discovered by reconciliation must not fail", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();

    // 1. The contribution confirms but the browser closes before /dao/sync runs.
    // 2. The user later opens their history, so reconciliation discovers it from chain.
    await listDAOContributions("usr_1", reader(null));
    assert.equal(await DAOContribution.countDocuments({}), 1);
    const discovered = await DAOContribution.findOne({});
    assert.match(discovered!.eventId, /reconciled/);
    assert.equal(discovered!.executionPriceE18, "0");   // the getter cannot supply it

    // 3. The browser retries the sync with the real transaction hash.
    const r = await recordDAOContribution("usr_1", TX, reader([stakeLog(), daoLog()]));

    assert.equal(r.contributionId, "1");
    assert.equal(await DAOContribution.countDocuments({}), 1);   // still ONE row, not two
    const merged = await DAOContribution.findOne({});
    // The sync carries data reconciliation could not: the real hash, block and execution price.
    assert.equal(merged!.txHash, TX.toLowerCase());
    assert.notEqual(merged!.executionPriceE18, "0");
    assert.equal(merged!.blockNumber, 900);
  });

  it("A2. concurrent membership and history reads share ONE reconciliation pass", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();

    // The Council page requests both at once. Count the EXPENSIVE work: per-id contribution
    // reads. The cursor must make the second pass free, and neither may duplicate a row.
    let idReads = 0;
    const base = reader(null);
    const counting: DAOServiceReader = {
      ...base,
      async daoContribution(id) { idReads += 1; return base.daoContribution(id); },
    };

    const [m, c] = await Promise.all([
      getDAOMembership("usr_1", counting),
      listDAOContributions("usr_1", counting),
    ]);

    assert.equal(idReads, 1, "contribution 1 must be fetched once, not once per endpoint");
    assert.equal(c.contributions.length, 1);
    assert.equal(m.hasActiveDAOPosition, true);
    assert.equal(await DAOContribution.countDocuments({}), 1);   // no racing duplicate
  });

  it("A3. a chain read failure never retires a live position", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await listDAOContributions("usr_1", reader(null));

    const base = reader(null);
    const flaky: DAOServiceReader = {
      ...base,
      async daoContributionActive() { throw new Error("RPC down"); },
    };
    const { contributions } = await listDAOContributions("usr_1", flaky);

    // Unreadable is NOT withdrawn: the position stays active rather than vanishing.
    assert.equal(contributions[0]!.active, true);
    assert.equal((await DAOContribution.findOne({}))!.lastKnownActive, true);
  });
});

describe("getDAOMembership", () => {
  const seed = async (amounts: bigint[], active: boolean[] = []) => {
    await makeUser();
    const map = new Map<string, { beneficiary: string; usdtContributed: bigint; acfStaked: bigint; poolId: bigint; stakeId: bigint; timestamp: bigint }>();
    const activity = new Map<string, boolean>();
    amounts.forEach((amount, i) => {
      const id = String(i + 1);
      map.set(id, { beneficiary: USER_ADDRESS, usdtContributed: amount, acfStaked: ACF_STAKED, poolId: DAO_POOL, stakeId: BigInt(i + 1), timestamp: 1_790_000_000n });
      activity.set(id, active[i] ?? true);
    });
    return reader(null, { contributions: map, active: activity });
  };

  it("15. below the Silver minimum is NONE and not revenue eligible", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const m = await getDAOMembership("usr_1", await seed([SILVER - 1n]));
    assert.equal(m.membershipTier, "NONE");
    assert.equal(m.revenueEligible, false);
  });

  it("16. exactly the Silver minimum is SILVER", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const m = await getDAOMembership("usr_1", await seed([SILVER]));
    assert.equal(m.membershipTier, "SILVER");
    assert.equal(m.revenueEligible, true);
  });

  it("17. one below Gold is still SILVER; exactly Gold is GOLD", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    assert.equal((await getDAOMembership("usr_1", await seed([GOLD - 1n]))).membershipTier, "SILVER");
    await User.deleteMany({}); await DAOContribution.deleteMany({}); await DAOReconciliationState.deleteMany({});
    assert.equal((await getDAOMembership("usr_1", await seed([GOLD]))).membershipTier, "GOLD");
  });

  it("18. sums multiple contributions and excludes withdrawn ones", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // 20,000 active + 10,000 withdrawn -> 20,000 active, still SILVER rather than GOLD.
    const m = await getDAOMembership("usr_1", await seed([20_000n * U, 10_000n * U], [true, false]));
    assert.equal(m.activeContributionUSDT, (20_000n * U).toString());
    assert.equal(m.totalContributionUSDT, (30_000n * U).toString());
    assert.equal(m.membershipTier, "SILVER");
  });

  it("19. an active position below a RAISED Silver minimum keeps governance but loses tier", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const map = new Map([["1", { beneficiary: USER_ADDRESS, usdtContributed: 5_000n * U, acfStaked: ACF_STAKED, poolId: DAO_POOL, stakeId: 1n, timestamp: 1_790_000_000n }]]);
    // Admin later raises Silver to 10,000: the old 5,000 position is still ACTIVE.
    const m = await getDAOMembership("usr_1", reader(null, { contributions: map, silver: 10_000n * U }));
    assert.equal(m.hasActiveDAOPosition, true);
    assert.equal(m.membershipTier, "NONE");
    assert.equal(m.revenueEligible, false);
    assert.equal(m.governanceEligible, true);   // the contract still accepts this vote
  });

  it("20. governance eligibility follows the stake, never the tier", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const withdrawn = await getDAOMembership("usr_1", await seed([GOLD], [false]));
    assert.equal(withdrawn.hasActiveDAOPosition, false);
    assert.equal(withdrawn.governanceEligible, false);
    assert.equal(withdrawn.membershipTier, "NONE");
  });

  it("21. a brand-new user is quoted the SILVER minimum, never Gold's threshold", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    // The bug this guards: entry priced at 25,000 for someone with no position.
    const m = await getDAOMembership("usr_1", reader(null, { contributions: new Map() }));
    assert.equal(m.activeContributionUSDT, "0");
    assert.equal(m.minimumNextContributionUSDT, SILVER.toString());
    assert.equal(m.amountToReachGoldUSDT, GOLD.toString());
    assert.equal(m.distanceToGoldUSDT, GOLD.toString());
  });

  it("22. the minimum stays Silver at every holding, while the Gold target moves", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // 23,000 active: 2,000 from Gold, but 2,000 reverts, so reaching Gold costs 5,000.
    const near = await getDAOMembership("usr_1", await seed([23_000n * U]));
    assert.equal(near.minimumNextContributionUSDT, SILVER.toString());
    assert.equal(near.distanceToGoldUSDT, (2_000n * U).toString());
    assert.equal(near.amountToReachGoldUSDT, SILVER.toString());

    await User.deleteMany({}); await DAOContribution.deleteMany({}); await DAOReconciliationState.deleteMany({});
    const mid = await getDAOMembership("usr_1", await seed([5_000n * U]));
    assert.equal(mid.minimumNextContributionUSDT, SILVER.toString());
    assert.equal(mid.amountToReachGoldUSDT, (20_000n * U).toString());

    await User.deleteMany({}); await DAOContribution.deleteMany({}); await DAOReconciliationState.deleteMany({});
    const gold = await getDAOMembership("usr_1", await seed([GOLD]));
    assert.equal(gold.minimumNextContributionUSDT, SILVER.toString());
    assert.equal(gold.amountToReachGoldUSDT, "0");
  });

  it("22b. two 5,000 positions: Silver by tier, 10,000 by revenue weight", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const m = await getDAOMembership("usr_1", await seed([SILVER, SILVER]));
    // Tier is a LABEL from the thresholds; the revenue weight is the full active amount.
    assert.equal(m.membershipTier, "SILVER");                       // 10,000 < 25,000 Gold
    assert.equal(m.activeContributionUSDT, (10_000n * U).toString()); // weight, not 5,000
    assert.equal(m.revenueEligible, true);
    assert.equal(m.governanceEligible, true);
    assert.equal(m.distanceToGoldUSDT, (15_000n * U).toString());
  });

  it("22c. withdrawing ONE of two positions keeps membership; withdrawing both ends it", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");

    // Both positions live.
    const both = await getDAOMembership("usr_1", await seed([SILVER, SILVER], [true, true]));
    assert.equal(both.activeContributionUSDT, (10_000n * U).toString());
    assert.equal(both.membershipTier, "SILVER");
    assert.equal(both.governanceEligible, true);

    await User.deleteMany({}); await DAOContribution.deleteMany({}); await DAOReconciliationState.deleteMany({});

    // First position withdrawn at maturity; the second is untouched.
    const one = await getDAOMembership("usr_1", await seed([SILVER, SILVER], [false, true]));
    assert.equal(one.hasActiveDAOPosition, true);
    assert.equal(one.activeContributionUSDT, SILVER.toString());    // weight halves
    assert.equal(one.totalContributionUSDT, (10_000n * U).toString()); // history is kept
    assert.equal(one.membershipTier, "SILVER");                     // still exactly at Silver
    assert.equal(one.revenueEligible, true);
    assert.equal(one.governanceEligible, true);                     // can still vote

    await User.deleteMany({}); await DAOContribution.deleteMany({}); await DAOReconciliationState.deleteMany({});

    // Both withdrawn: membership ends.
    const none = await getDAOMembership("usr_1", await seed([SILVER, SILVER], [false, false]));
    assert.equal(none.hasActiveDAOPosition, false);
    assert.equal(none.activeContributionUSDT, "0");
    assert.equal(none.membershipTier, "NONE");
    assert.equal(none.revenueEligible, false);
    assert.equal(none.governanceEligible, false);                   // cannot vote again
    assert.equal(none.totalContributionUSDT, (10_000n * U).toString()); // but history remains
  });

  it("22d. with a steady threshold, withdrawal alone can never strip the tier", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Every contribution is >= the Silver minimum when made, so ANY surviving one keeps the
    // active sum >= Silver. Tier-NONE-with-a-live-position is therefore unreachable by
    // withdrawal; it requires the admin to RAISE the threshold.
    for (const surviving of [[true, false], [false, true], [true, true]] as const) {
      await User.deleteMany({}); await DAOContribution.deleteMany({}); await DAOReconciliationState.deleteMany({});
      const m = await getDAOMembership("usr_1", await seed([SILVER, 20_000n * U], [...surviving]));
      assert.equal(m.hasActiveDAOPosition, true);
      assert.notEqual(m.membershipTier, "NONE", `surviving=${surviving}`);
      assert.equal(m.revenueEligible, true);
      assert.equal(m.governanceEligible, true);
    }
  });

  it("23. serves the fixed DAO policy, not pool ROI, plus live config", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const m = await getDAOMembership("usr_1", await seed([SILVER]));
    assert.equal(m.daoDailyRewardPercentage, 1);      // NOT pool 6's 0.5%
    assert.equal(m.daoEpochRewardPercentage, 0.5);
    assert.equal(m.daoDailyRewardPercentage, daoRewardPolicy.daoDailyRewardPercentage);
    assert.equal(m.daoLockDurationSeconds, LOCK.toString());
    assert.equal(m.daoPoolId, Number(DAO_POOL));
    assert.equal(m.memberRevenuePercentage, "50000");
  });

  it("24. reports DAO closure without hiding the member's position", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const map = new Map([["1", { beneficiary: USER_ADDRESS, usdtContributed: GOLD, acfStaked: ACF_STAKED, poolId: DAO_POOL, stakeId: 1n, timestamp: 1_790_000_000n }]]);
    const m = await getDAOMembership("usr_1", reader(null, { contributions: map, closed: true }));
    assert.equal(m.daoClosed, true);
    assert.equal(m.membershipTier, "GOLD");
    assert.equal(m.governanceEligible, true);
  });
});
