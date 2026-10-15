import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { privateKeyToAccount } from "viem/accounts";

process.env.PORT ??= "3001";
process.env.DAO_REVENUE_DISTRIBUTOR_ADDRESS ??= "0xc152dF6448FB68702B661C4aE210E41f5E76931E";
process.env.WITHDRAWAL_ADDRESS ??= "0x882db912586869315C2720dE72224d79B9D99Ea1";
process.env.TREASURY_ADDRESS ??= "0x114fe8e3414bc49A24C6efd9E702cD66B9A80251";
/**
 * Integration tests connect ONLY to MONGODB_TEST_URI, never to MONGODB_URI. They call
 * deleteMany({}) between cases, so running them against the development or production
 * database would erase it. Unset => these tests skip.
 */
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

// Only to satisfy config validation when a module imports config.ts; never connected to.
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/unused-by-tests";
process.env.JWT_SECRET ??= "test-secret-at-least-thirty-two-characters-long";
process.env.REGISTERED_EOA_DIRECT_RULE_START_EPOCH ??= "1";
process.env.JWT_EXPIRES_IN_SECONDS ??= "86400";
process.env.CHAIN_ID ??= "80002";
process.env.CHALLENGE_TTL_SECONDS ??= "300";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
process.env.ACF_DAO_ADDRESS ??= "0x9cf32271E052Cbbc1D6C564B6fE6a86B6ED08E45";

const { createChallenge, verifyAndAuthenticate: authenticateWith } = await import("./service.js");
const { User } = await import("../models/User.js");
const { AuthChallenge } = await import("../models/AuthChallenge.js");
const { HttpError } = await import("../lib/errors.js");

// Well-known Hardhat test keys. Never used for anything holding value.
const ALICE = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const BOB = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

let connected = false;

before(async () => {
  if (!TEST_URI) {
    console.log("SKIP: MONGODB_TEST_URI not set — auth service integration tests skipped");
    return;
  }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([User.init(), AuthChallenge.init()]);
  connected = true;
});

after(async () => {
  if (connected) await mongoose.disconnect();
});

const ROOT_ID = "usr_root_fixture";
const ROOT_EOA = "0x9999999999999999999999999999999999999999";

/**
 * ROOT is constructed explicitly rather than through registration. What makes it the root is its
 * TREE POSITION — `referredByUserId: null` — not its address: the wallet a root answers to is
 * whatever `ACFWithdrawal.currentRootEOA()` says and can rotate, while the node never moves.
 */
const makeRoot = () =>
  User.create({
    userId: ROOT_ID,
    externalEOA: ROOT_EOA,
    referralCode: "ACF-ROOTROOT",
    referredByUserId: null,
  });

beforeEach(async () => {
  if (connected) {
    await Promise.all([User.deleteMany({}), AuthChallenge.deleteMany({})]);
    await makeRoot();
  }
});

/** Requests a challenge and signs it, returning the arguments /auth/verify would receive. */
async function challengeAndSign(account: typeof ALICE) {
  const { message } = await createChallenge(account.address);
  const signature = await account.signMessage({ message });
  return { externalEOA: account.address, signature };
}

const codeIs = (code: string) => (error: unknown) =>
  error instanceof HttpError && error.code === code;

/**
 * Every case in this file models a SETTLED chain: the contract's ROOT is the wallet the fixture
 * seeded as the referral root, and nobody else has ever been ROOT.
 *
 * Injected rather than left to the real reader, because registration asks the contract whether an
 * unknown wallet is a reserved historical ROOT and fails closed when it cannot find out. A test
 * run has no RPC, so without this every registration here would correctly refuse — the fixture has
 * to state the world it means, exactly as it states the seeded tree.
 */
const SETTLED_CHAIN = {
  async currentRootEOA() { return ROOT_EOA.toLowerCase(); },
  async isRootRewardAccount(address: string) { return address.toLowerCase() === ROOT_EOA.toLowerCase(); },
  async alreadyClaimed(wallets: string[]) { return new Map(wallets.map((w) => [w.toLowerCase(), 0n])); },
} as unknown as import("../settlement/chain.js").SettlementChainReader;

const verifyAndAuthenticate = (input: Parameters<typeof authenticateWith>[0]) =>
  authenticateWith(input, SETTLED_CHAIN);

