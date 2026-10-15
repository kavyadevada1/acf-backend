import cron from "node-cron";
import mongoose from "mongoose";
import { config } from "../config.js";
import { connectDatabase } from "../db.js";
import { logger } from "../lib/logger.js";
import { catchUpRewardEpochs } from "./service.js";
import { catchUpTeamRewardEpochs } from "./team/service.js";
import { catchUpDAORevenueEpochs, syncDAOConfig } from "../daoRevenue/service.js";
import { calculateSettlementCheckpoint } from "../settlement/checkpoint.js";
import { reconcileClaimStates, reconcileSettlementCheckpoint } from "../settlement/reconcile.js";
import { latestCompletedEpochId } from "./policy.js";

/**
 * The reward worker.
 *
 * A separate process from the API, which stays non-scheduling — the same split as the DAO
 * publisher. The cron expression only decides WHEN to look; every rule lives in
 * runRewardEpoch, so the schedule can change without touching the arithmetic.
 *
 *   npm run reward:worker
 */

let running = false;

/** Serialised: a long epoch must not have the next tick start a second pass over it. */
async function tick(trigger: string) {
  if (running) {
    logger.info("reward tick skipped; previous run still in progress", { trigger });
    return;
  }
  running = true;
  try {
    // Phase 1 first: Team Reward reads its settled output.
    try {
      const { processed, stoppedAt } = await catchUpRewardEpochs();
      if (processed.length > 0 || stoppedAt !== null) {
        logger.info("reward run complete", {
          trigger,
          settled: processed.filter((p) => p.status === "CALCULATED").length,
          skipped: processed.filter((p) => p.status === "SKIPPED").length,
          stoppedAt,
        });
      }
    } catch (cause) {
      logger.error("reward run failed", { trigger, error: (cause as Error).message });
    }

    // Phase 2 in its own try: a Team Reward failure must never cast doubt on, or roll back, a
    // staking epoch that is already correct. Separate statuses, separate errors.
    try {
      const { processed, stoppedAt } = await catchUpTeamRewardEpochs();
      if (processed.length > 0 || stoppedAt !== null) {
        logger.info("team reward run complete", {
          trigger,
          settled: processed.filter((p) => p.status === "CALCULATED").length,
          skipped: processed.filter((p) => p.status === "SKIPPED").length,
          stoppedAt,
        });
      }
    } catch (cause) {
      logger.error("team reward run failed", { trigger, error: (cause as Error).message });
    }

    // Phase 4 DAO member revenue: CALCULATION ONLY, gated on Phase 1 alone.
    //
    // Phase 2 is deliberately not a dependency: DAO revenue is priced from Self rewards and the
    // epoch price, both frozen by Phase 1, so a Team reward failure must not make a valid epoch
    // financially impossible. Funding and distribution are signed by the separate DAO revenue
    // executor process, never here.
    try {
      await syncDAOConfig();
      const { processed, stoppedAt } = await catchUpDAORevenueEpochs();
      if (processed.length > 0 || stoppedAt !== null) {
        logger.info("dao revenue run complete", {
          trigger, epochs: processed.length, stoppedAt,
          statuses: processed.map((p) => `${p.epochId}:${p.status}`),
        });
      }
    } catch (cause) {
      logger.error("dao revenue run failed", { trigger, error: (cause as Error).message });
    }

    // Phase 3 settlement: CALCULATION AND RECONCILIATION ONLY. This worker holds no signer —
    // funding and root finalization move real Treasury assets and are submitted by the separate
    // settlement executor process.
    try {
      const reconciled = await reconcileSettlementCheckpoint();
      if (reconciled && reconciled.statusBefore !== reconciled.statusAfter) {
        logger.info("settlement reconciled", { ...reconciled });
      }
      const result = await calculateSettlementCheckpoint();
      if (result.outcome !== "NOTHING_TO_SETTLE") {
        logger.info("settlement run complete", { trigger, ...result });
      }
      const claims = await reconcileClaimStates();
      if (claims.claimed > 0) logger.info("claim states reconciled", { trigger, ...claims });
    } catch (cause) {
      logger.error("settlement run failed", { trigger, error: (cause as Error).message });
    }
  } finally {
    running = false;
  }
}

await connectDatabase();

logger.info("reward worker started", {
  activationEpoch: config.rewardActivationEpoch,
  latestCompletedEpoch: latestCompletedEpochId(Math.floor(Date.now() / 1000)),
});

/**
 * Five minutes PAST each epoch boundary — an execution offset only.
 *
 * The epoch still settles [00:00, 12:00) and [12:00, 24:00); epochId, snapshotAt and
 * windowStart are pure arithmetic over the boundary and know nothing about when the worker
 * runs. Running AT the boundary was a deterministic race: blockAtOrBefore deliberately
 * requires the chain head to be strictly past snapshotAt, and Amoy's head timestamp tracks
 * wall-clock with no lag, so the head had not yet passed 12:00:00 at 12:00:00 and the epoch
 * failed until the next tick. Five minutes is far more than the ~1-2s needed, and costs
 * nothing: the window has already closed.
 */
cron.schedule(config.rewardWorkerCron, () => void tick("cron"), { timezone: "UTC" });
logger.info("reward worker scheduled", { cron: config.rewardWorkerCron, timezone: "UTC" });

// Catch up anything missed while the worker was down, oldest first — AFTER registering the
// schedule, not before. A long startup pass (a config backfill, or many epochs to settle) used
// to delay registration for as long as it took, so the worker looked hung and no tick could
// fire. `tick` already refuses to overlap itself, so a cron tick arriving mid-catch-up is
// skipped rather than racing it.
void tick("startup");

const shutdown = async () => {
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
