import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DAO_DAILY_RATE, EPOCH_SECONDS, RATE_DENOMINATOR, completedEpochsSince, epochReward,
  isRewardEligible, latestCompletedEpochId, rateFor, snapshotAtOf, windowStartOf,
} from "./policy.ts";

const UTC = (s: string) => Math.floor(new Date(s).getTime() / 1000);
const E18 = 10n ** 18n;

describe("epoch boundaries", () => {
  it("1. an epoch settles the window that JUST COMPLETED", () => {
    // Running at 2026-10-03 12:00 UTC settles 00:00 -> 12:00, not 12:00 -> 24:00.
    const epochId = UTC("2026-10-03T12:00:00Z") / EPOCH_SECONDS;
    assert.equal(snapshotAtOf(epochId), UTC("2026-10-03T12:00:00Z"));
    assert.equal(windowStartOf(epochId), UTC("2026-10-03T00:00:00Z"));
  });

  it("2. every epochId lands exactly on 00:00 or 12:00 UTC", () => {
    for (let e = 41_000; e < 41_010; e++) {
      const d = new Date(snapshotAtOf(e) * 1000);
      assert.equal(d.getUTCMinutes(), 0);
      assert.equal(d.getUTCSeconds(), 0);
      assert.ok(d.getUTCHours() === 0 || d.getUTCHours() === 12, `${d.toISOString()}`);
    }
  });

  it("3. the same completed window always resolves to one epochId", () => {
    const at = UTC("2026-10-03T12:00:00Z");
    assert.equal(latestCompletedEpochId(at), at / EPOCH_SECONDS);
    // One second before the boundary, the window has NOT completed.
    assert.equal(latestCompletedEpochId(at - 1), at / EPOCH_SECONDS - 1);
  });

  it("4. catch-up enumerates missed epochs oldest first", () => {
    const from = UTC("2026-10-03T00:00:00Z") / EPOCH_SECONDS;
    const now = UTC("2026-10-04T12:00:00Z");
    assert.deepEqual(completedEpochsSince(from, now), [from, from + 1, from + 2, from + 3]);
  });

  it("5. nothing to do when no window has completed since activation", () => {
    const from = latestCompletedEpochId(UTC("2026-10-03T12:00:00Z")) + 1;
    assert.deepEqual(completedEpochsSince(from, UTC("2026-10-03T12:00:00Z")), []);
  });
});

describe("first reward eligibility", () => {
  const base = { source: "DIRECT" as const, active: true };

  it("6. a stake created at 03:00 is skipped at 12:00 and earns at the next 00:00", () => {
    const stakeTimestamp = UTC("2026-10-03T03:00:00Z");
    // 9 hours old
    assert.deepEqual(isRewardEligible({ ...base, stakeTimestamp }, UTC("2026-10-03T12:00:00Z")),
      { eligible: false, reason: "TOO_YOUNG" });
    // 21 hours old
    assert.deepEqual(isRewardEligible({ ...base, stakeTimestamp }, UTC("2026-10-04T00:00:00Z")),
      { eligible: true });
  });

  it("7. age is measured to snapshotAt, and exactly 12h qualifies", () => {
    const snapshotAt = UTC("2026-10-03T12:00:00Z");
    assert.equal(isRewardEligible({ ...base, stakeTimestamp: snapshotAt - EPOCH_SECONDS }, snapshotAt).eligible, true);
    assert.equal(isRewardEligible({ ...base, stakeTimestamp: snapshotAt - EPOCH_SECONDS + 1 }, snapshotAt).eligible, false);
  });
});

