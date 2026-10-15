import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { encodeAbiParameters, keccak256, toHex, pad } from "viem";
import type { SwapReader, SwapReceipt } from "../lib/chain.ts";

const TEST_URI = process.env.MONGODB_TEST_URI;

function assertDisposable(uri: string): string {
  const name = new URL(uri).pathname.replace(/^\//, "");
  if (!name || !/test/i.test(name)) {
    throw new Error(
      `MONGODB_TEST_URI must point at a database whose name contains "test" (got "${name || "<none>"}"). ` +
        "These tests delete all documents in it.",
    );
  }
  return uri;
}

process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/unused-by-tests";
process.env.PORT ??= "3001";
process.env.DAO_REVENUE_DISTRIBUTOR_ADDRESS ??= "0xc152dF6448FB68702B661C4aE210E41f5E76931E";
process.env.WITHDRAWAL_ADDRESS ??= "0x882db912586869315C2720dE72224d79B9D99Ea1";
process.env.TREASURY_ADDRESS ??= "0x114fe8e3414bc49A24C6efd9E702cD66B9A80251";
process.env.JWT_SECRET ??= "test-secret-at-least-thirty-two-characters-long";
process.env.REGISTERED_EOA_DIRECT_RULE_START_EPOCH ??= "1";
process.env.JWT_EXPIRES_IN_SECONDS ??= "86400";
process.env.CHAIN_ID ??= "80002";
process.env.CHALLENGE_TTL_SECONDS ??= "300";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ACF_SWAP_ADDRESS ??= "0x16F2d748A5a4359d1948F261662dD9f0d5fEadDD";
process.env.SWAP_CONFIRMATIONS ??= "1";

const { recordSwap, listSwaps } = await import("./service.js");
const { Swap } = await import("../models/Swap.js");
const { User } = await import("../models/User.js");
const { HttpError } = await import("../lib/errors.js");

const SWAP_ADDR = "0x16f2d748a5a4359d1948f261662dd9f0d5feaddd";
const OTHER_CONTRACT = "0x1111111111111111111111111111111111111111";
const USER_ADDRESS = "0x7c2d6b5f65c820c1cb014313ab17419420d3e3a7";
const STRANGER_WALLET = "0x2222222222222222222222222222222222222222";
const TX = "0x" + "ab".repeat(32);

const TOPIC0 = keccak256(toHex("SwapExecuted(address,uint8,uint256,uint256,uint256,uint256,uint256)"));

/** Builds a SwapExecuted log exactly as the contract emits it. */
function swapLog(opts: {
  address?: string; user?: string; direction?: 0 | 1;
  acf?: bigint; gross?: bigint; fee?: bigint; logIndex?: number;
}) {
  const { address = SWAP_ADDR, user = USER_ADDRESS, direction = 0,
          acf = 91_215_015_000_000_000_000n, gross = 100_000_000n, fee = 0n, logIndex = 3 } = opts;
  return {
    address,
    topics: [TOPIC0, pad(user as `0x${string}`, { size: 32 }), pad(toHex(direction), { size: 32 })],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [acf, gross, fee, 0n, 0n],
    ),
    logIndex,
  };
}

function reader(receipt: SwapReceipt | null, head = 1_000n): SwapReader {
  return {
    async receiptOf() { return receipt; },
    async headBlock() { return head; },
    async blockTimestamp() { return 1_790_000_000n; },
  };
}

const ok = (logs: ReturnType<typeof swapLog>[], blockNumber = 900n): SwapReceipt =>
  ({ status: "success", blockNumber, logs });

const codeIs = (code: string) => (e: unknown) => e instanceof HttpError && e.code === code;

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set — swap integration tests skipped"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([User.init(), Swap.init()]);
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (connected) await Promise.all([User.deleteMany({}), Swap.deleteMany({})]);
});

const makeUser = () =>
  User.create({ userId: "usr_1", externalEOA: USER_ADDRESS, referralCode: "ACF-AAAAAAAA" });

