import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import {
  assertDisposable, fakeChain, TEST_STAKING, TEST_TREASURY, TEST_WITHDRAWAL,
} from "./testenv.ts";

/**
 * PHASE 3 AUTHORIZE -> EXECUTE (audit finding C-01), on the backend side.
 *
 * The contracts make the split real; these tests cover the operator machinery around it:
 *
 *   - the authorizer commits figures it REDERIVES from the persisted checkpoint, never from a
 *     CLI argument;
 *   - it is idempotent against chain state, so a crash between a confirmed transaction and the
 *     database write costs a re-read and nothing else;
 *   - a chain commitment that disagrees with what was calculated FAILS LOUDLY, because that
 *     commitment is immutable and the database is not the authority;
 *   - the executor cannot act on a checkpoint that has no commitment.
 *
 * Every chain read goes through the fake reader, so nothing here needs an RPC endpoint.
 */

const TEST_URI = process.env.MONGODB_TEST_URI;

const {
  authorizePreflight, authorizeSettlementCheckpoint, nextAuthorizableCheckpoint, AUTHORIZABLE,
} = await import("./authorize.js");
const { EXECUTABLE, nextExecutableCheckpoint } = await import("./executor.js");
const { reconcileSettlementCheckpoint } = await import("./reconcile.js");
const { SettlementInvariantError } = await import("./policy.js");
const { buildSettlementTree } = await import("./merkle.js");
const { RewardSettlementCheckpoint } = await import("../models/RewardSettlementCheckpoint.js");

const E18 = 10n ** 18n;
const LOW = TEST_STAKING.toLowerCase();
const WD = TEST_WITHDRAWAL.toLowerCase();
const SETTLE = { chainId: 80002, withdrawalAddress: WD };

const EOA = `0x${"c01".padStart(40, "0")}`.toLowerCase();
const PREVIOUS_TOTAL = 5n * E18;
const DELTA = 4n * E18;
const NEW_TOTAL = PREVIOUS_TOTAL + DELTA;
const ROOT = buildSettlementTree([{
  externalEOA: EOA, cumulativeSelfACF: NEW_TOTAL, cumulativeTeamACF: 0n,
}]).root;

const PREVIOUS_ID = 100;
const ID = 101;

let connected = false;
before(async () => {
  if (!TEST_URI) { console.log("SKIP: MONGODB_TEST_URI not set"); return; }
  await mongoose.connect(assertDisposable(TEST_URI), { serverSelectionTimeoutMS: 8000 });
  await RewardSettlementCheckpoint.init();
  connected = true;
});
after(async () => { if (connected) await mongoose.disconnect(); });
beforeEach(async () => {
  if (connected) await RewardSettlementCheckpoint.deleteMany({});
});

/** A finalized predecessor plus one CALCULATED checkpoint waiting to be committed. */
async function seed(status = "CALCULATED") {
  const common = {
    chainId: 80002, stakingContractAddress: LOW, withdrawalAddress: WD,
    treasuryAddress: TEST_TREASURY.toLowerCase(), legacy: false,
    fromRewardEpochId: null, throughRewardEpochId: null,
    leafCount: 1, totalNewTeamACF: "0",
    totalDeferredReleasedSelfACF: "0", totalDeferredReleasedTeamACF: "0",
    attempts: 1, leaseExpiresAt: null, lastError: null, auditWarning: null,
    authorizationTxHash: null, authorizationBlockNumber: null, authorizedAt: null,
    createdAt: new Date(1), updatedAt: new Date(1),
  };
  await RewardSettlementCheckpoint.collection.insertOne({
    ...common, checkpointId: PREVIOUS_ID, status: "FINALIZED", previousCheckpointId: null,
    root: `0x${"1".repeat(64)}`,
    publishedCumulativeTotalACF: PREVIOUS_TOTAL.toString(),
    publishedDeltaACF: PREVIOUS_TOTAL.toString(),
    totalNewSelfACF: PREVIOUS_TOTAL.toString(),
  } as never);
  await RewardSettlementCheckpoint.collection.insertOne({
    ...common, checkpointId: ID, status, previousCheckpointId: PREVIOUS_ID,
    root: ROOT,
    publishedCumulativeTotalACF: NEW_TOTAL.toString(),
    publishedDeltaACF: DELTA.toString(),
    totalNewSelfACF: DELTA.toString(),
  } as never);
}

/**
 * The normal state of the world: the Withdrawal is bound, the authorizer holds its own role, and
 * it does NOT relay. The fake defaults the executor roles to true because most suites probe the
 * executor; here the address under test is the authorizer, so it must hold neither.
 */
const live = () => fakeChain({
  cumulativeTotal: PREVIOUS_TOTAL, latestEpochId: PREVIOUS_ID,
  executorRoles: { treasury: false, withdrawal: false },
});

