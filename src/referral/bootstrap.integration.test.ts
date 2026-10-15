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
const { assertReferralRoot, findRootUser, referralRootStatus } = await import("../lib/bootstrap.js");
const { syncLogicalRootEOAFromChain } = await import("../lib/rootSync.js");
const { User } = await import("../models/User.js");
const { HttpError } = await import("../lib/errors.js");
type SettlementChainReader = import("../settlement/chain.js").SettlementChainReader;

const codeIs = (c: string) => (e: unknown) => e instanceof HttpError && e.code === c;

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
  const current = eoa.toLowerCase();
  const rootRouted = new Set([current, ...(options.historicalRoots ?? []).map((a) => a.toLowerCase())]);
  return {
    async currentRootEOA() {
      if (options.fails) throw new Error("RPC unavailable (test)");
      return current;
    },
    async isRootRewardAccount(address: string) {
      if (options.rootRewardAccountFails) throw new Error("RPC unavailable (test)");
      return rootRouted.has(address.toLowerCase());
    },
    async alreadyClaimed(wallets: string[]) {
      return new Map(wallets.map((w) => {
        const who = w.toLowerCase();
        return [who, rootRouted.has(who)
          ? options.rootClaimed ?? 0n
          : options.claimed?.[who] ?? 0n];
      }));
    },
  } as unknown as SettlementChainReader;
}

type Account = typeof ADMIN;
async function challengeAndSign(account: Account) {
  const { message } = await createChallenge(account.address);
  return { externalEOA: account.address, signature: await account.signMessage({ message }) };
}
const login = (account: Account, reader: SettlementChainReader, referralCode?: string) =>
  challengeAndSign(account).then((signed) =>
    verifyAndAuthenticate(referralCode === undefined ? signed : { ...signed, referralCode }, reader));

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set — root tests skipped"); return; }
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

/**
 * The permanent logical referral root.
 *
 * It is identified by TREE POSITION — the single user with no parent — never by a configured
 * address. The wallet it answers to is whatever `ACFWithdrawal.currentRootEOA()` says, and that
 * can rotate; the node itself never moves.
 */
describe("before the on-chain ROOT has registered", () => {
  it("1. the backend STARTS on an empty database", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // No chicken-and-egg: startup says nothing about WHICH wallet the root holds, so it cannot
    // refuse to boot at the moment an operator needs it up in order to synchronize.
    await assertReferralRoot();
    assert.equal(await referralRootStatus(), "awaiting-root");
    assert.equal(await findRootUser(), null);
  });

  it("2. only the on-chain ROOT may create the first account", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const reader = chainRoot(ADMIN.address);
    await assert.rejects(login(STRANGER, reader), codeIs("REFERRAL_ROOT_UNAVAILABLE"));
    // Refused BEFORE any write: a half-created user is exactly the parentless record this prevents.
    assert.equal(await User.countDocuments({}), 0);
  });

  it("3. a stranger presenting a referral code is refused too, because there is no tree yet", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // There is nothing for the code to resolve against, and honouring it would create an orphan
    // branch whose top has no parent — a second root in all but name.
    await assert.rejects(
      login(STRANGER, chainRoot(ADMIN.address), "ACF-ANYTHING"),
      codeIs("REFERRAL_ROOT_UNAVAILABLE"),
    );
    assert.equal(await User.countDocuments({}), 0);
  });

  it("4. an unreadable RPC fails the bootstrap closed rather than guessing a root", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // The alternative to refusing is creating the referral root against an unverified wallet,
    // which cannot be undone. A caller who has to retry has lost nothing.
    await assert.rejects(
      login(ADMIN, chainRoot(ADMIN.address, { fails: true })),
      codeIs("REFERRAL_ROOT_UNAVAILABLE"),
    );
    assert.equal(await User.countDocuments({}), 0);
  });
});

describe("the on-chain ROOT registers through the normal flow", () => {
  it("5. becomes the root with a normal userId and code, from its own address", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const result = await login(ADMIN, chainRoot(ADMIN.address));

    assert.equal(result.isNewUser, true);
    assert.ok(result.user.userId.startsWith("usr_"));
    assert.equal(result.user.externalEOA, ADMIN.address.toLowerCase());
    assert.equal(result.user.referredByUserId, null);        // the one parentless user
    assert.ok(result.user.referralCode.startsWith("ACF-"));
    // No seed script and no inserted record: it registered like anyone else.
    assert.equal(await User.countDocuments({}), 1);
  });

  it("6. registration opens IMMEDIATELY — no restart, no config change", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const reader = chainRoot(ADMIN.address);
    const admin = await login(ADMIN, reader);
    assert.equal(await referralRootStatus(), "registered");

    // The same stranger refused moments ago now registers and attaches to the root.
    const stranger = await login(STRANGER, reader);
    assert.equal(stranger.user.referredByUserId, admin.user.userId);
  });

  it("7. a referral code supplied by the ROOT cannot give it a sponsor", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // A plausible accident: the operator opens the app through someone's invite link. The root
    // must still be parentless, or the tree has no top.
    const decoy = await User.create({
      userId: "usr_decoy", externalEOA: "0x3333333333333333333333333333333333333333",
      referralCode: "ACF-DECOY001", referredByUserId: "usr_decoy_parent",
    });

    const admin = await login(ADMIN, chainRoot(ADMIN.address), decoy.referralCode);
    assert.equal(admin.user.referredByUserId, null);   // ignored, not honoured
    assert.equal((await findRootUser())!.userId, admin.user.userId);
  });

  it("8. the ROOT logging in again reuses the SAME user", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const reader = chainRoot(ADMIN.address);
    const first = await login(ADMIN, reader);
    const second = await login(ADMIN, reader);

    assert.equal(second.isNewUser, false);
    assert.equal(second.user.userId, first.user.userId);
    assert.equal(second.user.referralCode, first.user.referralCode);
    assert.equal(second.user.referredByUserId, null);
    assert.equal(await User.countDocuments({}), 1);
  });
});

