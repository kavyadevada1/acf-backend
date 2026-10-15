import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { privateKeyToAccount } from "viem/accounts";

const TEST_URI = process.env.MONGODB_TEST_URI;
function assertDisposable(uri: string): string {
  const name = new URL(uri).pathname.replace(/^\//, "");
  if (!name || !/test/i.test(name)) throw new Error(`MONGODB_TEST_URI must name a test database (got "${name}").`);
  return uri;
}

// Well-known Hardhat keys. Never used for anything holding value.
const ADMIN = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const STRANGER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

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
delete process.env.ROOT_REFERRER_USER_ID;

const { createChallenge, verifyAndAuthenticate } = await import("../auth/service.js");
const { findRootUser } = await import("../lib/bootstrap.js");
const { syncLogicalRootEOAFromChain, requireSyncedRoot, RootSyncError } =
  await import("../lib/rootSync.js");
const { User } = await import("../models/User.js");
const { HttpError } = await import("../lib/errors.js");

const codeIs = (code: string) => (error: unknown) =>
  error instanceof HttpError && error.code === code;
type SettlementChainReader = import("../settlement/chain.js").SettlementChainReader;

/**
 * ROOT EOA rotation.
 *
 * The protocol rotates its ROOT account on chain; the backend's job is to keep ONE permanent
 * logical root user pointed at whatever `ACFWithdrawal.currentRootEOA()` now says. The tree is
 * the thing that must not move: same userId, same referral code, same children, same descendants.
 * Only the wallet binding changes, and only through `syncLogicalRootEOAFromChain`.
 */

const A = ADMIN.address.toLowerCase();
const B = STRANGER.address.toLowerCase();
const C = "0x1111111111111111111111111111111111111111";

/**
 * A reader that reports exactly what the CONTRACT says about ROOT identity.
 *
 * Deliberately hand-built rather than reusing a shared fake, so each case states the chain state
 * it models.
 *
 * `historicalRoots` are the addresses a rotation left behind: the contract flags them forever, so
 * `isRootRewardAccount` stays true for them and they share the one ROOT claim watermark.
 * `rootClaimed` IS that shared watermark — every ROOT EOA, current or historical, reads the same
 * figure, exactly as ACFWithdrawal returns it, while `claimed` covers ordinary addresses.
 */
interface ChainRootOptions {
  /** Makes currentRootEOA() throw. */
  fails?: boolean;
  /** Makes isRootRewardAccount() throw, for the reservation fail-closed path. */
  rootRewardAccountFails?: boolean;
  /** Addresses that were ROOT before this one. */
  historicalRoots?: string[];
  /** The ONE cumulative watermark shared by every ROOT EOA. */
  rootClaimed?: bigint;
  /** Per-address watermarks for ordinary users. */
  claimed?: Record<string, bigint>;
}
function chainRoot(eoa: string, options: ChainRootOptions = {}) {
  const calls = { currentRootEOA: 0, alreadyClaimed: 0, isRootRewardAccount: 0 };
  const current = eoa.toLowerCase();
  const rootRouted = new Set([current, ...(options.historicalRoots ?? []).map((a) => a.toLowerCase())]);
  const reader = {
    async currentRootEOA() {
      calls.currentRootEOA += 1;
      if (options.fails) throw new Error("RPC unavailable (test)");
      return current;
    },
    async isRootRewardAccount(address: string) {
      calls.isRootRewardAccount += 1;
      if (options.rootRewardAccountFails) throw new Error("RPC unavailable (test)");
      return rootRouted.has(address.toLowerCase());
    },
    async alreadyClaimed(wallets: string[]) {
      calls.alreadyClaimed += 1;
      return new Map(wallets.map((w) => {
        const who = w.toLowerCase();
        return [who, rootRouted.has(who)
          ? options.rootClaimed ?? 0n
          : options.claimed?.[who] ?? 0n];
      }));
    },
  } as unknown as SettlementChainReader;
  return { reader, calls };
}

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set — rotation tests skipped"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await User.init();
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (connected) {
    await Promise.all([
      User.deleteMany({}),
      mongoose.connection.collection("authchallenges").deleteMany({}),
    ]);
  }
});

