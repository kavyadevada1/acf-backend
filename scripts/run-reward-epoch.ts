import mongoose from "mongoose";
import { connectDatabase } from "../src/db.js";
import { runRewardEpoch } from "../src/rewards/epoch.js";
import { catchUpRewardEpochs } from "../src/rewards/service.js";
import { latestCompletedEpochId, snapshotAtOf, windowStartOf } from "../src/rewards/policy.js";

/**
 * Operator entry point for settling epochs by hand.
 *
 *   npm run reward:epoch -- --epoch=41459     one specific epoch
 *   npm run reward:epoch -- --catch-up        every unsettled completed epoch, oldest first
 *
 * Calls the SAME runRewardEpoch the worker uses, through the same locking and the same unique
 * keys. There is deliberately no second calculation path to drift out of step.
 */

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

await connectDatabase();
try {
  if (process.argv.includes("--catch-up")) {
    const { processed, stoppedAt } = await catchUpRewardEpochs();
    for (const r of processed) {
      console.log(`  epoch ${r.epochId}  ${r.status.padEnd(10)} stakes=${r.stakesProcessed} rewarded=${r.stakesRewarded}`);
    }
    if (processed.length === 0) console.log("  nothing to settle.");
    if (stoppedAt !== null) {
      console.error(`\n  HALTED at epoch ${stoppedAt}. Later epochs are not settled, because each`);
      console.error("  compounds on the one before it. Fix the cause and re-run.");
      process.exitCode = 1;
    }
  } else {
    const raw = arg("epoch");
    if (!raw) {
      const latest = latestCompletedEpochId(Math.floor(Date.now() / 1000));
      console.error("Pass --epoch=<id> or --catch-up.");
      console.error(`Latest completed epoch is ${latest} (window ${iso(windowStartOf(latest))} -> ${iso(snapshotAtOf(latest))}).`);
      process.exit(1);
    }
    const epochId = Number(raw);
    console.log(`  epoch ${epochId}: window ${iso(windowStartOf(epochId))} -> ${iso(snapshotAtOf(epochId))}`);
    const r = await runRewardEpoch(epochId);
    console.log(`  ${r.status}  stakes=${r.stakesProcessed} rewarded=${r.stakesRewarded}`);
    console.log(`  regular self = ${r.totalRegularSelfACF}  dao = ${r.totalDAOStakeACF}`);
  }
} finally {
  await mongoose.disconnect().catch(() => {});
}
