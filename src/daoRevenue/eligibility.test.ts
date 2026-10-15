import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contributionActiveAtSnapshot, type ActivityInput } from "./eligibility.ts";
import { DAORevenueInvariantError } from "./policy.ts";

const WALLET = "0xf1967e700575cd8c6a7eaa593e7da470850f6a15";
const SNAPSHOT = 1_772_000_000;

/** A contribution whose linked DAO stake existed and was active at the snapshot. */
const base = (over: Partial<ActivityInput> = {}): ActivityInput => ({
  contributionId: "1",
  stakeId: "8",
  contributionBeneficiary: WALLET,
  stakeTimestamp: SNAPSHOT - 86_400,
  stakeExternalEOA: WALLET,
  stakeSource: "DAO",
  entry: {
    source: "DAO", rewardEligible: true, ineligibleReason: null, externalEOA: WALLET,
  },
  withdrawnBlockTimestamp: null,
  ...over,
});

describe("active at snapshot", () => {
  it("1. an active, eligible DAO stake counts", () => {
    assert.deepEqual(contributionActiveAtSnapshot(base(), SNAPSHOT), { active: true });
  });

  it("2. MATURED but unwithdrawn still counts — maturity never ends participation", () => {
    // Maturity is unrepresentable in Phase 1's verdict by design; an eligible entry IS matured
    // or not, and either way the principal is still committed.
    assert.deepEqual(
      contributionActiveAtSnapshot(
        base({ stakeTimestamp: SNAPSHOT - 750 * 86_400 }), SNAPSHOT,
      ),
      { active: true },
    );
  });
});

describe("the TOO_YOUNG boundary — the locked correction", () => {
  const tooYoung = {
    source: "DAO", rewardEligible: false, ineligibleReason: "TOO_YOUNG",
    externalEOA: WALLET,
  };

  it("3. TOO_YOUNG with the stake already in existence IS active", () => {
    assert.deepEqual(
      contributionActiveAtSnapshot(
        base({ entry: tooYoung, stakeTimestamp: SNAPSHOT - 3_600 }), SNAPSHOT,
      ),
      { active: true },
    );
  });

  it("4. TOO_YOUNG at exactly the snapshot second IS active", () => {
    assert.deepEqual(
      contributionActiveAtSnapshot(
        base({ entry: tooYoung, stakeTimestamp: SNAPSHOT }), SNAPSHOT,
      ),
      { active: true },
    );
  });

  it("5. TOO_YOUNG one second AFTER the snapshot is EXCLUDED, not active", () => {
    // Without the stakeTimestamp test this would be paid, for an epoch that closed before the
    // member contributed. Phase 1 uses TOO_YOUNG for "did not exist yet" as well.
    assert.deepEqual(
      contributionActiveAtSnapshot(
        base({ entry: tooYoung, stakeTimestamp: SNAPSHOT + 1 }), SNAPSHOT,
      ),
      { active: false, reason: "NOT_YET_CONTRIBUTED" },
    );
  });

  it("6. a stake created after the snapshot with NO entry is excluded, not an error", () => {
    assert.deepEqual(
      contributionActiveAtSnapshot(
        base({ entry: null, stakeTimestamp: SNAPSHOT + 1 }), SNAPSHOT,
      ),
      { active: false, reason: "NOT_YET_CONTRIBUTED" },
    );
  });
});

