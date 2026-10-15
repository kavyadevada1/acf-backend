import mongoose from "mongoose";
import { connectDatabase } from "../src/db.js";
import {
  authorizePreflight, authorizeSettlementCheckpoint, nextAuthorizableCheckpoint,
  rewardAuthorizerConfigured,
} from "../src/settlement/authorize.js";
import { loadRewardAuthorizerSigner } from "../src/executor/signer.js";

/**
 * Phase 3 settlement AUTHORIZER — commits what a checkpoint may publish and cost, and nothing else.
 *
 * A separate entry point from the executor on purpose. This process holds the authorizing key and
 * cannot fund, finalize or claim; the executor holds the relaying key and cannot authorize. Run
 * them under different credentials, ideally on different hosts: the whole protection is that one
 * compromised key cannot both decide a settlement and move money against it.
 *
 *   npm run settlement:authorize -- --dry-run                 reads only, signs nothing
 *   npm run settlement:authorize                              the oldest CALCULATED checkpoint
 *   npm run settlement:authorize -- --checkpoint=<id>         a specific checkpoint
 *
 * Signs with the independent authorizer key (DAO_REVENUE_AUTHORIZER_PRIVATE_KEY, or
 * REWARD_AUTHORIZER_PRIVATE_KEY when the two duties are separated). It is refused if it is the
 * same account as EPOCH_EXECUTOR_PRIVATE_KEY.
 *
 * Idempotent against the chain: a checkpoint already committed is reported as done, and its
 * on-chain commitment is CHECKED against what the checkpoint calculated rather than assumed to
 * match. A disagreement stops the run — the commitment is immutable.
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
  const checkpointId = requested ?? (await nextAuthorizableCheckpoint());
  if (checkpointId === null) {
    console.log("  no settlement checkpoint is waiting to be authorized.");
    process.exit(0);
  }

  if (dryRun) {
    // The dry run needs no key: it validates the manifest, the commitment arithmetic, the live
    // chain state and the role separation, and reports the role checks as unknown without one.
    const authorizerAddress = rewardAuthorizerConfigured()
      ? loadRewardAuthorizerSigner().address
      : undefined;
    const r = await authorizePreflight(checkpointId, undefined, authorizerAddress);
    console.log("  DRY RUN — no transaction will be sent.\n");
    console.log(`  checkpoint             ${r.checkpointId}`);
    console.log(`  status                 ${r.status}`);
    console.log(`  chainId                ${r.chainId}`);
    console.log(`  authorizer             ${r.authorizerAddress ?? "— (not unlocked)"}`);
    console.log(`  REWARD_AUTHORIZER_ROLE ${r.authorizerHasRole ?? "unknown"}`);
    console.log(`  Withdrawal.treasury()  ${r.withdrawalTreasury}`);
    console.log(`  root                   ${r.root}`);
    console.log(`  cumulative total       ${r.cumulativeTotalACF}`);
    console.log(`  FUNDING AMOUNT         ${r.fundingAmountACF} ACF`);
    console.log(`  already authorized     ${r.alreadyAuthorized}`);
    if (r.alreadyAuthorized) {
      console.log(`  on-chain root          ${r.onChainRoot}`);
      console.log(`  on-chain total         ${r.onChainCumulativeTotalACF}`);
      console.log(`  on-chain funding       ${r.onChainFundingAmountACF}`);
      console.log(`  commitment matches     ${r.commitmentMatches}`);
    }
    console.log("  planned calls:");
    for (const c of r.plannedCalls) console.log(`    ${c}`);
    if (r.plannedCalls.length === 0) console.log("    (none — nothing left to do)");
    if (r.blockers.length > 0) {
      console.log("  BLOCKERS:");
      for (const b of r.blockers) console.log(`    - ${b}`);
    }
    process.exit(r.blockers.length > 0 ? 1 : 0);
  }

  const result = await authorizeSettlementCheckpoint(checkpointId);
  console.log(`  checkpoint ${result.checkpointId}: AUTHORIZED`);
  console.log(`    tx                 ${result.txHash ?? "(already authorized on chain)"}`);
  console.log(`    root               ${result.root}`);
  console.log(`    cumulative total   ${result.cumulativeTotalACF}`);
  console.log(`    funding amount     ${result.fundingAmountACF}`);
  console.log("\n  The executor may now relay it: npm run settlement:execute");
} finally {
  await mongoose.disconnect().catch(() => {});
}