const ROOT_ID = "usr_root_permanent";
const ROOT_CODE = "ACF-ROOTROOT";

/** The logical root bound to A, with three directs and one grandchild. */
async function seedTree() {
  await User.collection.insertMany([
    { userId: ROOT_ID, externalEOA: A, referralCode: ROOT_CODE, referredByUserId: null,
      createdAt: new Date(1), updatedAt: new Date(1) },
    { userId: "u1", externalEOA: "0x00000000000000000000000000000000000000a1",
      referralCode: "ACF-U1000001", referredByUserId: ROOT_ID, createdAt: new Date(2), updatedAt: new Date(2) },
    { userId: "u2", externalEOA: "0x00000000000000000000000000000000000000a2",
      referralCode: "ACF-U2000002", referredByUserId: ROOT_ID, createdAt: new Date(3), updatedAt: new Date(3) },
    { userId: "u3", externalEOA: "0x00000000000000000000000000000000000000a3",
      referralCode: "ACF-U3000003", referredByUserId: ROOT_ID, createdAt: new Date(4), updatedAt: new Date(4) },
    { userId: "u1a", externalEOA: "0x00000000000000000000000000000000000000b1",
      referralCode: "ACF-U1A00001", referredByUserId: "u1", createdAt: new Date(5), updatedAt: new Date(5) },
  ] as never);
}

/** The whole graph, as (userId -> parent) pairs, for before/after comparison. */
async function graph() {
  const all = await User.find({}, { userId: 1, referredByUserId: 1, externalEOA: 1, referralCode: 1 })
    .sort({ userId: 1 }).lean();
  return all.map((u) => `${u.userId}:${u.referredByUserId ?? "null"}`);
}

describe("root EOA rotation rebinds one node and moves nothing else", () => {
  it("18-27. A -> B rebinds the logical root and leaves the tree byte-identical", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    const before = await graph();
    const count = await User.countDocuments({});

    const result = await syncLogicalRootEOAFromChain(chainRoot(B).reader);
    assert.equal(result.status, "REBOUND");
    assert.equal(result.status === "REBOUND" && result.previousEOA, A);

    const root = (await findRootUser())!;
    assert.equal(root.externalEOA, B, "18. the binding moved to the chain's ROOT");
    assert.equal(root.userId, ROOT_ID, "19. userId unchanged");
    assert.equal(root.referralCode, ROOT_CODE, "20. referralCode unchanged");
    assert.equal(root.referredByUserId, null, "21. still the one parentless user");

    // 22-25: not one edge moved.
    assert.deepEqual(await graph(), before, "the referral graph is untouched");
    for (const [child, parent] of [["u1", ROOT_ID], ["u2", ROOT_ID], ["u3", ROOT_ID], ["u1a", "u1"]] as const) {
      assert.equal((await User.findOne({ userId: child }))!.referredByUserId, parent);
    }
    // 26-27: no second root, no user invented for B.
    assert.equal(await User.countDocuments({}), count);
    assert.equal(await User.countDocuments({ referredByUserId: null }), 1);
    assert.equal(await User.countDocuments({ externalEOA: B }), 1);
    assert.equal((await User.findOne({ externalEOA: B }))!.userId, ROOT_ID);
  });

  it("is O(1): rebinding touches exactly one document", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    const untouched = await User.find({ userId: { $ne: ROOT_ID } }, { __v: 0 }).sort({ userId: 1 }).lean();

    await syncLogicalRootEOAFromChain(chainRoot(B).reader);

    // Every other document is byte-identical, updatedAt included — so no bulk write ran over the
    // descendants. A tree migration would be an O(N) rewrite; this must never become one.
    const after = await User.find({ userId: { $ne: ROOT_ID } }, { __v: 0 }).sort({ userId: 1 }).lean();
    assert.deepEqual(after, untouched);
  });

  it("is idempotent, and concurrent syncs converge on one binding", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();

    // Eight callers racing on the same rotation. Exactly one applies the compare-and-set; the
    // others observe the result and accept it rather than re-applying or failing.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => syncLogicalRootEOAFromChain(chainRoot(B).reader)),
    );
    const rebound = results.filter((r) => r.status === "REBOUND").length;
    const inSync = results.filter((r) => r.status === "IN_SYNC").length;
    assert.equal(rebound + inSync, 8);
    assert.equal(rebound, 1, "exactly one writer");

    assert.equal((await findRootUser())!.externalEOA, B);
    assert.equal(await User.countDocuments({}), 5);
    assert.equal(await User.countDocuments({ referredByUserId: null }), 1);

    // A further sync is a no-op.
    assert.equal((await syncLogicalRootEOAFromChain(chainRoot(B).reader)).status, "IN_SYNC");
    assert.equal((await findRootUser())!.externalEOA, B);
  });

  it("rotates twice without ever creating a second root", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    await syncLogicalRootEOAFromChain(chainRoot(B).reader);
    await syncLogicalRootEOAFromChain(chainRoot(C).reader);

    const root = (await findRootUser())!;
    assert.equal(root.userId, ROOT_ID);
    assert.equal(root.externalEOA, C);
    assert.equal(await User.countDocuments({}), 5);
    assert.equal(await User.countDocuments({ referredByUserId: null }), 1);
  });
});

