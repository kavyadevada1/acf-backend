import mongoose from "mongoose";
import { connectDatabase } from "../src/db.js";
import { config } from "../src/config.js";
import { DAORevenueEpoch } from "../src/models/DAORevenueEpoch.js";
import { DAORevenueMemberEntry } from "../src/models/DAORevenueMemberEntry.js";
import { syncDAOConfigHistory } from "../src/daoRevenue/configHistory.js";
import { runDAORevenueEpoch } from "../src/daoRevenue/calculation.js";
import { catchUpDAORevenueEpochs } from "../src/daoRevenue/service.js";
import { reconcileDAORevenueEpoch } from "../src/daoRevenue/reconcile.js";
import { RewardEpoch } from "../src/models/RewardEpoch.js";
import { rebuildManifest } from "../src/daoRevenue/executor.js";

/**
 * DAO Member Revenue operator CLI — CALCULATION AND READS ONLY.
 *
 * This process holds no signer and cannot import one: funding and distribution live in
 * run-dao-revenue-executor.ts. Every command delegates to the canonical service, so no
 * financial formula exists in this file.
 *
 *   npm run dao-revenue:backfill-config -- --from=<block> [--to=<block>]
 *   npm run dao-revenue:calculate       -- --epoch=<id>
 *   npm run dao-revenue:catch-up
 *   npm run dao-revenue:status          -- --epoch=<id>
 *   npm run dao-revenue:reconcile       -- --epoch=<id>
 *   npm run dao-revenue:manifest        -- --epoch=<id>
 */

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const intArg = (name: string) => {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    console.error(`--${name} must be an integer, got "${raw}".`);
    process.exit(1);
  }
  return value;
};
const mode = process.argv[2];

/**
 * Lists the Phase 1 epochs that have settled but have no DAO revenue decision yet.
 *
 * Printed instead of a bare "pass --epoch", because the operator's next step depends on which
 * epochs are outstanding, and the whole point of catch-up is not having to name them.
 */
async function reportPending(): Promise<void> {
  const settle = {
    chainId: config.chainId,
    daoContractAddress: config.acfDaoAddress.toLowerCase(),
    distributorAddress: config.daoRevenueDistributorAddress.toLowerCase(),
  };
  const settled = await RewardEpoch.find(
    {
      chainId: config.chainId,
      stakingContractAddress: config.acfStakingAddress.toLowerCase(),
      status: { $in: ["CALCULATED", "FINALIZED"] },
    },
    { epochId: 1 },
  ).sort({ epochId: 1 }).lean();

  const decided = new Set(
    (await DAORevenueEpoch.find(
      { ...settle, status: { $ne: "FAILED" } }, { epochId: 1 },
    ).lean()).map((e) => e.epochId),
  );
  const pending = settled.map((e) => e.epochId).filter((id) => !decided.has(id));

  console.error("Pass --epoch=<id>, or run `npm run dao-revenue:catch-up` to do all pending.");
  if (settled.length === 0) {
    console.error("  No Phase 1 epoch has settled yet, so there is nothing to calculate.");
    console.error("  Run: npm run reward:epoch -- --catch-up");
    return;
  }
  console.error(`  Phase 1 settled epochs: ${settled[0]!.epochId}..${settled.at(-1)!.epochId}`);
  console.error(
    pending.length === 0
      ? "  DAO revenue pending: none — every settled epoch already has a decision."
      : `  DAO revenue pending: ${pending.join(", ")}`,
  );
}

