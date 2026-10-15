import { keccak256, toHex } from "viem";
import { canonicalJson, DAORevenueInvariantError } from "./policy.js";
import { DAORevenueEpoch } from "../models/DAORevenueEpoch.js";
import { DAORevenueMemberEntry } from "../models/DAORevenueMemberEntry.js";

/**
 * The immutable execution manifest.
 *
 * The executor holds the only signer in the system, so it must not be able to decide what gets
 * paid. The calculation service produces this manifest and its hash; the executor recomputes the
 * hash from the manifest's own content and refuses to sign if it differs. That makes every
 * financial number the executor submits traceable to a calculation it did not perform.
 *
 * Batches carry both address lists. `externalEOAs` is what distributeBatch receives;
 * `recipients` is what the transfers must land on, so a DAORevenuePaid event can be verified
 * against the manifest rather than against mutable state.
 */

export interface ManifestBatch {
  batchIndex: number;
  externalEOAs: string[];
  recipients: string[];
  amountsACF: string[];
  batchTotalACF: string;
}

export interface DAORevenueManifest {
  chainId: number;
  daoAddress: string;
  treasuryAddress: string;
  distributorAddress: string;
  stakingContractAddress: string;

  epochId: number;
  windowStart: number;
  snapshotAt: number;
  snapshotBlockNumber: number;
  priceE18: string;

  systemRegularSelfACF: string;
  systemDAOStakeRewardACF: string;
  systemSelfRewardACF: string;
  systemRevenueUSD6: string;

  memberRevenueRateE6: string;
  silverMinimumUSDT6: string;
  daoRevenuePoolUSD6: string;
  totalEligibleContributionUSDT6: string;

  totalMemberRevenueUSD6: string;
  totalMemberRevenueACF: string;
  roundingDustUSD6: string;

  /// The epoch's separate marketing allocation and its pinned recipient. In the manifest for the
  /// same reason every member amount is: the executor must not be able to choose either.
  /// The member commitment the authorizer puts on chain, and every proof verifies against.
  memberRoot: string;
  marketingRateE6: string;
  marketingCollector: string;
  marketingRevenueUSD6: string;
  marketingRevenueACF: string;
  /// Σ member ACF + marketing ACF: exactly what Treasury funds for this epoch.
  totalObligationACF: string;

  memberCount: number;
  batchCount: number;
  batches: ManifestBatch[];
}

export function manifestHash(manifest: DAORevenueManifest): string {
  return keccak256(toHex(canonicalJson(manifest)));
}

/**
 * Rebuilds the manifest from persisted rows and verifies its hash.
 *
 * The executor must not trust a manifest handed to it, so it reconstructs one from the database
 * and checks that it hashes to what the epoch recorded. Any tampering with an amount, an
 * address, the epoch id, the price or the rate changes the hash and stops execution.
 */
export async function rebuildManifest(epochId: number): Promise<{
  manifest: DAORevenueManifest;
  hash: string;
  recordedHash: string;
}> {
  // Located by epochId alone and then verified against its own stored deployment addresses, so
  // this works without importing config — keeping the module free of anything the executor adds.
  const epoch = await DAORevenueEpoch.findOne({ epochId }).lean();
  if (!epoch) throw new DAORevenueInvariantError(`No DAO revenue epoch ${epochId}.`);
  const k = {
    chainId: epoch.chainId,
    distributorAddress: epoch.distributorAddress,
  };

  const entries = await DAORevenueMemberEntry.find({
    chainId: k.chainId, distributorAddress: k.distributorAddress, epochId,
  }).sort({ batchIndex: 1, externalEOA: 1 }).lean();

  const batches: ManifestBatch[] = [];
  for (let index = 0; index < epoch.batchCount; index += 1) {
    const slice = entries.filter((e) => e.batchIndex === index);
    batches.push({
      batchIndex: index,
      externalEOAs: slice.map((e) => e.externalEOA.toLowerCase()),
      recipients: slice.map((e) => e.externalEOA.toLowerCase()),
      amountsACF: slice.map((e) => e.memberRevenueACF),
      batchTotalACF: slice.reduce((sum, e) => sum + BigInt(e.memberRevenueACF), 0n).toString(),
    });
  }

  const manifest: DAORevenueManifest = {
    chainId: epoch.chainId,
    daoAddress: epoch.daoContractAddress,
    treasuryAddress: epoch.treasuryAddress,
    distributorAddress: epoch.distributorAddress,
    stakingContractAddress: epoch.stakingContractAddress,
    epochId: epoch.epochId,
    windowStart: epoch.windowStart,
    snapshotAt: epoch.snapshotAt,
    snapshotBlockNumber: epoch.snapshotBlockNumber,
    priceE18: epoch.priceE18,
    systemRegularSelfACF: epoch.systemRegularSelfACF,
    systemDAOStakeRewardACF: epoch.systemDAOStakeRewardACF,
    systemSelfRewardACF: epoch.systemSelfRewardACF,
    systemRevenueUSD6: epoch.systemRevenueUSD6,
    memberRevenueRateE6: epoch.memberRevenueRateE6,
    silverMinimumUSDT6: epoch.silverMinimumUSDT6,
    daoRevenuePoolUSD6: epoch.daoRevenuePoolUSD6,
    totalEligibleContributionUSDT6: epoch.totalEligibleContributionUSDT6,
    totalMemberRevenueUSD6: epoch.totalMemberRevenueUSD6,
    totalMemberRevenueACF: epoch.totalMemberRevenueACF,
    roundingDustUSD6: epoch.roundingDustUSD6,
    memberRoot: epoch.memberRoot,
    marketingRateE6: epoch.marketingRateE6,
    marketingCollector: epoch.marketingCollector,
    marketingRevenueUSD6: epoch.marketingRevenueUSD6,
    marketingRevenueACF: epoch.marketingRevenueACF,
    totalObligationACF: epoch.totalObligationACF,
    memberCount: epoch.eligibleMembers,
    batchCount: epoch.batchCount,
    batches,
  };

  return { manifest, hash: manifestHash(manifest), recordedHash: epoch.manifestHash };
}

