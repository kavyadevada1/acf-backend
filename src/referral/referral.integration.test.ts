import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";

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

const {
  countDirectReferrals, getDirectReferralUserIds, getDirectReferrals, getDownlineCountsByDepth,
  getDownlineTree, getReferralSummary, getSponsor, getUplines, getUserByReferralCode,
  walkDownline, DownlineLimitExceededError, ReferralCycleError,
} = await import("./service.js");
const { User } = await import("../models/User.js");

const ROOT_ID = "usr_root_fixture";

/** Creates a user directly; the referral graph is the subject, not registration. */
const mk = (id: string, parent: string | null, n: number) =>
  User.create({
    userId: id,
    externalEOA: `0x${n.toString(16).padStart(40, "0")}`,
    referralCode: `ACF-${String(n).padStart(8, "X")}`,
    referredByUserId: parent,
  });

let seq = 1;
const makeRoot = () => mk(ROOT_ID, null, seq++);

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set — referral tests skipped"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await User.init();
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (!connected) return;
  seq = 1;
  await User.deleteMany({});
});

describe("ROOT", () => {
  // Startup validation lives in bootstrap.integration.test.ts; this suite is about the graph.
  it("1. the root is simply the user with no parent", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    await mk("usr_a", ROOT_ID, 10);

    assert.equal(await getSponsor(ROOT_ID), null);
    assert.equal((await getSponsor("usr_a"))!.userId, ROOT_ID);
  });

  it("2. a summary reports isRoot from having no parent, not from configuration", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    await mk("usr_a", ROOT_ID, 10);

    assert.equal((await getReferralSummary(ROOT_ID)).isRoot, true);
    assert.equal((await getReferralSummary("usr_a")).isRoot, false);
  });
});

describe("direct referrals", () => {
  it("4. counts and lists only true children", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    await mk("usr_a", ROOT_ID, 10);
    await mk("usr_b", ROOT_ID, 11);
    await mk("usr_c", "usr_a", 12);        // grandchild of ROOT, NOT a direct

    assert.equal(await countDirectReferrals(ROOT_ID), 2);
    assert.equal(await countDirectReferrals("usr_a"), 1);
    assert.equal(await countDirectReferrals("usr_c"), 0);

    const ids = await getDirectReferralUserIds(ROOT_ID);
    assert.deepEqual([...ids].sort(), ["usr_a", "usr_b"]);
  });

  it("5. paginates and never returns an unbounded list", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    for (let i = 0; i < 7; i++) await mk(`usr_d${i}`, ROOT_ID, 200 + i);

    const first = await getDirectReferrals(ROOT_ID, { limit: 3 });
    assert.equal(first.referrals.length, 3);
    assert.ok(first.nextCursor);

    const second = await getDirectReferrals(ROOT_ID, { limit: 3, cursor: first.nextCursor! });
    assert.equal(second.referrals.length, 3);

    const third = await getDirectReferrals(ROOT_ID, { limit: 3, cursor: second.nextCursor! });
    assert.equal(third.referrals.length, 1);
    assert.equal(third.nextCursor, null);

    // Every child appears exactly once across the pages.
    const seen = [...first.referrals, ...second.referrals, ...third.referrals].map((r) => r.userId);
    assert.equal(new Set(seen).size, 7);
  });

  it("6. clamps an oversized limit instead of honouring it", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    for (let i = 0; i < 5; i++) await mk(`usr_e${i}`, ROOT_ID, 300 + i);
    const page = await getDirectReferrals(ROOT_ID, { limit: 100_000 });
    assert.equal(page.referrals.length, 5);   // clamped to DIRECT_PAGE_MAX, not 100k
  });
});