describe("recordSwap", () => {
  it("records a BUY decoded from the receipt", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const r = await recordSwap("usr_1", TX, reader(ok([swapLog({})])));
    assert.equal(r.direction, "BUY");
    assert.equal(r.acfAmount, "91215015000000000000");
    assert.equal(r.grossUSDT, "100000000");
    assert.equal(r.sellFeeUSDT, "0");
    assert.equal(r.netUSDT, "100000000");          // BUY: net == gross, no protocol fee
    assert.equal(r.eventId, `80002:${TX}:3`);
  });

  it("records a SELL with net = gross - fee", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const r = await recordSwap("usr_1", TX,
      reader(ok([swapLog({ direction: 1, gross: 19_773_539n, fee: 988_676n })])));
    assert.equal(r.direction, "SELL");
    assert.equal(r.netUSDT, (19_773_539n - 988_676n).toString());
  });

  it("stores amounts beyond Number.MAX_SAFE_INTEGER without loss", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const huge = 123_456_789_012_345_678_901n; // > 2^53
    const r = await recordSwap("usr_1", TX, reader(ok([swapLog({ acf: huge })])));
    assert.equal(r.acfAmount, huge.toString());
    assert.equal(BigInt(r.acfAmount), huge);
  });

  it("REJECTS a swap belonging to another address", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordSwap("usr_1", TX, reader(ok([swapLog({ user: STRANGER_WALLET })]))),
      codeIs("NO_SWAP_FOR_WALLET"),
    );
    assert.equal(await Swap.countDocuments({}), 0);
  });

  it("REJECTS a matching event emitted by a different contract", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordSwap("usr_1", TX, reader(ok([swapLog({ address: OTHER_CONTRACT })]))),
      codeIs("NO_SWAP_FOR_WALLET"),
    );
  });

  it("is idempotent — replaying the same hash creates one row", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const a = await recordSwap("usr_1", TX, reader(ok([swapLog({})])));
    const b = await recordSwap("usr_1", TX, reader(ok([swapLog({})])));
    assert.equal(a.eventId, b.eventId);
    assert.equal(await Swap.countDocuments({}), 1);
  });

  it("rejects a reverted transaction", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordSwap("usr_1", TX, reader({ status: "reverted", blockNumber: 900n, logs: [swapLog({})] })),
      codeIs("TX_REVERTED"),
    );
  });

  it("rejects an unknown hash", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(recordSwap("usr_1", TX, reader(null)), codeIs("TX_NOT_FOUND"));
  });

  it("records a swap in the HEAD block — inclusion counts as one confirmation", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    // The exact situation the client is in: the receipt has just arrived, so head == block.
    // The earlier formula returned 0 here and rejected every real swap.
    const r = await recordSwap("usr_1", TX, reader(ok([swapLog({})], 900n), 900n));
    assert.equal(r.direction, "BUY");
    assert.equal(await Swap.countDocuments({}), 1);
  });

  it("rejects a malformed hash before touching the chain", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    for (const bad of ["", "0x123", "not-a-hash", 42, null])
      await assert.rejects(recordSwap("usr_1", bad, reader(ok([swapLog({})]))), codeIs("INVALID_TX_HASH"));
  });

  it("records a trade for a freshly registered user, with no onboarding step between", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Registration is the whole of onboarding: nothing was created on this user's behalf
    // between authenticating and trading, and the trade is theirs on the strength of the
    // address alone.
    await User.create({ userId: "usr_2", externalEOA: STRANGER_WALLET, referralCode: "ACF-BBBBBBBB" });
    const r = await recordSwap("usr_2", TX, reader(ok([swapLog({ user: STRANGER_WALLET })])));
    assert.equal(r.direction, "BUY");
    assert.equal(r.eventId, `80002:${TX}:3`);
  });
});

describe("listSwaps", () => {
  it("aggregates buy/sell volume and fees as bigint strings", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await recordSwap("usr_1", TX, reader(ok([swapLog({ logIndex: 1 })])));
    await recordSwap("usr_1", "0x" + "cd".repeat(32),
      reader(ok([swapLog({ direction: 1, gross: 19_773_539n, fee: 988_676n, logIndex: 2 })])));

    const { swaps, volume } = await listSwaps("usr_1");
    assert.equal(swaps.length, 2);
    assert.equal(volume.buyUSDT, "100000000");
    assert.equal(volume.sellGrossUSDT, "19773539");
    assert.equal(volume.feesPaidUSDT, "988676");
    assert.equal(volume.count, 2);
  });
});
