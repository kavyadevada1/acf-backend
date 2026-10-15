import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import {
  assertDisposable, fakeChain, TEST_ROOT_EOA, TEST_STAKING, TEST_WITHDRAWAL, TEST_TREASURY,
} from "./testenv.ts";

const TEST_URI = process.env.MONGODB_TEST_URI;

const { calculateSettlementCheckpoint, SettlementStateError } = await import("./checkpoint.js");
const { buildSettlementTree } = await import("./merkle.js");
const { reconcileClaimStates, reconcileSettlementCheckpoint, ClaimReconciliationError } =
  await import("./reconcile.js");
const { claimedSelfACFForStake } = await import("./claims.js");
const { buildClaimProof, __clearProofCache } = await import("./proof.js");
const { getRewardSummary } = await import("./summary.js");
const { buildManifest } = await import("./manifest.js");
const { SettlementInvariantError, ZERO_ROOT } = await import("./policy.js");
const { User } = await import("../models/User.js");
const { Stake } = await import("../models/Stake.js");
const { StakeRewardEntry } = await import("../models/StakeRewardEntry.js");
const { TeamRewardEntry } = await import("../models/TeamRewardEntry.js");
const { RewardEpoch } = await import("../models/RewardEpoch.js");
const { RewardPhase2Epoch } = await import("../models/RewardPhase2Epoch.js");
const { RewardSettlementCheckpoint } = await import("../models/RewardSettlementCheckpoint.js");
const { UserRewardCheckpoint } = await import("../models/UserRewardCheckpoint.js");
const { CheckpointSelfComponent } = await import("../models/CheckpointSelfComponent.js");
const { UserClaimState } = await import("../models/UserClaimState.js");
const { RewardClaim } = await import("../models/RewardClaim.js");
const { syncLogicalRootEOAFromChain, RootSyncError } = await import("../lib/rootSync.js");

const E18 = 10n ** 18n;
const LOW = TEST_STAKING.toLowerCase();
const WD = TEST_WITHDRAWAL.toLowerCase();
const SK = { chainId: 80002, stakingContractAddress: LOW };
const SETTLE = { chainId: 80002, withdrawalAddress: WD };

/**
 * A synthetic already-settled checkpoint, used by every suite that needs a predecessor.
 *
 * Replaces the old legacy-seed fixture, which pinned the suite to one obsolete deployment's
 * epoch id, root, claimant and amount. The values here are arbitrary; only the ROOT is real,
 * rebuilt from the leaf so proof generation against this checkpoint behaves exactly as it does
 * against a calculated one.
 */
const BASELINE_ID = 1_000;
const BASELINE_ACF = 5n * E18;
const NEXT = BASELINE_ID + 1;

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await Promise.all([
    User.init(), Stake.init(), StakeRewardEntry.init(), TeamRewardEntry.init(),
    RewardEpoch.init(), RewardPhase2Epoch.init(), RewardSettlementCheckpoint.init(),
    UserRewardCheckpoint.init(), CheckpointSelfComponent.init(), UserClaimState.init(),
    RewardClaim.init(),
  ]);
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (connected) await Promise.all([
    User.deleteMany({}), Stake.deleteMany({}), StakeRewardEntry.deleteMany({}),
    TeamRewardEntry.deleteMany({}), RewardEpoch.deleteMany({}), RewardPhase2Epoch.deleteMany({}),
    RewardSettlementCheckpoint.deleteMany({}), UserRewardCheckpoint.deleteMany({}),
    CheckpointSelfComponent.deleteMany({}), UserClaimState.deleteMany({}),
    RewardClaim.deleteMany({}),
  ]);
  seq = 0;
  __clearProofCache();
});

let seq = 0;
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

/** The baseline's claimant and its REAL root, rebuilt from the single leaf. */
const BASELINE_EOA = wallet(0xba5e).toLowerCase();
const BASELINE_ROOT = buildSettlementTree([{
  externalEOA: BASELINE_EOA, cumulativeSelfACF: BASELINE_ACF, cumulativeTeamACF: 0n,
}]).root;