describe("verifyAndAuthenticate", () => {
  it("1. new user with no referral attaches to ROOT, never to null", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const result = await verifyAndAuthenticate(await challengeAndSign(ALICE));
    assert.equal(result.isNewUser, true);
    // The old behaviour stored null here, which now means "I am ROOT" and would fork the tree.
    assert.equal(result.user.referredByUserId, ROOT_ID);
    assert.equal(result.user.externalEOA, ALICE.address.toLowerCase());
    assert.ok(result.user.referralCode.startsWith("ACF-"));
    assert.ok(result.token.length > 0);
  });

  it("2. new user with a valid referral has the relationship set", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const referrer = await verifyAndAuthenticate(await challengeAndSign(ALICE));

    const invited = await verifyAndAuthenticate({
      ...(await challengeAndSign(BOB)),
      referralCode: referrer.user.referralCode,
    });

    assert.equal(invited.isNewUser, true);
    assert.equal(invited.user.referredByUserId, referrer.user.userId);
    assert.notEqual(invited.user.referralCode, referrer.user.referralCode);
  });

  it("3. an invalid referral code rejects registration and creates no user", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await assert.rejects(
      verifyAndAuthenticate({ ...(await challengeAndSign(ALICE)), referralCode: "ACF-NOTREAL1" }),
      codeIs("UNKNOWN_REFERRAL_CODE"),
    );
    assert.equal(await User.countDocuments({ userId: { $ne: ROOT_ID } }), 0);
  });

  it("4. an existing user logging in through ANOTHER referral keeps their original referrer", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const root = await verifyAndAuthenticate(await challengeAndSign(ALICE));
    const invited = await verifyAndAuthenticate({
      ...(await challengeAndSign(BOB)),
      referralCode: root.user.referralCode,
    });
    assert.equal(invited.user.referredByUserId, root.user.userId);

    // BOB returns through a different valid link — the referrer must not change.
    const again = await verifyAndAuthenticate({
      ...(await challengeAndSign(BOB)),
      referralCode: invited.user.referralCode, // a different, valid code
    });

    assert.equal(again.isNewUser, false);
    assert.equal(again.user.referredByUserId, root.user.userId);
    assert.equal(again.user.userId, invited.user.userId);
  });

  it("5. an existing user with an INVALID referral code still logs in", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const first = await verifyAndAuthenticate(await challengeAndSign(ALICE));

    // The code is never resolved for an existing user, so a bad one cannot block login.
    const second = await verifyAndAuthenticate({
      ...(await challengeAndSign(ALICE)),
      referralCode: "ACF-NOTREAL1",
    });

    assert.equal(second.isNewUser, false);
    assert.equal(second.user.userId, first.user.userId);
    // Alice registered without a code, so her parent is ROOT — and a later bad code cannot move her.
    assert.equal(second.user.referredByUserId, ROOT_ID);
  });

  it("6. a wrong signature does NOT consume the challenge", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { message } = await createChallenge(ALICE.address);
    const wrongSignature = await BOB.signMessage({ message }); // signed by the wrong key

    await assert.rejects(
      verifyAndAuthenticate({ externalEOA: ALICE.address, signature: wrongSignature }),
      codeIs("SIGNATURE_MISMATCH"),
    );

    // Still pending, so the legitimate holder can complete sign-in with the same message.
    assert.equal(await AuthChallenge.countDocuments({ externalEOA: ALICE.address.toLowerCase() }), 1);
    const recovered = await verifyAndAuthenticate({
      externalEOA: ALICE.address,
      signature: await ALICE.signMessage({ message }),
    });
    assert.equal(recovered.isNewUser, true);
  });

  it("7. a valid signature consumes the challenge", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await verifyAndAuthenticate(await challengeAndSign(ALICE));
    assert.equal(await AuthChallenge.countDocuments({ externalEOA: ALICE.address.toLowerCase() }), 0);
  });

  it("8. reusing a consumed challenge is rejected", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { message } = await createChallenge(ALICE.address);
    const signature = await ALICE.signMessage({ message });
    const input = { externalEOA: ALICE.address, signature };

    await verifyAndAuthenticate(input);
    await assert.rejects(verifyAndAuthenticate(input), codeIs("NO_CHALLENGE"));
  });

  it("rejects an expired challenge", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { message } = await createChallenge(ALICE.address);
    const signature = await ALICE.signMessage({ message });
    await AuthChallenge.updateOne(
      { externalEOA: ALICE.address.toLowerCase() },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await assert.rejects(
      verifyAndAuthenticate({ externalEOA: ALICE.address, signature }),
      codeIs("CHALLENGE_EXPIRED"),
    );
  });

  it("treats a mixed-case address as the same user", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const first = await verifyAndAuthenticate(await challengeAndSign(ALICE));

    const { message } = await createChallenge(ALICE.address.toUpperCase().replace("0X", "0x"));
    const second = await verifyAndAuthenticate({
      externalEOA: ALICE.address.toUpperCase().replace("0X", "0x"),
      signature: await ALICE.signMessage({ message }),
    });

    assert.equal(second.user.userId, first.user.userId);
    assert.equal(await User.countDocuments({ userId: { $ne: ROOT_ID } }), 1);
  });
});