describe("relative uplines", () => {
  /** ROOT -> a -> b -> c -> ... `depth` generations. */
  const chain = async (depth: number) => {
    await makeRoot();
    let parent = ROOT_ID;
    for (let i = 1; i <= depth; i++) {
      await mk(`usr_L${i}`, parent, 400 + i);
      parent = `usr_L${i}`;
    }
  };

  it("7. levels are RELATIVE to the user being evaluated", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await chain(3);
    // From L3: its parent is L2 (relative 1), then L1, then ROOT.
    assert.deepEqual(await getUplines("usr_L3"), [
      { userId: "usr_L2", relativeLevel: 1 },
      { userId: "usr_L1", relativeLevel: 2 },
      { userId: ROOT_ID, relativeLevel: 3 },
    ]);
    // The SAME users are at different relative levels from L2.
    assert.deepEqual(await getUplines("usr_L2"), [
      { userId: "usr_L1", relativeLevel: 1 },
      { userId: ROOT_ID, relativeLevel: 2 },
    ]);
  });

  it("8. stops at ROOT rather than padding to 7", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await chain(2);
    assert.equal((await getUplines("usr_L1")).length, 1);   // just ROOT
    assert.equal((await getUplines(ROOT_ID)).length, 0);    // ROOT has none
  });

  it("9. a 10-deep tree keeps L8+ as descendants while Level Income reads only 7", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await chain(10);

    // The deepest user has 7 uplines WITHIN the Level Income boundary...
    const capped = await getUplines("usr_L10", 7);
    assert.equal(capped.length, 7);
    assert.equal(capped.at(-1)!.userId, "usr_L3");   // L3 is 7 levels above L10

    // ...but the tree itself continues: ROOT is still an ancestor, 10 levels up.
    const full = await getUplines("usr_L10", 50);
    assert.equal(full.length, 10);
    assert.equal(full.at(-1)!.userId, ROOT_ID);
    assert.equal(full.at(-1)!.relativeLevel, 10);

    // And ROOT's entire downline still contains all ten, not seven.
    assert.equal((await walkDownline(ROOT_ID, () => {})).visited, 10);
  });

  it("10. detects a cycle instead of looping forever", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    await mk("usr_x", ROOT_ID, 500);
    await mk("usr_y", "usr_x", 501);
    // Registration cannot produce this; a bad import could.
    await User.collection.updateOne({ userId: "usr_x" }, { $set: { referredByUserId: "usr_y" } });

    await assert.rejects(getUplines("usr_y"), (e: unknown) => e instanceof ReferralCycleError);
  });
});

describe("entire downline", () => {
  it("11. visits every descendant at unlimited depth", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    await mk("usr_a", ROOT_ID, 600);
    await mk("usr_b", ROOT_ID, 601);
    await mk("usr_c", "usr_a", 602);
    await mk("usr_d", "usr_c", 603);
    await mk("usr_e", "usr_d", 604);

    const depths: Record<string, number> = {};
    const { visited, maxDepth } = await walkDownline(ROOT_ID, ({ userId, relativeDepth }) => {
      depths[userId] = relativeDepth;
    });

    assert.equal(visited, 5);
    assert.equal(maxDepth, 4);
    assert.deepEqual(depths, { usr_a: 1, usr_b: 1, usr_c: 2, usr_d: 3, usr_e: 4 });
  });

  it("12. THROWS rather than returning a partial downline", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    for (let i = 0; i < 10; i++) await mk(`usr_f${i}`, ROOT_ID, 700 + i);

    // Rank is computed from the ENTIRE downline. A truncated walk returned as complete would
    // understate someone's reward base with nothing to detect it, so the limit is an error.
    const visitedIds: string[] = [];
    await assert.rejects(
      walkDownline(ROOT_ID, ({ userId }) => { visitedIds.push(userId); }, { maxNodes: 4 }),
      (e: unknown) => e instanceof DownlineLimitExceededError && e.code === "DOWNLINE_LIMIT_EXCEEDED",
    );
    // It did start walking — proving the failure is the LIMIT, not an empty result.
    assert.ok(visitedIds.length > 0 && visitedIds.length <= 5);
  });

  it("13. survives a cycle in the downline direction", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    await mk("usr_p", ROOT_ID, 800);
    await mk("usr_q", "usr_p", 801);
    await User.collection.updateOne({ userId: "usr_p" }, { $set: { referredByUserId: "usr_q" } });

    // The visited-set stops the walk terminating rather than spinning on p -> q -> p.
    const { visited } = await walkDownline(ROOT_ID, () => {});
    assert.ok(visited <= 2);
  });

  it("14. counts descendants by RELATIVE depth", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    await mk("usr_a", ROOT_ID, 900);
    await mk("usr_b", ROOT_ID, 901);
    await mk("usr_c", "usr_a", 902);

    const counts = await getDownlineCountsByDepth(ROOT_ID, 7);
    assert.equal(counts[1], 2);
    assert.equal(counts[2], 1);
    assert.equal(counts[3], 0);   // reported as a real zero, not omitted
  });
});