const mkUser = async (userId: string, parent: string | null, walletAddr?: string) => {
  seq += 1;
  await User.collection.insertOne({
    userId,
    externalEOA: userId === "root" ? TEST_ROOT_EOA : `0x${seq.toString(16).padStart(40, "a")}`,
    referralCode: `ACF-${userId.toUpperCase()}`,
    referredByUserId: parent,
    ...(walletAddr ? { externalEOA: walletAddr.toLowerCase() } : {}),
    createdAt: new Date(1), updatedAt: new Date(1),
  } as never);
};

/** Marks a reward epoch settled by both upstream phases. */
const settleEpoch = async (epochId: number) => {
  await RewardEpoch.collection.insertOne({
    ...SK, epochId, windowStart: epochId * 43200 - 43200, snapshotAt: epochId * 43200,
    status: "CALCULATED", attempts: 1, snapshotBlockNumber: epochId * 43200,
    priceE18: E18.toString(), poolROISnapshot: [],
    stakesProcessed: 0, stakesRewarded: 0, totalRegularSelfACF: "0", totalDAOStakeACF: "0",
  } as never);
  await RewardPhase2Epoch.collection.insertOne({
    ...SK, epochId, status: "CALCULATED", attempts: 1,
    snapshotAt: epochId * 43200, priceE18: E18.toString(),
  } as never);
};

/** A Phase 1 Self reward for one stake in one epoch. */
const mkSelf = async (
  userId: string, walletAddr: string, stakeId: string, epochId: number, amount: bigint,
) => {
  await StakeRewardEntry.collection.insertOne({
    ...SK, stakeId, epochId, userId, externalEOA: walletAddr.toLowerCase(),
    source: "DIRECT", poolId: 1, principalACF: (1000n * E18).toString(),
    compoundBaseACF: (1000n * E18).toString(), rewardACF: amount.toString(),
    cumulativeEarnedACF: "0", rateApplied: "2500", rateDenominator: "1000000",
    rewardEligible: true, ineligibleReason: null, snapshotAt: epochId * 43200,
  } as never);
};

/** A Phase 2 Team reward. */
const mkTeam = async (userId: string, epochId: number, amount: bigint) => {
  await TeamRewardEntry.collection.insertOne({
    ...SK, epochId, userId,
    levelRewardACF: amount.toString(), rankRewardACF: "0", globalRewardACF: "0",
    teamRewardACF: amount.toString(),
    levelAudit: { unlockedLevels: 1, directCount: 1, perLevel: [] },
    rankAudit: {
      leaderRank: 0, leaderRateE6: "0", highestDownlineRank: 0, highestDownlineRateE6: "0",
      differentialRateE6: "0", teamRewardBaseACF: "0", grossACF: "0", epochCapUSD6: "0",
      capped: false,
    },
    globalAudit: {
      rankNumber: 0, selfStakeACF: "0", selfStakeUSD6: "0", l1StakeACF: "0", l1StakeUSD6: "0",
      networkContributionACF: "0", networkContributionUSD6: "0", priceE18: E18.toString(),
    },
  } as never);
};


const A = wallet(0xaaa1);
const B = wallet(0xbbb2);
const C = wallet(0xccc3);
const ROOT_ID = "root";
const ROOT_CODE = "ACF-ROOT";

/** The logical root bound to A, with one direct, and one Team reward ready to publish. */
async function rootWithEntitlement(amount = 9n * E18, epochId = 41010) {
  await User.collection.insertMany([
    { userId: ROOT_ID, externalEOA: A, referralCode: ROOT_CODE, referredByUserId: null,
      createdAt: new Date(1), updatedAt: new Date(1) },
    { userId: "u1", externalEOA: wallet(0xc001), referralCode: "ACF-U1",
      referredByUserId: ROOT_ID, createdAt: new Date(2), updatedAt: new Date(2) },
  ] as never);
  await settleEpoch(epochId);
  await mkTeam(ROOT_ID, epochId, amount);
}