describe("Phase 3 authorization", () => {
  it("1. derives the commitment from the persisted checkpoint, not from any argument", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seed();
    const r = await authorizePreflight(ID, live().reader, "0x00000000000000000000000000000000000000a1");
    assert.deepEqual(r.blockers, []);
    assert.equal(r.root, ROOT);
    assert.equal(r.cumulativeTotalACF, NEW_TOTAL.toString());
    // The funding amount IS the published delta. Nothing about it is operator-supplied.
    assert.equal(r.fundingAmountACF, DELTA.toString());
    assert.equal(r.alreadyAuthorized, false);
    assert.equal(r.authorizerHasRole, true);
    assert.deepEqual(r.plannedCalls, [
      `Withdrawal.authorizeRewardEpoch(${ID}, ${ROOT}, ${NEW_TOTAL}, ${DELTA})`,
    ]);
    // And the authorize command cannot take --root/--amount/--total at all.
    const cli = await readFile(new URL("../../scripts/run-settlement-authorizer.ts", import.meta.url), "utf8");
    for (const flag of ["--root", "--amount", "--total", "--funding"]) {
      assert.doesNotMatch(cli, new RegExp(flag.replace(/-/g, "\\-")));
    }
  });

  it("2. refuses a commitment whose arithmetic does not close", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seed();
    // previous total + delta must equal the new total. The contract does not police this, so the
    // backend must, before the figures become immutable.
    await RewardSettlementCheckpoint.collection.updateOne(
      { ...SETTLE, checkpointId: ID }, { $set: { publishedDeltaACF: (DELTA + 1n).toString() } },
    );
    await assert.rejects(
      authorizePreflight(ID, live().reader),
      (error: Error) => error instanceof SettlementInvariantError
        && /internally inconsistent/.test(error.message),
    );
  });

  it("3. refuses an authorizer that can also relay, and one without the role", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seed();
    const collapsed = fakeChain({
      cumulativeTotal: PREVIOUS_TOTAL, latestEpochId: PREVIOUS_ID,
      executorRoles: { treasury: true, withdrawal: true },
    });
    const r = await authorizePreflight(ID, collapsed.reader, "0x00000000000000000000000000000000000000a1");
    assert.equal(r.blockers.length, 1);
    assert.match(r.blockers[0]!, /must not both commit a settlement and relay it/);

    const roleless = fakeChain({
      cumulativeTotal: PREVIOUS_TOTAL, latestEpochId: PREVIOUS_ID,
      rewardAuthorizerRole: false, executorRoles: { treasury: false, withdrawal: false },
    });
    const s = await authorizePreflight(ID, roleless.reader, "0x00000000000000000000000000000000000000a1");
    assert.equal(s.blockers.length, 1);
    assert.match(s.blockers[0]!, /lacks REWARD_AUTHORIZER_ROLE/);
  });

  it("4. refuses to commit when the Withdrawal is not bound to canonical Treasury", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seed();
    // An unbound Withdrawal cannot register funding, so committing would create an epoch nobody
    // can fund — and the commitment would be permanent.
    const unbound = fakeChain({
      cumulativeTotal: PREVIOUS_TOTAL, latestEpochId: PREVIOUS_ID,
      withdrawalTreasuryBinding: `0x${"0".repeat(40)}`,
    });
    const r = await authorizePreflight(ID, unbound.reader);
    assert.equal(r.blockers.length, 1);
    assert.match(r.blockers[0]!, /not the configured Treasury/);
  });

  it("5. accepts an identical on-chain commitment as done, and plans nothing", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seed();
    const chain = live();
    chain.authorize(ID, ROOT, NEW_TOTAL, DELTA);
    const r = await authorizePreflight(ID, chain.reader);
    assert.deepEqual(r.blockers, []);
    assert.equal(r.alreadyAuthorized, true);
    assert.equal(r.commitmentMatches, true);
    assert.deepEqual(r.plannedCalls, []);
  });

  it("6. FAILS LOUDLY when the chain holds a different commitment", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seed();
    for (const wrong of [
      { root: `0x${"9".repeat(64)}`, total: NEW_TOTAL, funding: DELTA },
      { root: ROOT, total: NEW_TOTAL + 1n, funding: DELTA },
      { root: ROOT, total: NEW_TOTAL, funding: DELTA + 1n },
    ]) {
      const chain = live();
      chain.authorize(ID, wrong.root, wrong.total, wrong.funding);
      const r = await authorizePreflight(ID, chain.reader);
      assert.equal(r.commitmentMatches, false);
      assert.equal(r.blockers.length, 1);
      assert.match(r.blockers[0]!, /DIFFERENT commitment/);
      // Immutable: it is never corrected by authorizing again.
      await assert.rejects(
        authorizeSettlementCheckpoint(ID, { reader: chain.reader }),
        (error: Error) => /Refusing to authorize/.test(error.message)
          || /authorizer key/.test(error.message),
      );
    }
  });

  it("7. refuses a decreasing cumulative total, as the contract would", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seed();
    // Another settlement landed in between and published a higher total.
    const ahead = fakeChain({ cumulativeTotal: NEW_TOTAL + E18, latestEpochId: PREVIOUS_ID + 5 });
    const r = await authorizePreflight(ID, ahead.reader);
    assert.ok(r.blockers.some((b) => /refuses a decrease/.test(b)));

    const claimed = fakeChain({ cumulativeTotal: 0n, totalClaimed: NEW_TOTAL + E18 });
    const s = await authorizePreflight(ID, claimed.reader);
    assert.ok(s.blockers.some((b) => /already claimed/.test(b)));
  });

  it("8. refuses a checkpoint already finalized on chain", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seed();
    const chain = live();
    chain.state.finalized.add(ID);
    const r = await authorizePreflight(ID, chain.reader);
    assert.ok(r.blockers.some((b) => /already finalized/.test(b)));
  });

  it("9. reconciles CALCULATED -> AUTHORIZED from chain evidence alone", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seed();
    const chain = live();
    chain.authorize(ID, ROOT, NEW_TOTAL, DELTA);
    const r = await reconcileSettlementCheckpoint(chain.reader);
    assert.equal(r?.statusBefore, "CALCULATED");
    assert.equal(r?.statusAfter, "AUTHORIZED");
    // Financially complete, audit-incomplete: an operator authorized out of band.
    assert.match(r!.auditWarning!, /Authorization confirmed on chain/);
    const row = await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: ID }).lean();
    assert.equal(row!.status, "AUTHORIZED");
    assert.ok(row!.authorizedAt);
  });

  it("10. reconciliation throws when the chain commitment is not this checkpoint's", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seed();
    const chain = live();
    chain.authorize(ID, `0x${"9".repeat(64)}`, NEW_TOTAL, DELTA);
    // Adopting it would mean serving proofs against a tree the backend never built.
    await assert.rejects(reconcileSettlementCheckpoint(chain.reader), /authorized on chain with root/);
    const row = await RewardSettlementCheckpoint.findOne({ ...SETTLE, checkpointId: ID }).lean();
    assert.equal(row!.status, "CALCULATED");
  });

  it("11. leaves an unauthorized checkpoint invisible to the executor", async (t) => {
    if (!connected) return t.skip("no MONGODB_TEST_URI");
    await seed();
    // CALCULATED is authorizable but NOT executable: the executor has nothing it may relay.
    assert.deepEqual([...AUTHORIZABLE], ["CALCULATED"]);
    assert.equal(EXECUTABLE.includes("CALCULATED"), false);
    assert.equal(EXECUTABLE.includes("AUTHORIZED"), true);
    assert.equal(await nextAuthorizableCheckpoint(), ID);
    assert.equal(await nextExecutableCheckpoint(), null);

    await RewardSettlementCheckpoint.collection.updateOne(
      { ...SETTLE, checkpointId: ID }, { $set: { status: "AUTHORIZED" } },
    );
    assert.equal(await nextAuthorizableCheckpoint(), null);
    assert.equal(await nextExecutableCheckpoint(), ID);
  });

  it("12. keeps the authorize and execute paths on different keys and different calls", async () => {
    const authorize = await readFile(new URL("./authorize.ts", import.meta.url), "utf8");
    const executor = await readFile(new URL("./executor.ts", import.meta.url), "utf8");
    // The authorizer loads only the authorizing signer, and can encode only the commitment.
    assert.match(authorize, /loadRewardAuthorizerSigner/);
    assert.doesNotMatch(authorize, /loadEpochExecutorSigner/);
    assert.doesNotMatch(authorize, /fundRewardEpoch|finalizeEpoch/);
    // The executor loads only the relaying signer, and cannot ENCODE a commitment: its ABI holds
    // exactly two function entries, and neither is the authorizing call.
    assert.match(executor, /loadEpochExecutorSigner/);
    assert.doesNotMatch(executor, /loadRewardAuthorizerSigner|loadDAORevenueAuthorizerSigner/);
    assert.doesNotMatch(executor, /name: "authorizeRewardEpoch"/);
    assert.equal((executor.match(/type: "function", name: "/g) ?? []).length, 3); // + balanceOf
    // Neither relay call has room for a financial figure any more.
    assert.match(executor, /name: "fundRewardEpoch"[\s\S]*?inputs: \[\{ type: "uint256" \}\]/);
    assert.match(executor, /name: "finalizeEpoch"[\s\S]*?inputs: \[\{ type: "uint256" \}\]/);
  });

  it("13. never lets one process hold both keys", async () => {
    const signer = await readFile(new URL("../executor/signer.ts", import.meta.url), "utf8");
    // Both authorizer loaders refuse a key that is the executor's account.
    const refusals = signer.match(/EPOCH_EXECUTOR_PRIVATE_KEY are the same account/g) ?? [];
    assert.equal(refusals.length, 2);
    assert.match(signer, /export function loadRewardAuthorizerSigner/);
    // And the authorize entry point is a separate command from the executor's.
    const pkg = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts["settlement:authorize"], "tsx scripts/run-settlement-authorizer.ts");
    assert.equal(pkg.scripts["settlement:execute"], "tsx scripts/run-settlement-executor.ts");
    assert.notEqual(pkg.scripts["settlement:authorize"], pkg.scripts["settlement:execute"]);
  });
});