describe("rotation refuses rather than guessing", () => {
  it("39-42. a new ROOT EOA already owned by another user fails closed", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    // USER-999 already holds B. Merging would mean choosing whose referrals, positions and
    // reward history survive — every option loses someone's money or their downline.
    await User.collection.insertOne({
      userId: "usr_999", externalEOA: B, referralCode: "ACF-U9990009",
      referredByUserId: ROOT_ID, createdAt: new Date(6), updatedAt: new Date(6),
    } as never);
    const before = await graph();
    const snapshot = await User.find({}, { __v: 0 }).sort({ userId: 1 }).lean();

    await assert.rejects(
      syncLogicalRootEOAFromChain(chainRoot(B).reader),
      (error: unknown) => {
        assert.ok(error instanceof RootSyncError);
        assert.equal((error as InstanceType<typeof RootSyncError>).reason, "ROOT_EOA_COLLISION");
        assert.match((error as Error).message, /usr_999 already owns that address/);
        return true;
      },
    );

    // 40-41: zero users and zero edges modified.
    assert.deepEqual(await User.find({}, { __v: 0 }).sort({ userId: 1 }).lean(), snapshot);
    assert.deepEqual(await graph(), before);
    assert.equal((await findRootUser())!.externalEOA, A, "the root is still bound to A");
    assert.equal((await User.findOne({ userId: "usr_999" }))!.externalEOA, B, "usr_999 keeps its address");
  });

  it("rebinds after the outgoing ROOT has claimed, without consulting any watermark", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    const before = await graph();

    // The previous milestone refused exactly this, because the contract then kept a watermark per
    // ADDRESS and carrying the root's cumulative onto B would re-pay whatever A had drawn. The
    // contract now keeps ONE watermark for every ROOT EOA, so B reads A's figure and can only
    // draw above it — one claim, ten claims or years of claims make no difference here.
    const chain = chainRoot(B, { historicalRoots: [A], rootClaimed: 5_000n });
    assert.equal((await syncLogicalRootEOAFromChain(chain.reader)).status, "REBOUND");
    assert.equal((await findRootUser())!.externalEOA, B);

    // The sync does not read a watermark at all any more: there is no condition left for it to
    // decide. Asserted so the removed read cannot quietly come back as a new refusal.
    assert.equal(chain.calls.alreadyClaimed, 0, "no watermark condition remains in the sync");

    // Same node, same tree.
    assert.deepEqual(await graph(), before);
    assert.equal((await findRootUser())!.userId, ROOT_ID);
  });

  it("rebinds repeatedly as the ROOT rotates A -> B -> C, keeping one logical root", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    const before = await graph();
    const root = (await findRootUser())!;

    assert.equal(
      (await syncLogicalRootEOAFromChain(chainRoot(B, { historicalRoots: [A], rootClaimed: 10_000n }).reader)).status,
      "REBOUND",
    );
    assert.equal(
      (await syncLogicalRootEOAFromChain(chainRoot(C, { historicalRoots: [A, B], rootClaimed: 15_000n }).reader)).status,
      "REBOUND",
    );

    const after = (await findRootUser())!;
    assert.equal(after.externalEOA, C);
    assert.equal(after.userId, root.userId, "the same permanent logical root throughout");
    assert.equal(after.referralCode, root.referralCode);
    assert.equal(after.referredByUserId ?? null, null);
    assert.equal(await User.countDocuments({ referredByUserId: null }), 1, "never a second root");
    assert.deepEqual(await graph(), before, "and no descendant moved");
  });

  it("18b. an unreadable RPC writes nothing and offers no fallback root", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    const snapshot = await User.find({}, { __v: 0 }).sort({ userId: 1 }).lean();
    await assert.rejects(syncLogicalRootEOAFromChain(chainRoot(B, { fails: true }).reader), /RPC unavailable/);
    assert.deepEqual(await User.find({}, { __v: 0 }).sort({ userId: 1 }).lean(), snapshot);
    await assert.rejects(requireSyncedRoot(chainRoot(B, { fails: true }).reader), /RPC unavailable/);
  });
});