/** Calculates and returns the new checkpoint id, failing the test if nothing was settled. */
async function calculated(reader: Parameters<typeof calculateSettlementCheckpoint>[0]) {
  const result = await calculateSettlementCheckpoint(reader);
  assert.equal(result.outcome, "CALCULATED", `expected a checkpoint, got ${JSON.stringify(result)}`);
  assert.ok("checkpointId" in result);
  return result.checkpointId as number;
}

/** Marks the single calculated checkpoint FINALIZED, as the executor would after the chain call. */
async function finalize(checkpointId: number) {
  await RewardSettlementCheckpoint.collection.updateOne(
    { ...SETTLE, checkpointId },
    { $set: { status: "FINALIZED", finalizedBlockNumber: 500 } },
  );
}

/**
 * A chain that agrees with a given published checkpoint and names a given ROOT.
 *
 * `rootClaimed` is the ONE cumulative watermark every ROOT EOA shares, which is what the fake
 * answers `alreadyClaimed` with for any ROOT-routed address. A is always flagged, because it is
 * this suite's bootstrap ROOT and the contract never clears the flag; `claimed` covers ordinary
 * addresses, which keep their own watermarks.
 */
async function chainAt(
  checkpointId: number,
  rootEOA: string,
  options: { rootClaimed?: bigint; claimed?: Record<string, bigint>; historicalRoots?: string[] } = {},
) {
  const cp = await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId }).lean();
  return fakeChain({
    root: cp!.root,
    cumulativeTotal: BigInt(cp!.publishedCumulativeTotalACF),
    latestEpochId: checkpointId,
    finalized: new Set([checkpointId]),
    currentRootEOA: rootEOA,
    rootRewardAccounts: options.historicalRoots ?? [A],
    rootClaimed: options.rootClaimed ?? 0n,
    claimed: new Map(Object.entries(options.claimed ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  });
}

/**
 * ROOT rotation, where it meets settlement.
 *
 * A checkpoint leaf is keyed to an ADDRESS and a published checkpoint is cumulative and
 * permanent, so this is the one place a stale or careless rebind would cause a real financial
 * error rather than a cosmetic one.
 */
describe("the audit: can a rotated-away ROOT still reach its entitlement?", () => {
  it("32-33. a rebind defers the published entitlement by one checkpoint and loses none of it", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // 1-2. A earns a finalized entitlement and does NOT claim.
    await rootWithEntitlement(9n * E18, 41010);
    const id1 = await calculated(fakeChain({ currentRootEOA: A }).reader);
    await finalize(id1);

    // The leaf really is A's, and A really can be proved against the live root.
    const liveA = await chainAt(id1, A);
    const beforeRotation = await buildClaimProof(ROOT_ID, liveA.reader);
    assert.equal(beforeRotation.status, "CLAIMABLE");
    assert.equal(
      (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: id1, userId: ROOT_ID }))!.externalEOA,
      A,
    );

    // 3-4. The contract rotates A -> B and the backend rebinds the logical root.
    const rotated = await chainAt(id1, B);
    assert.equal((await syncLogicalRootEOAFromChain(rotated.reader)).status, "REBOUND");

    // 5. A's leaf is still the live one, but the root now answers to B. The honest answer is a
    // plain state, NOT an internal error and NOT a proof for an address with no leaf.
    __clearProofCache();
    const during = await buildClaimProof(ROOT_ID, rotated.reader);
    assert.equal(during.status, "NOTHING_TO_CLAIM");
    assert.equal(during.claimable, false);
    assert.equal(during.status === "NOTHING_TO_CLAIM" && during.reason, "AWAITING_REBOUND_CHECKPOINT");

    // The entitlement is DEFERRED, not forfeited: the next checkpoint republishes the same
    // cumulative against B, and B claims the whole thing.
    await settleEpoch(41011);
    await mkTeam(ROOT_ID, 41011, 1n * E18);
    const id2 = await calculated(rotated.reader);
    await finalize(id2);

    const row2 = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: id2, userId: ROOT_ID }))!;
    assert.equal(row2.externalEOA, B, "36. future root entitlement publishes against B");
    assert.equal(row2.combinedCumulativeACF, (10n * E18).toString(), "the full carry-over, nothing dropped");

    __clearProofCache();
    const after = await buildClaimProof(ROOT_ID, (await chainAt(id2, B)).reader);
    assert.equal(after.status, "CLAIMABLE");
    assert.equal(after.status === "CLAIMABLE" && after.cumulativeSelfACF, "0");
    assert.equal(after.status === "CLAIMABLE" && after.cumulativeTeamACF, (10n * E18).toString());
    // So no alias login, no historical-root session and no special proof endpoint is needed:
    // there is nothing stranded for an old address to go and fetch.
  });

  it("34. no special historical-root access path was added anywhere", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // The audit concluded none is needed, so none exists. Asserted rather than assumed, because
    // a broad alias-login mechanism is exactly the dangerous thing not to grow here later.
    for (const file of ["proof.ts", "quote.ts", "receipt.ts", "routes.ts", "summary.ts"]) {
      const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
      for (const forbidden of [
        "historicalRoot", "isRootRewardAccount", "aliasLogin", "actAs", "impersonate",
        "previousRootEOA", "legacyRootEOA",
      ]) {
        assert.ok(!source.includes(forbidden), `settlement/${file} must not reference ${forbidden}`);
      }
    }
    const auth = await readFile(new URL("../auth/service.ts", import.meta.url), "utf8");
    for (const forbidden of ["aliasLogin", "actAs", "impersonate", "previousRootEOA", "legacyRootEOA"]) {
      assert.ok(!auth.includes(forbidden), `auth/service.ts must not reference ${forbidden}`);
    }
    // Auth DOES consult `isRootRewardAccount`, and must: it is how a historical ROOT is refused
    // an ordinary account. What matters is that the answer leads to a REFUSAL and never to a
    // session — reserving the address, not granting access through it.
    assert.match(auth, /isRootRewardAccount/);
    assert.match(auth, /HISTORICAL_ROOT_EOA_RESERVED/);
    assert.match(
      auth, /throw new HttpError\(\s*409,\s*"HISTORICAL_ROOT_EOA_RESERVED"/,
      "a historical ROOT must be REFUSED, so the code must throw on it rather than branch",
    );
  });

  it("28, 37. historical rows are never rewritten by a rebind", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await rootWithEntitlement(9n * E18, 41010);
    const id1 = await calculated(fakeChain({ currentRootEOA: A }).reader);
    await finalize(id1);

    const historicalRows = await UserRewardCheckpoint.find({ ...SETTLE }, { __v: 0 }).sort({ userId: 1 }).lean();
    const historicalTeam = await TeamRewardEntry.find({}, { __v: 0 }).sort({ epochId: 1 }).lean();

    await syncLogicalRootEOAFromChain((await chainAt(id1, B)).reader);

    // The published leaf, its hash and its cumulative stay exactly as finalized — they describe
    // a root the contract has already accepted, and the amounts A may still have drawn against.
    assert.deepEqual(
      await UserRewardCheckpoint.find({ ...SETTLE }, { __v: 0 }).sort({ userId: 1 }).lean(),
      historicalRows,
    );
    assert.deepEqual(await TeamRewardEntry.find({}, { __v: 0 }).sort({ epochId: 1 }).lean(), historicalTeam);
  });
});

