import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/**
 * Guards for two defects that made POST /rewards/claim-receipt impossible to satisfy.
 *
 * Both were found by an actual claim on Amoy — transaction
 * 0xc0ba677ca571992e3351d759caa8e2b6cd1e67688c9db2048a088b4bca576e3f, which succeeded on chain
 * and then could not be recorded. Neither had a test, which is why both shipped.
 *
 * These assert the source rather than the behaviour: `recordClaimReceipt` reads a module-level
 * publicClient, so exercising it needs an injectable chain client. That refactor is worth doing;
 * until then these pin the exact regressions.
 */

const read = (path: string) => readFileSync(new URL(`./${path}`, import.meta.url), "utf8");

describe("claim receipt verification", () => {
  it("1. does not gate on the transaction's `to` address", () => {
    const source = read("receipt.ts");
    // The original defect: requiring `to` to equal the Withdrawal rejected every legitimate
    // claim, because claims were wrapped and `to` was the wrapper. A direct claim does target
    // the Withdrawal, but the guard stays off: the event-provenance check below is strictly
    // stronger, and a user routing their own claim through a contract still satisfies it.
    assert.doesNotMatch(source, /WRONG_CONTRACT/);
    assert.doesNotMatch(source, /receipt\.to/);
  });

  it("2. still binds the claim to the contract and to the user", () => {
    const source = read("receipt.ts");
    // What actually proves provenance: the event must have been emitted BY the Withdrawal,
    // and its beneficiary must be this user's own address.
    assert.match(source, /log\.address\.toLowerCase\(\) !== settle\.withdrawalAddress/);
    assert.match(source, /NO_CLAIM_EVENT/);
    assert.match(source, /beneficiary !== claimant/);
    assert.match(source, /NOT_YOUR_CLAIM/);
    // And the event's cumulative must still match what the chain reports as claimed.
    assert.match(source, /CLAIM_SUPERSEDED/);
  });

  it("3. resolves a checkpoint finalized before the block was recorded", () => {
    const source = read("receipt.ts");
    // Nothing populated finalizedBlockNumber, so `$ne: null` matched nothing and every claim
    // failed with CHECKPOINT_UNRESOLVED. A null is now allowed through to the value match.
    assert.doesNotMatch(source, /finalizedBlockNumber: \{ \$ne: null/);
    assert.match(source, /\{ finalizedBlockNumber: null \}/);
    assert.match(source, /finalizedBlockNumber: \{ \$lte: Number\(receipt\.blockNumber\) \}/);
  });

  it("4. the executor records the block a root went live in", () => {
    const source = read("executor.ts");
    // The root cause of (3): the field existed and was read, but written by nobody.
    assert.match(source, /finalizedBlockNumber: Number\(receipt\.blockNumber\)/);
    assert.match(source, /RewardSettlementCheckpoint\.updateOne/);
  });

  it("5. the field is still declared on the model", () => {
    const model = readFileSync(
      new URL("../models/RewardSettlementCheckpoint.ts", import.meta.url), "utf8",
    );
    assert.match(model, /finalizedBlockNumber/);
  });
});
