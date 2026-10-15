import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { encodeAbiParameters, keccak256, toHex, pad } from "viem";
import type { BondReceiptReader } from "./service.ts";

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
process.env.MOCK_USDT_ADDRESS ??= "0x21ff9e803fc496e4db1c1a6c354690636b9fc330";
process.env.SWAP_CONFIRMATIONS ??= "1";

const { recordBondPurchase, listBondPurchases } = await import("./service.js");
const { BondPurchase } = await import("../models/BondPurchase.js");
const { Stake } = await import("../models/Stake.js");
const { User } = await import("../models/User.js");
const { HttpError } = await import("../lib/errors.js");

const BOND = "0x3a97d05a088adbb79936914f245c2e0bf7f511f2";
const STAKING = "0x9edbbf53f784450cc8fd50730984cb7d8ddf743d";
const OTHER = "0x1111111111111111111111111111111111111111";
const USER_ADDRESS = "0x7c2d6b5f65c820c1cb014313ab17419420d3e3a7";
const STRANGER = "0x2222222222222222222222222222222222222222";
const TX = "0x" + "ab".repeat(32);

const BOND_T0 = keccak256(toHex("BondPurchased(uint256,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"));
const STAKE_T0 = keccak256(toHex("StakeCreated(address,uint256,uint256,uint256,uint256,uint256,uint256,uint8)"));

const ACF_STAKED = 69_091_932_000_000_000_000n; // 18dp
const USDT_PAID = 100_000_000n;                  // 6dp

function bondLog(o: {
  address?: string; beneficiary?: string; purchaseId?: bigint; offerId?: bigint;
  poolId?: bigint; stakeId?: bigint; usdtPaid?: bigint; acfStaked?: bigint; logIndex?: number;
} = {}) {
  const { address = BOND, beneficiary = USER_ADDRESS, purchaseId = 2n, offerId = 1n, poolId = 1n,
          stakeId = 7n, usdtPaid = USDT_PAID, acfStaked = ACF_STAKED, logIndex = 5 } = o;
  return {
    address,
    topics: [BOND_T0, pad(toHex(purchaseId), { size: 32 }),
             pad(beneficiary as `0x${string}`, { size: 32 }), pad(toHex(offerId), { size: 32 })],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [poolId, stakeId, usdtPaid, 50_000n, 1_523_523_160_000_000_000n, acfStaked],
    ),
    logIndex,
  };
}

function stakeLog(o: {
  address?: string; user?: string; stakeId?: bigint; poolId?: bigint;
  principal?: bigint; source?: 0 | 1 | 2; logIndex?: number;
} = {}) {
  const { address = STAKING, user = USER_ADDRESS, stakeId = 7n, poolId = 1n,
          principal = ACF_STAKED, source = 1, logIndex = 3 } = o;
  return {
    address,
    topics: [STAKE_T0, pad(user as `0x${string}`, { size: 32 }),
             pad(toHex(stakeId), { size: 32 }), pad(toHex(poolId), { size: 32 })],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint8" }],
      [principal, 2_500n, 1_790_000_000n, 1_790_000_000n, source],
    ),
    logIndex,
  };
}

function reader(
  logs: ReturnType<typeof bondLog | typeof stakeLog>[] | null,
  // Typed as the real union, not inferred from the default: `as const` alone narrowed this
  // to "success" and made a reverted-receipt case a compile error.
  { status = "success", block = 900n, head = 1_000n }:
    { status?: "success" | "reverted"; block?: bigint; head?: bigint } = {},
): BondReceiptReader {
  return {
    async receiptOf() { return logs === null ? null : { status, blockNumber: block, logs }; },
    async headBlock() { return head; },
    async blockTimestamp() { return 1_790_000_000n; },
  };
}

const codeIs = (c: string) => (e: unknown) => e instanceof HttpError && e.code === c;

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set — bond tests skipped"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([User.init(), Stake.init(), BondPurchase.init()]);
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (connected) await Promise.all([User.deleteMany({}), Stake.deleteMany({}), BondPurchase.deleteMany({})]);
});

const makeUser = () =>
  User.create({ userId: "usr_1", externalEOA: USER_ADDRESS, referralCode: "ACF-AAAAAAAA" });

