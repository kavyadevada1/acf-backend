import mongoose from "mongoose";
import { connectDatabase } from "../src/db.js";
import { runTeamRewardEpoch } from "../src/rewards/team/epoch.js";
import { catchUpTeamRewardEpochs } from "../src/rewards/team/service.js";
import { snapshotAtOf, windowStartOf } from "../src/rewards/policy.js";

/**
 * Operator entry point for Team Reward (Level + Rank + Global).
 *
 *   npm run reward:team -- --epoch=41459     one epoch
 *   npm run reward:team -- --catch-up        every Phase-1-complete epoch, oldest first
 *
 * Calls the SAME runTeamRewardEpoch the worker uses, through the same locking and the same
 * unique keys. There is deliberately no second calculation path to drift out of step.
 *
 * Deterministic without a fresh reconciliation: every input is Phase 1's immutable output,
 * immutable stake creation data, or the as-of referral graph.
 */

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

await connectDatabase();
try {
  if (process.argv.includes("--catch-up")) {
    const { processed, stoppedAt } = await catchUpTeamRewardEpochs();
    for (const r of processed) {
      console.log(
        `  epoch ${r.epochId}  ${r.status.padEnd(10)} users=${r.graphNodes} ` +
          `level=${r.totalLevelACF} rank=${r.totalRankACF} global=${r.totalGlobalACF}`,
      );
    }
    if (processed.length === 0) console.log("  nothing to settle.");
    if (stoppedAt !== null) {
      console.error(`\n  HALTED at epoch ${stoppedAt}. Later epochs are not settled. Fix the`);
      console.error("  cause and re-run; nothing already settled is affected.");
      process.exitCode = 1;
    }
  } else {
    const raw = arg("epoch");
    if (!raw) {
      console.error("Pass --epoch=<id> or --catch-up.");
      process.exit(1);
    }
    const epochId = Number(raw);
    console.log(`  epoch ${epochId}: window ${iso(windowStartOf(epochId))} -> ${iso(snapshotAtOf(epochId))}`);
    const r = await runTeamRewardEpoch(epochId);
    console.log(`  ${r.status}  users=${r.graphNodes} levelCredits=${r.levelCredits}`);
    console.log(`  level  = ${r.totalLevelACF}`);
    console.log(`  rank   = ${r.totalRankACF}`);
    console.log(`  global = ${r.totalGlobalACF}`);
    console.log(`  team   = ${r.totalTeamACF}`);
    console.log(`  network contribution = ${r.networkContributionACF}`);
  }
} finally {
  await mongoose.disconnect().catch(() => {});
}