// ══════════════════════════════════ ONBOARDING IS REGISTRATION ════

/**
 * Registration completes onboarding.
 *
 * There is no wallet to create, no chain transaction to send and nothing to sync afterwards: the
 * address that signed the challenge is the address that holds every position, earns every reward
 * and receives every payout.
 */
describe("onboarding completes at first registration", () => {
  it("12. a first registration needs nothing but a signature from the user's own wallet", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const result = await verifyAndAuthenticate(await challengeAndSign(ALICE));

    assert.equal(result.isNewUser, true);
    // Authenticated and finished: a usable session, a referral code and a parent, in one call.
    assert.ok(result.token.length > 0);
    assert.ok(result.user.referralCode.startsWith("ACF-"));
    assert.equal(result.user.referredByUserId, ROOT_ID);
    assert.equal(result.user.externalEOA, ALICE.address.toLowerCase());
  });

  it("13. the user record carries ONE address and no wallet fields at all", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await verifyAndAuthenticate(await challengeAndSign(ALICE));

    // Read the raw document, not the model: a projection could hide a field that was written.
    const raw = (await User.collection.findOne({ externalEOA: ALICE.address.toLowerCase() }))!;
    for (const dead of ["smartWalletAddress", "smartWalletCreatedAt",
                        "smartWalletCreatedBlockNumber", "smartWalletCreatedTxHash"]) {
      assert.ok(!(dead in raw), `${dead} must not be written for a new user`);
    }
    const addressKeys = Object.keys(raw).filter((k) => /EOA|wallet|address/i.test(k));
    assert.deepEqual(addressKeys, ["externalEOA"], "exactly one address field");
  });

  it("14. the API response exposes no wallet field to mistake for a second identity", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const { user } = await verifyAndAuthenticate(await challengeAndSign(ALICE));
    assert.deepEqual(
      Object.keys(user).sort(),
      ["externalEOA", "referralCode", "referredByUserId", "userId"],
    );
  });

  it("15. registration is complete immediately: no second call changes the record", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const first = await verifyAndAuthenticate(await challengeAndSign(ALICE));
    const after = (await User.findOne({ userId: first.user.userId }))!;

    // Logging in again is the only follow-up there is, and it must leave the record alone.
    const second = await verifyAndAuthenticate(await challengeAndSign(ALICE));
    assert.equal(second.isNewUser, false);
    const again = (await User.findOne({ userId: first.user.userId }))!;
    assert.deepEqual(again.toObject(), after.toObject(), "nothing was added on return");
  });

  it("16. createdAt is set once on insert and does not move on a later login", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Phase 2 reads createdAt as the registration instant that decides direct qualification, so
    // its stability is a financial property. If a login moved it, a settled epoch could change.
    const first = await verifyAndAuthenticate(await challengeAndSign(ALICE));
    const before = await User.findOne({ userId: first.user.userId });
    const created = (before as unknown as { createdAt: Date }).createdAt;

    await verifyAndAuthenticate(await challengeAndSign(ALICE));
    const row = await User.findOne({ userId: first.user.userId });
    const later = (row as unknown as { createdAt: Date }).createdAt;
    assert.equal(later.getTime(), created.getTime(), "createdAt is immutable in practice");
  });

  it("17. a self-referral is rejected", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const alice = await verifyAndAuthenticate(await challengeAndSign(ALICE));
    // Alice already exists, so presenting her own code is a returning login, not a re-parent.
    const again = await verifyAndAuthenticate({
      ...(await challengeAndSign(ALICE)),
      referralCode: alice.user.referralCode,
    });
    assert.equal(again.isNewUser, false);
    assert.equal(again.user.referredByUserId, ROOT_ID, "her parent is unchanged");
    assert.notEqual(again.user.referredByUserId, again.user.userId, "never her own child");
  });
});
