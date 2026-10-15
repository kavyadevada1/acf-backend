import mongoose from "mongoose";
import { connectDatabase } from "../src/db.js";
import { logger } from "../src/lib/logger.js";
import { config } from "../src/config.js";
import {
  executeDAORevenueEpoch, nextExecutableEpoch, preflight, signerConfigured,
} from "../src/daoRevenue/executor.js";
import { loadEpochExecutorSigner } from "../src/executor/signer.js";

/**
 * DAO Revenue Executor — the ONLY process in this repository that signs.
 *
 * It is a separate entry point from the API and the reward worker precisely so that neither can
 * reach a signing key: `src/index.ts` and `src/rewards/worker.ts` have no import path to
 * daoRevenue/signer.ts.
 *
 *   npm run dao-revenue:execute -- --dry-run     reads only, signs nothing
 *   npm run dao-revenue:execute                  funds + distributes the oldest pending epoch
 *   npm run dao-revenue:execute -- --epoch=<id>  a specific epoch
 *   npm run dao-revenue:executor                 long-running, oldest first, repeats
 *
 * A dry run does not need the key: it validates the manifest, the deployment wiring, the
 * funding state, the Treasury headroom and the batch plan, and reports the role checks as
 * unknown when no signer address is available.
 */

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const flag = (name: string) => process.argv.includes(`--${name}`);
const dryRun = flag("dry-run");
const loop = process.argv[2] === "loop";

const epochArg = arg("epoch");
const requestedEpoch = epochArg === undefined ? undefined : Number(epochArg);
if (requestedEpoch !== undefined && !Number.isInteger(requestedEpoch)) {
  console.error(`--epoch must be an integer, got "${epochArg}".`);
  process.exit(1);
}

function printPreflight(report: Awaited<ReturnType<typeof preflight>>): void {
  console.log(`  epoch                 ${report.epochId}`);
  console.log(`  chainId               ${report.chainId}`);
  console.log(`  manifest hash         ${report.manifestHash}`);
  console.log(`  manifest verified     ${report.manifestVerified}`);
  console.log(`  signer                ${report.signerAddress ?? "— (not unlocked)"}`);
  console.log(`  role on Treasury      ${report.signerHasTreasuryRole ?? "unknown"}`);
  console.log(`  role on distributor   ${report.signerHasDistributorRole ?? "unknown"}`);
  console.log(`  obligation            ${report.obligationACF} ACF`);
  console.log(`  already funded        ${report.fundedACF} ACF`);
  console.log(`  already distributed   ${report.distributedACF} ACF`);
  console.log(`  treasury balance      ${report.treasuryBalanceACF} ACF`);
  console.log(`  required reserve      ${report.requiredReserveACF} ACF`);
  console.log(`  pending Phase 3 oblig ${report.pendingStandardObligationACF} ACF`);
  console.log(`  required headroom     ${report.requiredHeadroomACF} ACF`);
  console.log(`  balance after funding ${report.postFundingBalanceACF} ACF`);
  console.log(`  headroom ok           ${report.headroomOk}`);
  console.log(`  members / batches     ${report.memberCount} / ${report.batchCount}`);
  console.log(`  still unpaid          ${report.unpaidMembers}`);
  console.log("  planned calls:");
  for (const call of report.plannedCalls) console.log(`    ${call}`);
  if (report.plannedCalls.length === 0) console.log("    (none — nothing left to do)");
  if (report.blockers.length > 0) {
    console.log("  BLOCKERS:");
    for (const blocker of report.blockers) console.log(`    - ${blocker}`);
  }
}

await connectDatabase();
try {
  if (dryRun) {
    const epochId = requestedEpoch ?? (await nextExecutableEpoch());
    if (epochId === null) {
      console.log("  no executable DAO revenue epoch.");
      process.exit(0);
    }
    // Unlock only if a key happens to be configured; a dry run must not require one.
    const signerAddress = signerConfigured() ? loadEpochExecutorSigner().address : undefined;
    const report = await preflight(epochId, undefined, signerAddress);
    console.log("  DRY RUN — no transaction will be sent.\n");
    printPreflight(report);
    process.exit(report.blockers.length > 0 ? 1 : 0);
  }

  if (loop) {
    console.log(`  DAO revenue executor polling every ${config.daoRevenueExecutorPollMs}ms`);
    const signer = loadEpochExecutorSigner();
    console.log(`  signer ${signer.address}`);
    // Sequential by design: only one epoch executes at a time, oldest first, so a failure
    // cannot be stepped over by a later epoch's funding.
    for (;;) {
      const epochId = await nextExecutableEpoch();
      if (epochId === null) {
        await new Promise((resolve) => setTimeout(resolve, config.daoRevenueExecutorPollMs));
        continue;
      }
      try {
        const result = await executeDAORevenueEpoch(epochId, { signer });
        logger.info("dao revenue epoch executed", { ...result });
      } catch (cause) {
        logger.error("dao revenue execution failed", {
          epochId, error: (cause as Error).message,
        });
        // Stop rather than spin: an execution failure needs a human, and retrying it in a tight
        // loop would burn gas re-attempting a transaction the chain already rejected.
        break;
      }
    }
    process.exit(1);
  }

  // Falls back to the oldest executable epoch, matching settlement:execute and the dry run, so
  // an operator never has to look an id up to make progress.
  const epochId = requestedEpoch ?? (await nextExecutableEpoch());
  if (epochId === null) {
    console.log("  no executable DAO revenue epoch — nothing to do.");
    process.exit(0);
  }
  const result = await executeDAORevenueEpoch(epochId);
  console.log(`  epoch ${result.epochId}: ${result.status}`);
  console.log(`    funding tx    ${result.fundingTxHash ?? "(already funded)"}`);
  console.log(`    batches sent  ${result.batchesSubmitted}`);
  console.log(`    members paid  ${result.membersPaid}`);
} finally {
  await mongoose.disconnect().catch(() => {});
}
