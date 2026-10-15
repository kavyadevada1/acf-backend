import mongoose from "mongoose";
import { connectDatabase } from "../src/db.js";
import { logger } from "../src/lib/logger.js";
import { config } from "../src/config.js";
import { authorizeDAORevenueEpoch, AUTHORIZABLE } from "../src/daoRevenue/authorize.js";
import { DAORevenueEpoch } from "../src/models/DAORevenueEpoch.js";
import { authorizerConfigured, loadDAORevenueAuthorizerSigner } from "../src/executor/signer.js";
import { getAddress } from "viem";

/**
 * DAO Revenue AUTHORIZER — commits what an epoch may pay, and nothing else.
 *
 * A separate entry point from the executor on purpose. This process holds the authorizing key and
 * cannot fund or transfer anything; the executor holds the relaying key and cannot authorize. Run
 * them under different credentials, ideally on different hosts: the whole protection is that one
 * compromised key cannot both decide a payable set and move money against it.
 *
 *   npm run dao-revenue:authorize -- --dry-run        reads only, signs nothing
 *   npm run dao-revenue:authorize                     authorizes the oldest CALCULATED epoch
 *   npm run dao-revenue:authorize -- --epoch=<id>     a specific epoch
 *
 * Idempotent against the chain: an epoch already authorized is reported as done, and its
 * on-chain commitment is checked against what the epoch calculated rather than assumed to match.
 */

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const dryRun = process.argv.includes("--dry-run");

const key = () => ({
  chainId: config.chainId,
  daoContractAddress: getAddress(config.acfDaoAddress).toLowerCase(),
  distributorAddress: getAddress(config.daoRevenueDistributorAddress).toLowerCase(),
});

async function nextAuthorizableEpoch(): Promise<number | null> {
  const row = await DAORevenueEpoch.findOne(
    { ...key(), status: { $in: AUTHORIZABLE } }, { epochId: 1 },
  ).sort({ epochId: 1 }).lean();
  return row?.epochId ?? null;
}

await connectDatabase();
try {
  const explicit = arg("epoch");
  const epochId = explicit ? Number(explicit) : await nextAuthorizableEpoch();

  if (epochId === null) {
    logger.info("no DAO revenue epoch is waiting to be authorized");
  } else if (dryRun) {
    const epoch = await DAORevenueEpoch.findOne({ ...key(), epochId }).lean();
    logger.info("dao revenue authorization dry run", {
      epochId,
      status: epoch?.status ?? "MISSING",
      memberRoot: epoch?.memberRoot,
      memberTotalACF: epoch?.totalMemberRevenueACF,
      marketingRecipient: epoch?.marketingCollector,
      marketingAmountACF: epoch?.marketingRevenueACF,
      totalObligationACF: epoch?.totalObligationACF,
      authorizerConfigured: authorizerConfigured(),
    });
  } else {
    // Loaded before anything is read, so a missing or collapsed key fails immediately rather
    // than after the work of rebuilding the manifest.
    const signer = loadDAORevenueAuthorizerSigner();
    logger.info("authorizing dao revenue epoch", { epochId, authorizer: signer.address });
    const result = await authorizeDAORevenueEpoch(epochId);
    logger.info("dao revenue epoch authorized", { ...result });
  }
} catch (error) {
  logger.error("dao revenue authorization failed", { error: (error as Error).message });
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
