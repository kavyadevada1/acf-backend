import mongoose from "mongoose";
import { connectDatabase } from "../src/db.js";
import {
  executeSettlementCheckpoint, nextExecutableCheckpoint, preflight, signerConfigured,
} from "../src/settlement/executor.js";
import { loadEpochExecutorSigner } from "../src/executor/signer.js";

/**
 * Phase 3 settlement executor — funds a checkpoint and publishes its root.
 *
 *   npm run settlement:execute -- --dry-run [--checkpoint=<id>]    reads only, signs nothing
 *   npm run settlement:execute -- --checkpoint=<id>                funds + finalizes
 *
 * Signs with EPOCH_EXECUTOR_PRIVATE_KEY, the same dedicated executor account Phase 4 uses. Both
 * calls take an epoch id and nothing else: the root, the cumulative total and the funding amount
 * come from the commitment `npm run settlement:authorize` already accepted with a different key,
 * so this process chooses no financial figure. A checkpoint with no commitment is refused here
 * rather than reverting on chain.
 *
 * The dry run needs no key: it validates the manifest, the commitment, the deployment wiring, the
 * live chain state and the funding state, and reports the role checks as unknown without a signer.
 */

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const dryRun = process.argv.includes("--dry-run");
const raw = arg("checkpoint");
const requested = raw === undefined ? undefined : Number(raw);
if (requested !== undefined && !Number.isInteger(requested)) {
  console.error(`--checkpoint must be an integer, got "${raw}".`);
  process.exit(1);
}

await connectDatabase();
try {
  const checkpointId = requested ?? (await nextExecutableCheckpoint());
  if (checkpointId === null) {
    console.log("  no executable settlement checkpoint.");
    process.exit(0);
  }

  if (dryRun) {
    const signerAddress = signerConfigured() ? loadEpochExecutorSigner().address : undefined;
    const r = await preflight(checkpointId, undefined, signerAddress);
    console.log("  DRY RUN — no transaction will be sent.\n");
    console.log(`  checkpoint            ${r.checkpointId}`);
    console.log(`  status                ${r.status}`);
    console.log(`  chainId               ${r.chainId}`);
    console.log(`  signer                ${r.signerAddress ?? "— (not unlocked)"}`);
    console.log(`  role on Treasury      ${r.signerHasTreasuryRole ?? "unknown"}`);
    console.log(`  role on Withdrawal    ${r.signerHasWithdrawalRole ?? "unknown"}`);
    console.log(`  FUND AMOUNT           ${r.deltaACF} ACF`);
    console.log(`  new root              ${r.newRoot}`);
    console.log(`  new cumulative total  ${r.newCumulativeTotalACF}`);
    console.log(`  authorized            ${r.authorized}`);
    console.log(`  commitment matches    ${r.authorizationMatchesManifest}`);
    console.log(`    authorized root     ${r.authorizedRoot ?? "—"}`);
    console.log(`    authorized total    ${r.authorizedCumulativeTotalACF ?? "—"}`);
    console.log(`    authorized funding  ${r.authorizedFundingAmountACF ?? "—"}`);
    console.log(`  already funded        ${r.alreadyFunded}`);
    console.log(`  already finalized     ${r.alreadyFinalized}`);
    console.log(`  live epochId          ${r.liveEpochId}`);
    console.log(`  live root             ${r.liveRoot}`);
    console.log(`  live cumulative total ${r.liveCumulativeTotalACF}`);
    console.log(`  treasury balance      ${r.treasuryBalanceACF} ACF`);
    console.log("  planned calls:");
    for (const c of r.plannedCalls) console.log(`    ${c}`);
    if (r.plannedCalls.length === 0) console.log("    (none — nothing left to do)");
    if (r.blockers.length > 0) {
      console.log("  BLOCKERS:");
      for (const b of r.blockers) console.log(`    - ${b}`);
    }
    process.exit(r.blockers.length > 0 ? 1 : 0);
  }

  const result = await executeSettlementCheckpoint(checkpointId);
  console.log(`  checkpoint ${result.checkpointId}: ${result.status}`);
  console.log(`    funding tx   ${result.fundingTxHash ?? "(already funded)"}`);
  console.log(`    finalize tx  ${result.finalizeTxHash ?? "(already finalized)"}`);
  console.log("\n  Rewards are now claimable. GET /rewards/summary should report CLAIMABLE.");
} finally {
  await mongoose.disconnect().catch(() => {});
}