describe("downline tree (display)", () => {
  it("17. returns the shape the network view needs, with relative depths", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    await mk("usr_a", ROOT_ID, 10);
    await mk("usr_b", ROOT_ID, 11);
    await mk("usr_c", "usr_a", 12);

    const { nodes, truncated } = await getDownlineTree(ROOT_ID, { maxDepth: 3 });
    assert.equal(nodes.length, 3);
    assert.equal(truncated, false);

    const a = nodes.find((n) => n.userId === "usr_a")!;
    assert.equal(a.relativeDepth, 1);
    assert.equal(a.parentUserId, ROOT_ID);
    assert.equal(a.directReferralCount, 1);          // usr_c hangs off it
    assert.ok(a.referralCode.startsWith("ACF-"));

    assert.equal(nodes.find((n) => n.userId === "usr_c")!.relativeDepth, 2);
  });

  it("17b. carries each member's own address, always present", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    await User.create({
      userId: "usr_a", externalEOA: "0x00000000000000000000000000000000000000aa",
      referralCode: "ACF-ONBOARD1", referredByUserId: ROOT_ID,
    });
    await mk("usr_b", ROOT_ID, 77);

    const { nodes } = await getDownlineTree(ROOT_ID);
    // Every node reports one address, and there is no "pending" node: a member is in the tree
    // only once they have registered, and registering is what gives them this address.
    assert.equal(nodes.find((n) => n.userId === "usr_a")!.externalEOA,
      "0x00000000000000000000000000000000000000aa");
    for (const node of nodes) {
      assert.ok(node.externalEOA, `${node.userId} has an address`);
      assert.match(node.externalEOA, /^0x[0-9a-f]{40}$/);
    }
  });

  it("18. reports truncation rather than implying the tree ends at the cut-off", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    let parent = ROOT_ID;
    for (let i = 1; i <= 5; i++) { await mk(`usr_d${i}`, parent, 20 + i); parent = `usr_d${i}`; }

    const shallow = await getDownlineTree(ROOT_ID, { maxDepth: 2 });
    assert.equal(shallow.nodes.length, 2);
    assert.equal(shallow.truncated, true);           // three more levels exist below

    const deep = await getDownlineTree(ROOT_ID, { maxDepth: 7 });
    assert.equal(deep.nodes.length, 5);
    assert.equal(deep.truncated, false);
  });

  it("19. caps depth so one request cannot walk an unbounded tree", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    const { maxDepth } = await getDownlineTree(ROOT_ID, { maxDepth: 999 });
    assert.equal(maxDepth, 7);
  });
});

describe("summary", () => {
  it("15. reports the user's own code, sponsor and direct count", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    await mk("usr_a", ROOT_ID, 1000);
    await mk("usr_b", "usr_a", 1001);

    const summary = await getReferralSummary("usr_a");
    assert.equal(summary.userId, "usr_a");
    assert.ok(summary.referralCode.startsWith("ACF-"));
    assert.equal(summary.sponsor?.userId, ROOT_ID);
    assert.equal(summary.directReferralCount, 1);
    assert.equal(summary.isRoot, false);

    const rootSummary = await getReferralSummary(ROOT_ID);
    assert.equal(rootSummary.sponsor, null);
    assert.equal(rootSummary.isRoot, true);
  });

  it("16. resolves a user by referral code, and rejects an unknown one", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await makeRoot();
    const root = await getUserByReferralCode("ACF-XXXXXXX1");
    assert.equal(root?.userId, ROOT_ID);
    assert.equal(await getUserByReferralCode("ACF-NOTREAL1"), null);
    assert.equal(await getUserByReferralCode("   "), null);
  });
});