await connectDatabase();
try {
  if (mode === "backfill-config") {
    const from = intArg("from");
    if (from === undefined) {
      console.error("Pass --from=<deployment block of ACFDAO>. Starting later leaves a hole in");
      console.error("configuration history, which would price a past epoch wrongly.");
      process.exit(1);
    }
    const r = await syncDAOConfigHistory({ fromBlock: from, toBlock: intArg("to") });
    console.log(`  blocks ${r.fromBlock}..${r.toBlock} in ${r.requests} request(s)`);
    console.log(`  inserted ${r.rowsInserted}, already present ${r.rowsAlreadyPresent}`);
  } else if (mode === "calculate") {
    const epochId = intArg("epoch");
    if (epochId === undefined) {
      // Report what is actually actionable rather than just rejecting the command: the useful
      // answer is almost always "these epochs are pending, run catch-up".
      await reportPending();
      process.exit(1);
    }
    const r = await runDAORevenueEpoch(epochId);
    if (r.status === "CALCULATED") {
      console.log(`  CALCULATED epoch ${r.epochId}`);
      console.log(`    system Self reward   ${r.systemSelfRewardACF} ACF`);
      console.log(`    system revenue       ${r.systemRevenueUSD6} USD6`);
      console.log(`    member pool          ${r.daoRevenuePoolUSD6} USD6`);
      console.log(`    eligible members     ${r.eligibleMembers} in ${r.batchCount} batch(es)`);
      console.log(`    rounding dust        ${r.roundingDustUSD6} USD6 (never funded)`);
      console.log(`    FUND EXACTLY         ${r.totalMemberRevenueACF} ACF`);
      console.log(`    manifest hash        ${r.manifestHash}`);
    } else if (r.status === "NOTHING_TO_DISTRIBUTE") {
      console.log(`  epoch ${r.epochId}: nothing to distribute (${r.reason})`);
    } else {
      console.log(`  epoch ${r.epochId} already processed: ${r.existing}`);
    }
  } else if (mode === "catch-up") {
    const { processed, stoppedAt } = await catchUpDAORevenueEpochs();
    for (const r of processed) console.log(`  epoch ${r.epochId}: ${r.status}`);
    console.log(`  ${processed.length} epoch(s) processed${stoppedAt !== null ? `, stopped at ${stoppedAt}` : ""}`);
  } else if (mode === "status") {
    const epochId = intArg("epoch");
    if (epochId === undefined) {
      console.error("Pass --epoch=<id>.");
      process.exit(1);
    }
    const epoch = await DAORevenueEpoch.findOne({
      chainId: config.chainId,
      distributorAddress: config.daoRevenueDistributorAddress.toLowerCase(),
      epochId,
    }).lean();
    if (!epoch) {
      console.log(`  no DAO revenue epoch ${epochId}`);
    } else {
      const members = await DAORevenueMemberEntry.countDocuments({
        chainId: config.chainId,
        distributorAddress: config.daoRevenueDistributorAddress.toLowerCase(),
        epochId,
      });
      console.log(`  epoch ${epochId}  status ${epoch.status}${epoch.reason ? ` (${epoch.reason})` : ""}`);
      console.log(`    obligation     ${epoch.totalMemberRevenueACF} ACF`);
      console.log(`    funded         ${epoch.fundedACF ?? "—"} ACF`);
      console.log(`    members        ${epoch.paidMembers}/${members} paid`);
      console.log(`    manifest       ${epoch.manifestHash}`);
      const live = await reconcileDAORevenueEpoch(epochId);
      if (live) {
        console.log(`    chain          funded ${live.fundedACF}, distributed ${live.distributedACF}`);
        console.log(`    after reconcile ${live.statusAfter}`);
        for (const w of live.warnings) console.log(`    warning: ${w}`);
      }
    }
  } else if (mode === "reconcile") {
    const epochId = intArg("epoch");
    if (epochId === undefined) {
      console.error("Pass --epoch=<id>.");
      process.exit(1);
    }
    const r = await reconcileDAORevenueEpoch(epochId);
    if (!r) console.log(`  no DAO revenue epoch ${epochId}`);
    else {
      console.log(`  epoch ${r.epochId}: ${r.statusBefore} -> ${r.statusAfter}`);
      console.log(`    funded ${r.fundedACF}, distributed ${r.distributedACF}, obligation ${r.obligationACF}`);
      console.log(`    members paid ${r.paidMembers}/${r.totalMembers}`);
      for (const w of r.warnings) console.log(`    warning: ${w}`);
    }
  } else if (mode === "manifest") {
    const epochId = intArg("epoch");
    if (epochId === undefined) {
      console.error("Pass --epoch=<id>.");
      process.exit(1);
    }
    const { manifest, hash, recordedHash } = await rebuildManifest(epochId);
    console.log(JSON.stringify({ ...manifest, manifestHash: hash, recordedHash }, null, 2));
    if (hash.toLowerCase() !== recordedHash.toLowerCase()) {
      console.error("\nMANIFEST HASH MISMATCH — a financial field changed since calculation.");
      process.exit(1);
    }
  } else {
    console.error(
      "Usage: backfill-config --from=<block> | calculate --epoch=<id> | catch-up | " +
        "status --epoch=<id> | reconcile --epoch=<id> | manifest --epoch=<id>",
    );
    process.exit(1);
  }
} finally {
  await mongoose.disconnect().catch(() => {});
}
