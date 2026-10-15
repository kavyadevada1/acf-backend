import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { latestCompletedEpochId, snapshotAtOf, windowStartOf } from "./policy.ts";

/**
 * The scheduler is an EXECUTION concern, deliberately separate from the financial boundary.
 *
 * worker.ts runs with top-level side effects — it connects to the database and registers a
 * cron job on import — so these assertions read its source rather than importing it. That is
 * also the honest thing to check: the configured expression is the artefact that decides when
 * the worker runs.
 */
const WORKER = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
const CONFIG = readFileSync(new URL("../config.ts", import.meta.url), "utf8");

const UTC = (s: string) => Math.floor(new Date(s).getTime() / 1000);

describe("reward worker schedule", () => {
  it("defaults to five minutes past each boundary, in UTC", () => {
    // The expression is configurable so a short interval can prove the schedule fires, but the
    // DEFAULT is the financial decision and stays pinned here.
    const fallback = /rewardWorkerCron:\s*process\.env\.REWARD_WORKER_CRON\s*\?\?\s*"([^"]+)"/
      .exec(CONFIG);
    assert.ok(fallback, "config.ts must define rewardWorkerCron with a literal default");
    assert.equal(fallback[1], "5 0,12 * * *", "00:05 and 12:05");

    const call = /cron\.schedule\(\s*config\.rewardWorkerCron[\s\S]*?\{\s*timezone:\s*"([^"]+)"\s*\}/
      .exec(WORKER);
    assert.ok(call, "worker.ts must schedule from config.rewardWorkerCron");
    assert.equal(call[1], "UTC", "never the host timezone");
  });

  it("an override cannot move the financial window", () => {
    // Whatever the cron says, the epoch is derived from wall-clock time, so running every three
    // minutes re-checks for work rather than creating extra epochs.
    const noon = UTC("2026-10-03T12:00:00Z");
    for (const offset of [5 * 60, 8 * 60, 11 * 60 * 60]) {
      assert.equal(
        latestCompletedEpochId(noon + offset), latestCompletedEpochId(noon + 5 * 60),
        "every tick between boundaries settles the same epoch",
      );
    }
  });

  it("still drives the existing catch-up path", () => {
    assert.match(WORKER, /catchUpRewardEpochs\(\)/, "the single settlement entry point");
    assert.match(WORKER, /tick\("startup"\)/, "startup catch-up survives a restart gap");
    // Registration must come FIRST. A long catch-up used to delay it for as long as the pass
    // took, so the worker looked hung and no scheduled tick could fire.
    assert.ok(
      WORKER.indexOf("cron.schedule(") < WORKER.indexOf('tick("startup")'),
      "the schedule is registered before the startup catch-up runs",
    );
  });
});

describe("the offset does not move the financial window", () => {
  it("executing at 12:05 settles the window that closed at 12:00", () => {
    const executedAt = UTC("2026-10-03T12:05:00Z");
    const epochId = latestCompletedEpochId(executedAt);

    assert.equal(snapshotAtOf(epochId), UTC("2026-10-03T12:00:00Z"));
    assert.equal(windowStartOf(epochId), UTC("2026-10-03T00:00:00Z"));
    // NOT 00:05 -> 12:05.
    assert.notEqual(windowStartOf(epochId), UTC("2026-10-03T00:05:00Z"));
  });

  it("executing at 00:05 settles the window that closed at 00:00", () => {
    const epochId = latestCompletedEpochId(UTC("2026-10-04T00:05:00Z"));
    assert.equal(snapshotAtOf(epochId), UTC("2026-10-04T00:00:00Z"));
    assert.equal(windowStartOf(epochId), UTC("2026-10-03T12:00:00Z"));
  });

  it("anywhere in the five-minute offset resolves to the SAME epoch", () => {
    const base = latestCompletedEpochId(UTC("2026-10-03T12:00:00Z"));
    for (const at of ["12:00:00", "12:00:01", "12:02:30", "12:05:00", "12:05:01"]) {
      assert.equal(
        latestCompletedEpochId(UTC(`2026-10-03T${at}Z`)), base,
        `${at} must settle the same boundary`,
      );
    }
  });

  it("the offset never reaches into the next window", () => {
    // The next epoch only begins at the next boundary, 11h55m after this tick.
    const atTick = latestCompletedEpochId(UTC("2026-10-03T12:05:00Z"));
    const atNext = latestCompletedEpochId(UTC("2026-10-04T00:05:00Z"));
    assert.equal(atNext, atTick + 1, "exactly one epoch per tick, no skips, no overlap");
  });
});