describe("maturity does NOT stop rewards", () => {
  // MATURITY / UNLOCK = the principal becomes withdrawable.
  // WITHDRAWAL        = the principal is taken back; only then does earning stop.
  const snapshotAt = UTC("2026-10-03T12:00:00Z");
  const old = snapshotAt - 100 * EPOCH_SECONDS;
  const SOURCES = ["DIRECT", "BOND", "DAO"] as const;

  it("8. an active stake earns before, at, and after maturity — every source", () => {
    for (const source of SOURCES) {
      for (const [label, unlock] of [
        ["before maturity", snapshotAt + 10 * EPOCH_SECONDS],
        ["exactly at maturity", snapshotAt],
        ["long after maturity", snapshotAt - 500 * EPOCH_SECONDS],
      ] as const) {
        assert.deepEqual(
          isRewardEligible({ source, active: true, stakeTimestamp: old }, snapshotAt),
          { eligible: true },
          `${source} ${label} (unlock ${unlock}) must keep earning while active`,
        );
      }
    }
  });

  it("9. a FLEXIBLE stake earns while active", () => {
    assert.deepEqual(
      isRewardEligible({ source: "DIRECT", active: true, stakeTimestamp: old }, snapshotAt),
      { eligible: true },
    );
  });

  it("10. eligibility does not depend on unlockTimestamp at all", () => {
    // The input type no longer accepts one. This test exists so that re-adding a maturity
    // boundary cannot pass review silently.
    const keys = Object.keys({ source: "DIRECT", active: true, stakeTimestamp: old });
    assert.deepEqual(keys.sort(), ["active", "source", "stakeTimestamp"]);
  });

  it("11. only WITHDRAWN and TOO_YOUNG can deny a reward", () => {
    // MATURED is no longer a reason, for any source.
    const reasons = new Set<string>();
    for (const source of SOURCES) {
      for (const active of [true, false]) {
        for (const ts of [old, snapshotAt]) {
          const v = isRewardEligible({ source, active, stakeTimestamp: ts }, snapshotAt);
          if (!v.eligible) reasons.add(v.reason);
        }
      }
    }
    assert.deepEqual([...reasons].sort(), ["TOO_YOUNG", "WITHDRAWN"]);
  });

  it("12. DAO keeps earning past its 750-day maturity while active", () => {
    assert.deepEqual(
      isRewardEligible({ source: "DAO", active: true, stakeTimestamp: old }, snapshotAt),
      { eligible: true },
    );
  });

  it("13. withdrawal is the ONLY thing that stops earning, every source", () => {
    for (const source of SOURCES) {
      assert.deepEqual(
        isRewardEligible({ source, active: false, stakeTimestamp: old }, snapshotAt),
        { eligible: false, reason: "WITHDRAWN" },
      );
    }
  });
});

describe("reward arithmetic", () => {
  it("14. DIRECT/BOND use the epoch's pool rate, halved for 12 hours", () => {
    // 1000 ACF at 0.25% daily -> 0.125% this epoch -> 1.25 ACF
    assert.equal(epochReward(1000n * E18, 2_500n), 1_250_000_000_000_000_000n);
  });

  it("15. DAO uses the fixed 1% policy, NOT pool 6's 0.5% current ROI", () => {
    const base = 1000n * E18;
    assert.equal(rateFor("DAO", 5_000n), DAO_DAILY_RATE);          // pool rate ignored
    assert.equal(epochReward(base, DAO_DAILY_RATE), 5n * E18);     // 0.5% of 1000 = 5
    // Reading the pool would have paid half.
    assert.equal(epochReward(base, 5_000n), 25n * E18 / 10n);
  });

  it("16. rounding is FLOOR, never up", () => {
    // 1 wei at 0.25% daily is far below one unit; it must floor to zero, not round to one.
    assert.equal(epochReward(1n, 2_500n), 0n);
    // 999_999 * 2500 / 2_000_000 = 1249.99875 -> 1249
    assert.equal(epochReward(999_999n, 2_500n), 1_249n);
  });

  it("17. handles large bigint values without precision loss", () => {
    const huge = 10_000_000n * E18;                                // 10 million ACF
    const reward = epochReward(huge, DAO_DAILY_RATE);
    assert.equal(reward, 50_000n * E18);                           // exactly 0.5%
    assert.equal(typeof reward, "bigint");
  });

  it("18. a zero or missing rate pays nothing rather than throwing", () => {
    assert.equal(epochReward(1000n * E18, 0n), 0n);
    assert.equal(rateFor("DIRECT", undefined), 0n);
  });

  it("19. RATE_DENOMINATOR matches the contracts", () => {
    assert.equal(RATE_DENOMINATOR, 1_000_000n);
    assert.equal(DAO_DAILY_RATE, 10_000n);                         // 1%
  });
});