describe("rotation after the outgoing ROOT has already claimed", () => {
  it("carries the cumulative forward onto B, so only the delta above A's draw is claimable", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await rootWithEntitlement(9n * E18, 41010);
    const id1 = await calculated(fakeChain({ currentRootEOA: A }).reader);
    await finalize(id1);

    // A drew its full 9, then ROOT rotated. This is the case the previous milestone refused: it
    // is safe now because the contract keeps ONE watermark for every ROOT EOA, so B reads A's 9
    // and can only draw above it.
    await settleEpoch(41011);
    await mkTeam(ROOT_ID, 41011, 1n * E18);
    const chain = await chainAt(id1, B, { rootClaimed: 9n * E18 });

    const id2 = await calculated(chain.reader);
    await finalize(id2);

    // Same logical user, now answering to B, with the cumulative NEVER reset.
    const root = (await User.findOne({ userId: ROOT_ID }))!;
    assert.equal(root.externalEOA, B);
    const row = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: id2, userId: ROOT_ID }))!;
    assert.equal(row.externalEOA, B, "the new leaf is keyed to B");
    assert.equal(
      row.combinedCumulativeACF, (10n * E18).toString(),
      "the published cumulative carried forward: 10, not 1 and not 0",
    );

    // And the claimable amount is the DELTA. The shared watermark is what makes it 1 rather
    // than the whole 10.
    __clearProofCache();
    const after = await chainAt(id2, B, { rootClaimed: 9n * E18 });
    const proof = await buildClaimProof(ROOT_ID, after.reader);
    assert.equal(proof.status, "CLAIMABLE");
    assert.equal(proof.status === "CLAIMABLE" && proof.alreadyClaimedACF, (9n * E18).toString());
    assert.equal(
      proof.status === "CLAIMABLE" &&
        BigInt(proof.cumulativeSelfACF) + BigInt(proof.cumulativeTeamACF) - BigInt(proof.alreadyClaimedACF),
      1n * E18,
    );
  });

  it("carries one watermark across TWO rotations, never resetting the cumulative", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // A: 10 claimed. B: 15 claimed. C: 21 published. The backend's cumulative only ever rises.
    await rootWithEntitlement(10n * E18, 41010);
    const id1 = await calculated(fakeChain({ currentRootEOA: A }).reader);
    await finalize(id1);

    await settleEpoch(41011);
    await mkTeam(ROOT_ID, 41011, 5n * E18);
    const id2 = await calculated((await chainAt(id1, B, { rootClaimed: 10n * E18 })).reader);
    await finalize(id2);

    await settleEpoch(41012);
    await mkTeam(ROOT_ID, 41012, 6n * E18);
    const id3 = await calculated(
      (await chainAt(id2, C, { rootClaimed: 15n * E18, historicalRoots: [A, B] })).reader,
    );
    await finalize(id3);

    const cumulatives = await Promise.all([id1, id2, id3].map(async (id) =>
      (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: id, userId: ROOT_ID }))!.combinedCumulativeACF));
    assert.deepEqual(
      cumulatives, [(10n * E18).toString(), (15n * E18).toString(), (21n * E18).toString()],
      "10 -> 15 -> 21, never reset and never restarted per address",
    );

    // One logical user throughout, with one userId and one referral code.
    const roots = await User.find({ referredByUserId: null }).lean();
    assert.equal(roots.length, 1);
    assert.equal(roots[0]!.userId, ROOT_ID);
    assert.equal(roots[0]!.externalEOA, C);
  });

  it("refuses when the contract does NOT share one watermark between the two ROOT accounts", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await rootWithEntitlement(9n * E18, 41010);
    const id1 = await calculated(fakeChain({ currentRootEOA: A }).reader);
    await finalize(id1);
    await settleEpoch(41011);
    await mkTeam(ROOT_ID, 41011, 1n * E18);

    // A deployment that still keyed the watermark PER ADDRESS: A reports 9, B reports 0. Carrying
    // the cumulative forward there would release A's 9 a second time, so the checkpoint aborts.
    const chain = await chainAt(id1, B, { rootClaimed: 9n * E18 });
    const perAddress = {
      ...chain.reader,
      async alreadyClaimed(wallets: string[]) {
        return new Map(wallets.map((w) => [w.toLowerCase(), w.toLowerCase() === A ? 9n * E18 : 0n]));
      },
    };

    await assert.rejects(calculateSettlementCheckpoint(perAddress), /must share one claim watermark/);
    assert.equal(await RewardSettlementCheckpoint.countDocuments({ ...SETTLE, checkpointId: id1 + 1 }), 0);
  });

  it("refuses when the contract does not recognize the incoming ROOT as root-routed", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await rootWithEntitlement(9n * E18, 41010);
    const id1 = await calculated(fakeChain({ currentRootEOA: A }).reader);
    await finalize(id1);
    await settleEpoch(41011);
    await mkTeam(ROOT_ID, 41011, 1n * E18);

    // If the incoming ROOT is not flagged, its reward would be paid DIRECTLY rather than split
    // among the partners — the exact bypass the splitting exists to prevent.
    const chain = await chainAt(id1, B);
    const unflagged = {
      ...chain.reader,
      async isRootRewardAccount(address: string) { return address.toLowerCase() === A; },
    };

    await assert.rejects(calculateSettlementCheckpoint(unflagged), /does not recognize/);
    assert.equal(await RewardSettlementCheckpoint.countDocuments({ ...SETTLE, checkpointId: id1 + 1 }), 0);
  });

  it("still refuses an address change for any ordinary user", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await rootWithEntitlement(9n * E18, 41010);
    await mkTeam("u1", 41010, 2n * E18);
    const id1 = await calculated(fakeChain({ currentRootEOA: A }).reader);
    await finalize(id1);

    // An ordinary user's published identity is still absolutely immutable. Only the logical root
    // is exempt, and only under the conditions above.
    await User.collection.updateOne({ userId: "u1" }, { $set: { externalEOA: wallet(0xdead) } });
    await settleEpoch(41011);
    await mkTeam(ROOT_ID, 41011, 1n * E18);
    await assert.rejects(
      calculateSettlementCheckpoint((await chainAt(id1, A)).reader),
      /is not the logical referral root/,
    );
  });

  it("repairs a binding that drifted out of band, instead of publishing it", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await rootWithEntitlement(9n * E18, 41010);
    const id1 = await calculated(fakeChain({ currentRootEOA: A }).reader);
    await finalize(id1);

    // The stored binding was moved to B by something other than the sync service, while the
    // contract still says A. Because settlement synchronizes from the chain BEFORE keying
    // anything to an address, the drift is corrected rather than published — the contract is the
    // authority in both directions, not just forwards.
    await User.collection.updateOne({ userId: ROOT_ID }, { $set: { externalEOA: B } });
    await settleEpoch(41011);
    await mkTeam(ROOT_ID, 41011, 1n * E18);

    const id2 = await calculated((await chainAt(id1, A)).reader);
    assert.equal((await User.findOne({ userId: ROOT_ID }))!.externalEOA, A, "pulled back to the chain's ROOT");
    const row = (await UserRewardCheckpoint.findOne({ ...SETTLE, checkpointId: id2, userId: ROOT_ID }))!;
    assert.equal(row.externalEOA, A, "and the leaf is published against the address the contract names");
  });
});