describe("withdrawal", () => {
  const withdrawn = {
    source: "DAO", rewardEligible: false, ineligibleReason: "WITHDRAWN",
    externalEOA: WALLET,
  };

  it("7. WITHDRAWN at the snapshot is excluded", () => {
    assert.deepEqual(
      contributionActiveAtSnapshot(base({ entry: withdrawn }), SNAPSHOT),
      { active: false, reason: "WITHDRAWN_AT_OR_BEFORE_SNAPSHOT" },
    );
  });

  it("8. withdrawn BEFORE the snapshot is excluded, and the cross-check agrees", () => {
    assert.deepEqual(
      contributionActiveAtSnapshot(
        base({ entry: withdrawn, withdrawnBlockTimestamp: SNAPSHOT - 10 }), SNAPSHOT,
      ),
      { active: false, reason: "WITHDRAWN_AT_OR_BEFORE_SNAPSHOT" },
    );
  });

  it("9. withdrawn EXACTLY at the snapshot is excluded", () => {
    assert.deepEqual(
      contributionActiveAtSnapshot(
        base({ entry: withdrawn, withdrawnBlockTimestamp: SNAPSHOT }), SNAPSHOT,
      ),
      { active: false, reason: "WITHDRAWN_AT_OR_BEFORE_SNAPSHOT" },
    );
  });

  it("10. withdrawn AFTER the snapshot still counts for this epoch", () => {
    assert.deepEqual(
      contributionActiveAtSnapshot(
        base({ withdrawnBlockTimestamp: SNAPSHOT + 1 }), SNAPSHOT,
      ),
      { active: true },
    );
  });

  it("11. a NULL withdrawal boundary is not treated as evidence of activity", () => {
    // The Phase 1 backfill that recovers it is best-effort and bounded, so WITHDRAWN with a
    // null boundary is normal and must still exclude.
    assert.deepEqual(
      contributionActiveAtSnapshot(
        base({ entry: withdrawn, withdrawnBlockTimestamp: null }), SNAPSHOT,
      ),
      { active: false, reason: "WITHDRAWN_AT_OR_BEFORE_SNAPSHOT" },
    );
  });

  it("12. entry says active but the boundary proves otherwise — FAIL, never guess", () => {
    assert.throws(
      () => contributionActiveAtSnapshot(
        base({ withdrawnBlockTimestamp: SNAPSHOT - 10 }), SNAPSHOT,
      ),
      (e: unknown) => e instanceof DAORevenueInvariantError
        && /disagrees about epoch snapshot/.test((e as Error).message),
    );
  });

  it("13. entry says WITHDRAWN but the boundary is later — FAIL", () => {
    assert.throws(
      () => contributionActiveAtSnapshot(
        base({ entry: withdrawn, withdrawnBlockTimestamp: SNAPSHOT + 10 }), SNAPSHOT,
      ),
      DAORevenueInvariantError,
    );
  });
});

describe("integrity, where silence would be dangerous", () => {
  it("14. a missing Phase 1 entry for an existing stake FAILS", () => {
    assert.throws(
      () => contributionActiveAtSnapshot(base({ entry: null }), SNAPSHOT),
      (e: unknown) => e instanceof DAORevenueInvariantError
        && /no Phase 1 reward entry exists/.test((e as Error).message),
    );
  });

  it("15. a non-DAO linked stake FAILS rather than being weighted", () => {
    assert.throws(
      () => contributionActiveAtSnapshot(base({ stakeSource: "DIRECT" }), SNAPSHOT),
      (e: unknown) => /whose source is DIRECT, not DAO/.test((e as Error).message),
    );
  });

  it("16. a beneficiary mismatch between contribution and stake FAILS", () => {
    assert.throws(
      () => contributionActiveAtSnapshot(
        base({ stakeExternalEOA: `0x${"9".repeat(40)}` }), SNAPSHOT,
      ),
      (e: unknown) => /does not match stake/.test((e as Error).message),
    );
  });

  it("17. a Phase 1 entry recording a different source FAILS", () => {
    assert.throws(
      () => contributionActiveAtSnapshot(
        base({
          entry: {
            source: "BOND", rewardEligible: true, ineligibleReason: null,
            externalEOA: WALLET,
          },
        }),
        SNAPSHOT,
      ),
      (e: unknown) => /records source BOND, not DAO/.test((e as Error).message),
    );
  });

  it("18. a Phase 1 entry recording a different beneficiary FAILS", () => {
    assert.throws(
      () => contributionActiveAtSnapshot(
        base({
          entry: {
            source: "DAO", rewardEligible: true, ineligibleReason: null,
            externalEOA: `0x${"7".repeat(40)}`,
          },
        }),
        SNAPSHOT,
      ),
      (e: unknown) => /records beneficiary/.test((e as Error).message),
    );
  });

  it("19. identity is checked BEFORE existence, so a bad link cannot hide behind a date", () => {
    // A post-snapshot stake with the wrong source must still fail loudly rather than being
    // quietly excluded as "not yet contributed".
    assert.throws(
      () => contributionActiveAtSnapshot(
        base({ stakeSource: "DIRECT", stakeTimestamp: SNAPSHOT + 1, entry: null }), SNAPSHOT,
      ),
      DAORevenueInvariantError,
    );
  });
});