describe("authentication across a rotation", () => {
  async function challengeAndSign(account: typeof ADMIN) {
    const { message } = await createChallenge(account.address);
    return { externalEOA: account.address, signature: await account.signMessage({ message }) };
  }

  it("29-33. B signs in and receives the EXISTING logical root account", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    const count = await User.countDocuments({});
    const before = await graph();

    // 30: the backend verifies B == currentRootEOA() before rebinding anything.
    const result = await verifyAndAuthenticate(await challengeAndSign(STRANGER), chainRoot(B).reader);

    assert.equal(result.isNewUser, false, "33. no new user was created");
    assert.equal(result.user.userId, ROOT_ID, "31-32. the same ROOT record, now answering to B");
    assert.equal(result.user.externalEOA, B);
    assert.equal(result.user.referralCode, ROOT_CODE);
    assert.equal(result.user.referredByUserId, null);
    assert.ok(result.token.length > 0, "32. B holds a session for the logical root");

    assert.equal(await User.countDocuments({}), count);
    assert.deepEqual(await graph(), before);
  });

  it("49-51. A is permanently RESERVED after the rotation, not given an ordinary account", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    const chain = chainRoot(B, { historicalRoots: [A] });
    await syncLogicalRootEOAFromChain(chain.reader);
    const count = await User.countDocuments({});
    const before = await graph();

    // A proves control of A, which is no longer the ROOT the contract names. It gets neither the
    // root's session nor an ordinary account of its own.
    //
    // An ordinary account is the dangerous outcome, not a harmless one: `isRootRewardAccount[A]`
    // is permanent on chain, so every reward the backend attributed to A as an ordinary user
    // would leave the contract through the ROOT partner distribution instead of reaching A. The
    // address can only ever be a ROOT claim identity, so it is reserved rather than reused.
    await assert.rejects(
      verifyAndAuthenticate(await challengeAndSign(ADMIN), chain.reader),
      codeIs("HISTORICAL_ROOT_EOA_RESERVED"),
    );

    // 50: nothing was written at all — no user, no userId, no referral code, no edge.
    assert.equal(await User.countDocuments({}), count, "no User was created for the historical ROOT");
    assert.equal(await User.countDocuments({ externalEOA: A }), 0);
    assert.deepEqual(await graph(), before, "and no referral edge was added");

    // 52-53: and the rotation itself is untouched by the attempt.
    assert.equal((await findRootUser())!.externalEOA, B);
    assert.equal((await findRootUser())!.userId, ROOT_ID);
  });

  it("the current ROOT is admitted even though it is also root-routed", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    // The current ROOT is flagged too, so order matters: it must be recognized as CURRENT before
    // the historical check, or the live root would lock itself out of its own account.
    const result = await verifyAndAuthenticate(
      await challengeAndSign(STRANGER), chainRoot(B, { historicalRoots: [A] }).reader);
    assert.equal(result.isNewUser, false);
    assert.equal(result.user.userId, ROOT_ID);
    assert.equal(result.user.externalEOA, B);
  });

  it("54. an ordinary wallet the contract has never flagged registers normally", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    const third = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    const chain = chainRoot(A, { historicalRoots: [] });

    // No referral code: attaches to the logical root's userId.
    const plain = await verifyAndAuthenticate(await challengeAndSign(third), chain.reader);
    assert.equal(plain.isNewUser, true);
    assert.equal(plain.user.referredByUserId, ROOT_ID);

    // An explicit referral still selects its owner.
    const fourth = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
    const invited = await verifyAndAuthenticate(
      { ...(await challengeAndSign(fourth)), referralCode: "ACF-U1000001" }, chain.reader);
    assert.equal(invited.user.referredByUserId, "u1");
  });

  it("55-56. an unreadable historical-root check FAILS CLOSED and writes nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    const third = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    const count = await User.countDocuments({});

    // An unreadable `isRootRewardAccount` must NOT be read as "not a ROOT". Assuming false would
    // let a historical ROOT create an ordinary account during an RPC outage, which can never be
    // undone; a newcomer who retries has lost nothing.
    await assert.rejects(
      verifyAndAuthenticate(
        await challengeAndSign(third), chainRoot(A, { rootRewardAccountFails: true }).reader),
      codeIs("REFERRAL_ROOT_UNAVAILABLE"),
    );
    assert.equal(await User.countDocuments({}), count, "no user was written");
  });

  it("an arbitrary wallet cannot trigger a rebind by signing in", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    const third = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

    // The chain still says A. A wallet qualifies for the root account only by EQUALLING
    // currentRootEOA(); nothing in the request can influence that.
    const result = await verifyAndAuthenticate(await challengeAndSign(third), chainRoot(A).reader);
    assert.equal(result.isNewUser, true);
    assert.notEqual(result.user.userId, ROOT_ID);
    assert.equal((await findRootUser())!.externalEOA, A);
    assert.equal(await User.countDocuments({ referredByUserId: null }), 1);
  });

  it("a newcomer is not blocked when the root-check RPC is unavailable", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    const third = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

    // `currentRootEOA()` is consulted only once an address is already known to be ROOT-routed, so
    // an ordinary newcomer never reaches it and is not blocked when it is unavailable. The
    // reservation check itself still fails closed — that is the case above.
    const result = await verifyAndAuthenticate(
      await challengeAndSign(third), chainRoot(B, { fails: true }).reader);
    assert.equal(result.isNewUser, true);
    assert.equal(result.user.referredByUserId, ROOT_ID);
    assert.equal((await findRootUser())!.externalEOA, A, "and nothing was rebound on a failed read");
  });

  it("the returning ROOT keeps its session after it has been rebound", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seedTree();
    await verifyAndAuthenticate(await challengeAndSign(STRANGER), chainRoot(B).reader);
    const again = await verifyAndAuthenticate(await challengeAndSign(STRANGER), chainRoot(B).reader);
    assert.equal(again.isNewUser, false);
    assert.equal(again.user.userId, ROOT_ID);
    assert.equal(await User.countDocuments({}), 5);
  });
});
