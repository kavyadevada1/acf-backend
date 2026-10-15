import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { encodeAbiParameters, keccak256, toHex, pad } from "viem";
import type { StakingReceiptReader } from "./service.ts";

const TEST_URI = process.env.MONGODB_TEST_URI;
function assertDisposable(uri: string): string {
  const name = new URL(uri).pathname.replace(/^\//, "");
  if (!name || !/test/i.test(name)) {
    throw new Error(
      `MONGODB_TEST_URI must point at a database whose name contains "test" (got "${name || "<none>"}").`,
    );
  }
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
process.env.SWAP_CONFIRMATIONS ??= "1";

const { recordStake, listStakes } = await import("./service.js");
const { Stake } = await import("../models/Stake.js");
const { User } = await import("../models/User.js");
const { HttpError } = await import("../lib/errors.js");

const STAKING = "0x9edbbf53f784450cc8fd50730984cb7d8ddf743d";
const STALE_STAKING = "0x10d4f084d9d1eb6e7b6be2d8cf2e5c371cf385d3";
const USER_ADDRESS = "0x7c2d6b5f65c820c1cb014313ab17419420d3e3a7";
const STRANGER = "0x2222222222222222222222222222222222222222";
const TX = "0x" + "ab".repeat(32);

const TOPIC0 = keccak256(toHex("StakeCreated(address,uint256,uint256,uint256,uint256,uint256,uint256,uint8)"));

function stakeLog(o: {
  address?: string; user?: string; stakeId?: bigint; poolId?: bigint;
  principal?: bigint; roi?: bigint; source?: 0 | 1 | 2; logIndex?: number;
  stakeTs?: bigint; unlockTs?: bigint;
}) {
  const { address = STAKING, user = USER_ADDRESS, stakeId = 4n, poolId = 2n,
          principal = 100_000_000_000_000_000_000n, roi = 2_500n, source = 0,
          logIndex = 2, stakeTs = 1_790_000_000n, unlockTs = 1_793_888_000n } = o;
  return {
    address,
    topics: [TOPIC0, pad(user as `0x${string}`, { size: 32 }),
             pad(toHex(stakeId), { size: 32 }), pad(toHex(poolId), { size: 32 })],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint8" }],
      [principal, roi, stakeTs, unlockTs, source],
    ),
    logIndex,
  };
}

function reader(
  logs: ReturnType<typeof stakeLog>[] | null,
  // Typed as the real union, not inferred from the default: `as const` alone narrowed this
  // to "success" and made a reverted-receipt case a compile error.
  { status = "success", block = 900n, head = 1_000n }:
    { status?: "success" | "reverted"; block?: bigint; head?: bigint } = {},
): StakingReceiptReader {
  return {
    async receiptOf() { return logs === null ? null : { status, blockNumber: block, logs }; },
    async headBlock() { return head; },
    async blockTimestamp() { return 1_790_000_000n; },
  };
}

const codeIs = (code: string) => (e: unknown) => e instanceof HttpError && e.code === code;

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set — staking tests skipped"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([User.init(), Stake.init()]);
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => { if (connected) await Promise.all([User.deleteMany({}), Stake.deleteMany({})]); });

const makeUser = () =>
  User.create({ userId: "usr_1", externalEOA: USER_ADDRESS, referralCode: "ACF-AAAAAAAA" });