describe("43-45. reward values are unchanged by a rotation; only the beneficiary moves", () => {
  it("publishes the identical arithmetic against B that it would have against A", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Settle the same two epochs twice: once with no rotation, once with one in between. The
    // amounts must be identical — a rotation changes WHO is paid, never HOW MUCH.
    const run = async (rotate: boolean) => {
      await Promise.all([
        User.deleteMany({}), TeamRewardEntry.deleteMany({}), RewardEpoch.deleteMany({}),
        RewardPhase2Epoch.deleteMany({}), RewardSettlementCheckpoint.deleteMany({}),
        UserRewardCheckpoint.deleteMany({}), CheckpointSelfComponent.deleteMany({}),
      ]);
      __clearProofCache();
      await rootWithEntitlement(9n * E18, 41010);
      const id1 = await calculated(fakeChain({ currentRootEOA: A }).reader);
      await finalize(id1);
      if (rotate) await syncLogicalRootEOAFromChain((await chainAt(id1, B)).reader);
      await settleEpoch(41011);
      await mkTeam(ROOT_ID, 41011, 1n * E18);
      const id2 = await calculated((await chainAt(id1, rotate ? B : A)).reader);
      const cp = await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: id2 }).lean();
      const row = await UserRewardCheckpoint.findOne({
        ...SETTLE, checkpointId: id2, userId: ROOT_ID,
      }).lean();
      return {
        total: cp!.publishedCumulativeTotalACF,
        delta: cp!.publishedDeltaACF,
        self: row!.cumulativeSelfACF,
        team: row!.cumulativeTeamACF,
        combined: row!.combinedCumulativeACF,
        eoa: row!.externalEOA,
      };
    };

    const straight = await run(false);
    const rotated = await run(true);

    assert.equal(rotated.eoa, B);
    assert.equal(straight.eoa, A);
    // Every financial figure is identical; only the address differs.
    assert.deepEqual(
      { ...rotated, eoa: undefined },
      { ...straight, eoa: undefined },
      "45. formulas and values apart from the beneficiary EOA are unchanged",
    );
  });
});