describe("startup safety", () => {
  it("9. several parentless users are reported as a forked tree", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await login(ADMIN, chainRoot(ADMIN.address));
    await User.create({
      userId: "usr_legacy", externalEOA: "0x5555555555555555555555555555555555555555",
      referralCode: "ACF-LEGACY01", referredByUserId: null,
    });
    await assert.rejects(assertReferralRoot(), /backfill-root-parent/);
  });

  it("10. a root holding an address the chain has rotated away from still boots", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Startup deliberately does NOT compare against the chain. A rotation that happens while the
    // backend is down must not lock the operator out of the very process that reconciles it.
    await User.create({
      userId: "usr_old_root", externalEOA: "0x4444444444444444444444444444444444444444",
      referralCode: "ACF-OLDROOT1", referredByUserId: null,
    });
    await assertReferralRoot();
    assert.equal((await findRootUser())!.userId, "usr_old_root");
  });
});

describe("normal operation after bootstrap", () => {
  it("11. no code attaches to root; a code selects its owner; returning users never move", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const reader = chainRoot(ADMIN.address);
    const admin = await login(ADMIN, reader);
    const stranger = await login(STRANGER, reader);
    assert.equal(stranger.user.referredByUserId, admin.user.userId);

    const third = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    const invited = await login(third, reader, stranger.user.referralCode);
    assert.equal(invited.user.referredByUserId, stranger.user.userId);

    const again = await login(third, reader, admin.user.referralCode);
    assert.equal(again.isNewUser, false);
    assert.equal(again.user.referredByUserId, stranger.user.userId);

    assert.equal(await User.countDocuments({ referredByUserId: null }), 1);
  });

  it("12. an explicit valid referral is never replaced by ROOT", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const reader = chainRoot(ADMIN.address);
    const admin = await login(ADMIN, reader);
    const sponsor = await login(STRANGER, reader);
    const third = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

    const invited = await login(third, reader, sponsor.user.referralCode);
    assert.equal(invited.user.referredByUserId, sponsor.user.userId);
    assert.notEqual(invited.user.referredByUserId, admin.user.userId);
  });

  it("13. an ordinary user's address stays immutable", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const reader = chainRoot(ADMIN.address);
    await login(ADMIN, reader);
    const stranger = await login(STRANGER, reader);

    // Only the logical root may ever rebind, and only through rootSync. Every ordinary write path
    // is still blocked by the schema, exactly as before.
    await User.findOneAndUpdate(
      { userId: stranger.user.userId },
      { $set: { externalEOA: "0x8888888888888888888888888888888888888888" } },
    );
    const after = await User.findOne({ userId: stranger.user.userId });
    assert.equal(after!.externalEOA, STRANGER.address.toLowerCase(), "unchanged");
  });

  it("14. the root's address is immutable through ordinary writes too", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const admin = await login(ADMIN, chainRoot(ADMIN.address));

    // There is no onboarding step that fills an address in later, and no endpoint that accepts a
    // replacement. The ONLY path that can move it is syncLogicalRootEOAFromChain, which takes its
    // value from the contract rather than from a caller.
    await User.findOneAndUpdate(
      { userId: admin.user.userId },
      { $set: { externalEOA: "0x8888888888888888888888888888888888888888" } },
    );

    const after = await User.findOne({ userId: admin.user.userId });
    assert.equal(after!.externalEOA, ADMIN.address.toLowerCase(), "unchanged");
    assert.equal(after!.referralCode, admin.user.referralCode);
    assert.equal(after!.referredByUserId, null);
    await assertReferralRoot();
    assert.equal((await findRootUser())!.userId, admin.user.userId);
  });

  it("15. syncing an already-correct binding writes nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const admin = await login(ADMIN, chainRoot(ADMIN.address));
    const before = await User.findOne({ userId: admin.user.userId }).lean();

    const result = await syncLogicalRootEOAFromChain(chainRoot(ADMIN.address));
    assert.equal(result.status, "IN_SYNC");

    const after = await User.findOne({ userId: admin.user.userId }).lean();
    assert.deepEqual(after, before, "no write at all when the binding already matches");
  });

  it("16. syncing before bootstrap reports it rather than inventing a root", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const result = await syncLogicalRootEOAFromChain(chainRoot(ADMIN.address));
    assert.equal(result.status, "AWAITING_BOOTSTRAP");
    assert.equal(result.root, null);
    assert.equal(await User.countDocuments({}), 0);
  });

  it("17. an unreadable RPC fails the sync closed and writes nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    const admin = await login(ADMIN, chainRoot(ADMIN.address));
    await assert.rejects(
      syncLogicalRootEOAFromChain(chainRoot(STRANGER.address, { fails: true })),
      /RPC unavailable/,
    );
    // No fallback to the stored value, the old env variable, or a cached answer.
    const after = await User.findOne({ userId: admin.user.userId });
    assert.equal(after!.externalEOA, ADMIN.address.toLowerCase());
  });
});