describe("recordStake", () => {
  it("1. decodes a valid StakeCreated", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const r = await recordStake("usr_1", TX, reader([stakeLog({})]));
    assert.equal(r.stakeId, "4");
    assert.equal(r.poolId, 2);
    assert.equal(r.source, "DIRECT");
    assert.equal(r.active, true);
    assert.equal(r.poolDailyROIAtCreation, "2500");
  });

  it("2. rejects an event from the WRONG staking contract (the stale Amoy proxy)", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordStake("usr_1", TX, reader([stakeLog({ address: STALE_STAKING })])),
      codeIs("NO_STAKE_FOR_WALLET"),
    );
    assert.equal(await Stake.countDocuments({}), 0);
  });

  it("3. rejects a stake belonging to another SmartWallet", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordStake("usr_1", TX, reader([stakeLog({ user: STRANGER })])),
      codeIs("NO_STAKE_FOR_WALLET"),
    );
  });

  it("4. rejects BOND and DAO sources on the direct path", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    for (const source of [1, 2] as const) {
      await assert.rejects(
        recordStake("usr_1", TX, reader([stakeLog({ source })])),
        codeIs("NOT_DIRECT_STAKE"),
      );
    }
    assert.equal(await Stake.countDocuments({}), 0);
  });

  it("5. is idempotent for the same event", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const a = await recordStake("usr_1", TX, reader([stakeLog({})]));
    const b = await recordStake("usr_1", TX, reader([stakeLog({})]));
    assert.equal(a.stakeId, b.stakeId);
    assert.equal(await Stake.countDocuments({}), 1);
  });

  it("6. the same stakeId on a different deployment does not collide", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await recordStake("usr_1", TX, reader([stakeLog({ stakeId: 4n })]));
    // Identity is {chainId, stakingContractAddress, stakeId} — not stakeId alone.
    await Stake.create({
      eventId: "1:0xdead:0", chainId: 1, stakingContractAddress: STALE_STAKING,
      stakeId: "4", userId: "usr_1", externalEOA: USER_ADDRESS, poolId: 2,
      principalACF: "1", source: "DIRECT", poolDailyROIAtCreation: "0",
      stakeTimestamp: new Date(), unlockTimestamp: new Date(), active: true,
      txHash: "0x" + "cd".repeat(32), blockNumber: 1, logIndex: 0,
    });
    assert.equal(await Stake.countDocuments({ stakeId: "4" }), 2);
  });

  it("7. an 18-decimal principal stays lossless as a string", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    const huge = 123_456_789_012_345_678_901n; // > 2^53
    const r = await recordStake("usr_1", TX, reader([stakeLog({ principal: huge })]));
    assert.equal(r.principalACF, huge.toString());
    assert.equal(BigInt(r.principalACF), huge);
  });

  it("8. source 0 maps to DIRECT", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    assert.equal((await recordStake("usr_1", TX, reader([stakeLog({ source: 0 })]))).source, "DIRECT");
  });

  it("9. rejects a reverted transaction", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(
      recordStake("usr_1", TX, reader([stakeLog({})], { status: "reverted" })),
      codeIs("TX_REVERTED"),
    );
  });

  it("10. rejects an unknown transaction", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await assert.rejects(recordStake("usr_1", TX, reader(null)), codeIs("TX_NOT_FOUND"));
  });

  it("11. a head-block stake counts as one confirmation (no off-by-one)", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    // head == block: exactly the moment the client's receipt arrives.
    const r = await recordStake("usr_1", TX, reader([stakeLog({})], { block: 900n, head: 900n }));
    assert.equal(r.stakeId, "4");
  });

  it("rejects a malformed hash before touching the chain", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    for (const bad of ["", "0x1", 7, null])
      await assert.rejects(recordStake("usr_1", bad, reader([stakeLog({})])), codeIs("INVALID_TX_HASH"));
  });
});

describe("listStakes", () => {
  it("totals principal only — never a fabricated reward", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    await recordStake("usr_1", TX, reader([stakeLog({ stakeId: 4n, principal: 100n, logIndex: 1 })]));
    await recordStake("usr_1", "0x" + "cd".repeat(32),
      reader([stakeLog({ stakeId: 5n, principal: 250n, logIndex: 2 })]));

    const { stakes, totals } = await listStakes("usr_1");
    assert.equal(stakes.length, 2);
    assert.equal(totals.activePrincipalACF, "350");
    assert.equal(totals.withdrawnPrincipalACF, "0");
    assert.equal(totals.activeCount, 2);
    assert.ok(!("rewards" in totals), "no reward field may exist yet");
  });

  it("a MATURED stake is still active — maturity is not completion", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeUser();
    // unlockTimestamp in the past, but never withdrawn.
    await recordStake("usr_1", TX, reader([stakeLog({ unlockTs: 1_000n })]));
    const { stakes, totals } = await listStakes("usr_1");
    assert.equal(stakes[0]!.active, true);
    assert.equal(totals.activeCount, 1);
  });
});