describe("46-50. claim reconciliation never assumes a ROOT balance delta", () => {
  it("reconciles from alreadyClaimed alone, whatever the claimant's ACF balance did", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await rootWithEntitlement(9n * E18, 41010);
    const id1 = await calculated(fakeChain({ currentRootEOA: A }).reader);
    await finalize(id1);

    // 47-49: the ROOT claimed its full 9. The splitter may have sent ROOT 0% of it, or 40% of it
    // if ROOT happens to be one of the immutable partners — the backend is told neither and needs
    // neither. The watermark is `alreadyClaimed`, which is identical in both worlds.
    const chain = await chainAt(id1, A, { rootClaimed: 9n * E18 });
    await reconcileClaimStates(chain.reader);

    const state = await UserClaimState.findOne({ ...SETTLE, userId: ROOT_ID }).lean();
    assert.equal(state!.alreadyClaimedACF, (9n * E18).toString());

    // 46: an ordinary claimant reconciles by exactly the same rule.
    __clearProofCache();
    const proof = await buildClaimProof(ROOT_ID, chain.reader);
    assert.equal(proof.status, "NOTHING_TO_CLAIM");
    assert.equal(proof.status === "NOTHING_TO_CLAIM" && proof.reason, "FULLY_CLAIMED");
  });

  it("50. an unmatched on-chain claimed amount is still rejected, not rounded to fit", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await rootWithEntitlement(9n * E18, 41010);
    const id1 = await calculated(fakeChain({ currentRootEOA: A }).reader);
    await finalize(id1);

    // A figure that matches no published cumulative cannot be explained by partner routing or by
    // anything else; it means the backend's published history and the chain disagree.
    await assert.rejects(
      reconcileClaimStates((await chainAt(id1, A, { rootClaimed: 7n * E18 })).reader),
      ClaimReconciliationError,
    );
  });

  it("reads no claimant ACF balance anywhere in the claim path", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    // Source-asserted, following receipt.guard.test.ts: `recordClaimReceipt` reaches a
    // module-level publicClient, so the balance-free property is pinned here rather than
    // exercised. The only ACF balanceOf in settlement is the TREASURY's funding capacity.
    for (const file of ["receipt.ts", "reconcile.ts", "proof.ts", "summary.ts", "quote.ts"]) {
      const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(source, /balanceOf/, `settlement/${file} must not read a token balance`);
    }
    // 40-41: and no partner maths or partner transfers were brought into the backend.
    //
    // These are tokens that could ONLY come from reproducing the split — its state, its event or
    // its denominator. The bare words "splitter" and "partner" are deliberately NOT on the list:
    // they appear in comments and diagnostic messages that explain why the backend stays out of
    // the distribution, which is the opposite of a violation. The rule is about logic.
    for (const file of ["receipt.ts", "reconcile.ts", "proof.ts", "checkpoint.ts", "chain.ts"]) {
      const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
      for (const forbidden of [
        "sharesBps", "TOTAL_SHARE_BPS", "RootRewardSharePaid", "RootRewardDistributed",
        "recipientCount", "distributionAt", "distribute(", "10_000", "10000n",
      ]) {
        assert.ok(!source.includes(forbidden), `settlement/${file} must not reference ${forbidden}`);
      }
    }
  });
});