describe("recordBondPurchase", () => {
  it("1. decodes a valid BondPurchased and persists BOTH records", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const r = await recordBondPurchase("usr_1", TX, reader([stakeLog(), bondLog()]));
    assert.equal(r.purchaseId, "2");
    assert.equal(r.linkedStakeId, "7");
    assert.equal(r.discountUsed, "50000");            // 5% against 1e6
    assert.equal(await BondPurchase.countDocuments({}), 1);
    assert.equal(await Stake.countDocuments({ source: "BOND" }), 1);
    assert.equal(r.stake?.active, true);
  });

  it("2. rejects a BondPurchased from the wrong contract", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordBondPurchase("usr_1", TX, reader([stakeLog(), bondLog({ address: OTHER })])),
      codeIs("NO_BOND_FOR_WALLET"),
    );
    assert.equal(await BondPurchase.countDocuments({}), 0);
    assert.equal(await Stake.countDocuments({}), 0);
  });

  it("3 & 16. rejects a purchase whose beneficiary is another wallet", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordBondPurchase("usr_1", TX, reader([stakeLog(), bondLog({ beneficiary: STRANGER })])),
      codeIs("NO_BOND_FOR_WALLET"),
    );
  });

  it("4. requires a matching StakeCreated", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(recordBondPurchase("usr_1", TX, reader([bondLog()])), codeIs("NO_LINKED_STAKE"));
    assert.equal(await BondPurchase.countDocuments({}), 0);
  });

  it("5. rejects a linked stake whose source is not BOND", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    for (const source of [0, 2] as const) {
      await assert.rejects(
        recordBondPurchase("usr_1", TX, reader([stakeLog({ source }), bondLog()])),
        codeIs("NOT_BOND_STAKE"),
      );
    }
    assert.equal(await Stake.countDocuments({}), 0);
  });

  it("6. requires stakeId to match BondPurchased.stakeId", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    // An unrelated BOND stake in the same transaction must not be stitched in.
    await assert.rejects(
      recordBondPurchase("usr_1", TX, reader([stakeLog({ stakeId: 99n }), bondLog({ stakeId: 7n })])),
      codeIs("NO_LINKED_STAKE"),
    );
  });

  it("7. rejects a pool mismatch between the two events", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordBondPurchase("usr_1", TX, reader([stakeLog({ poolId: 4n }), bondLog({ poolId: 1n })])),
      codeIs("POOL_MISMATCH"),
    );
  });

  it("8. rejects a principal mismatch between the two events", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordBondPurchase("usr_1", TX, reader([stakeLog({ principal: 1n }), bondLog({ acfStaked: ACF_STAKED })])),
      codeIs("PRINCIPAL_MISMATCH"),
    );
  });

  it("9. repeated sync is idempotent for both records", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const a = await recordBondPurchase("usr_1", TX, reader([stakeLog(), bondLog()]));
    const b = await recordBondPurchase("usr_1", TX, reader([stakeLog(), bondLog()]));
    assert.equal(a.purchaseId, b.purchaseId);
    assert.equal(await BondPurchase.countDocuments({}), 1);
    assert.equal(await Stake.countDocuments({}), 1);
  });

  it("10. a retry repairs a Stake written without its BondPurchase", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    // Simulate the first attempt having persisted only the stake.
    await recordBondPurchase("usr_1", TX, reader([stakeLog(), bondLog()]));
    await BondPurchase.deleteMany({});
    assert.equal(await Stake.countDocuments({}), 1);

    const repaired = await recordBondPurchase("usr_1", TX, reader([stakeLog(), bondLog()]));
    assert.equal(repaired.purchaseId, "2");
    assert.equal(await BondPurchase.countDocuments({}), 1);
    assert.equal(await Stake.countDocuments({}), 1, "the stake must not be duplicated");
  });

  it("11 & 12. 6-decimal USDT and 18-decimal ACF stay lossless", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const bigAcf = 123_456_789_012_345_678_901n; // > 2^53
    const r = await recordBondPurchase("usr_1", TX,
      reader([stakeLog({ principal: bigAcf }), bondLog({ acfStaked: bigAcf, usdtPaid: 999_999_999n })]));
    assert.equal(r.acfStaked, bigAcf.toString());
    assert.equal(BigInt(r.acfStaked), bigAcf);
    assert.equal(r.usdtPaid, "999999999");
  });

  it("13. rejects a reverted transaction", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordBondPurchase("usr_1", TX, reader([stakeLog(), bondLog()], { status: "reverted" })),
      codeIs("TX_REVERTED"),
    );
  });

  it("14. rejects an unknown transaction", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(recordBondPurchase("usr_1", TX, reader(null)), codeIs("TX_NOT_FOUND"));
  });

  it("15. a head-block purchase counts as one confirmation", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const r = await recordBondPurchase("usr_1", TX,
      reader([stakeLog(), bondLog()], { block: 900n, head: 900n }));
    assert.equal(r.purchaseId, "2");
  });
});

describe("listBondPurchases", () => {
  it("totals principal only — no reward figures exist yet", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await recordBondPurchase("usr_1", TX, reader([stakeLog(), bondLog()]));
    const { purchases, totals } = await listBondPurchases("usr_1");
    assert.equal(purchases.length, 1);
    assert.equal(totals.totalUsdtPaid, USDT_PAID.toString());
    assert.equal(totals.totalAcfStaked, ACF_STAKED.toString());
    assert.equal(totals.purchaseCount, 1);
    assert.ok(!("rewards" in totals) && !("earnings" in totals));
  });

  it("an empty history totals a truthful zero", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const { totals } = await listBondPurchases("usr_1");
    assert.equal(totals.totalUsdtPaid, "0");
    assert.equal(totals.purchaseCount, 0);
  });
});
