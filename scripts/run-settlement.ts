import mongoose from "mongoose";
import { connectDatabase } from "../src/db.js";
import { calculateSettlementCheckpoint } from "../src/settlement/checkpoint.js";
import { buildManifest } from "../src/settlement/manifest.js";
import { reconcileClaimStates, reconcileSettlementCheckpoint } from "../src/settlement/reconcile.js";

/**
 * Operator entry point for settlement. Calculation and reconciliation only.
 *
 *   npm run settlement:calculate
 *   npm run settlement:reconcile
 *   npm run settlement:manifest -- --checkpoint=<id>
 *
 * This process NEVER submits a transaction. A calculated checkpoint is then committed by
 * `npm run settlement:authorize` (the independent authorizer key) and only afterwards relayed by
 * `npm run settlement:execute` (the executor key), which can choose neither the root, the
 * cumulative total nor the funding amount. This process holds no signer and cannot import one.
 * Every command calls the same canonical service the worker uses.
 */

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const mode = process.argv[2];

await connectDatabase();
try {
  if (mode === "calculate") {
    const r = await calculateSettlementCheckpoint();
    if (r.outcome === "NOTHING_TO_SETTLE") console.log(`  nothing to settle: ${r.reason}`);
    else if (r.outcome === "AWAITING_OPERATOR") {
      console.log(`  checkpoint ${r.checkpointId} is ${r.status}; awaiting operator action.`);
      console.log("  review it with: npm run settlement:authorize -- --dry-run");
      console.log(`  authorize it with: npm run settlement:authorize -- --checkpoint=${r.checkpointId}`);
      console.log(`  then relay it with: npm run settlement:execute -- --checkpoint=${r.checkpointId}`);
    } else {
      console.log(`  CALCULATED checkpoint ${r.checkpointId}`);
      console.log(`    reward epochs      ${r.fromRewardEpochId}..${r.throughRewardEpochId}`);
      console.log(`    leaves             ${r.leafCount}`);
      console.log(`    root               ${r.root}`);
      console.log(`    cumulative total   ${r.publishedCumulativeTotalACF}`);
      console.log(`    FUND THIS AMOUNT   ${r.publishedDeltaACF}`);
      console.log("    next: npm run settlement:authorize   (the executor cannot act until then)");
    }
  } else if (mode === "reconcile") {
    const cp = await reconcileSettlementCheckpoint();
    console.log(cp
      ? `  checkpoint ${cp.checkpointId}: ${cp.statusBefore} -> ${cp.statusAfter}` +
        (cp.auditWarning ? `\n  audit: ${cp.auditWarning}` : "")
      : "  no unfinalized checkpoint.");
    const claims = await reconcileClaimStates();
    console.log(`  claim states: ${claims.reconciled} reconciled, ${claims.claimed} with a claim.`);
  } else if (mode === "manifest") {
    const id = Number(arg("checkpoint"));
    if (!Number.isInteger(id)) {
      console.error("Pass --checkpoint=<id>.");
      process.exit(1);
    }
    const m = await buildManifest(id);
    console.log(JSON.stringify({ ...m.manifest, manifestHash: m.manifestHash }, null, 2));
  } else {
    console.error("Usage: calculate | reconcile | manifest --checkpoint=<id>");
    process.exit(1);
  }
} finally {
  await mongoose.disconnect().catch(() => {});
}
