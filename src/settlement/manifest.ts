import { getAddress } from "viem";
import { config } from "../config.js";
import { RewardSettlementCheckpoint } from "../models/RewardSettlementCheckpoint.js";
import { assertInvariant, canonicalJson, manifestHash, ZERO_ROOT } from "./policy.js";

/**
 * The operator handoff.
 *
 * Funding and finalization are signed by the dedicated executor process, never by the API or
 * the calculation worker. This manifest is what that executor verifies — so no financial number
 * is ever typed by hand, and the script can detect tampering before spending gas.
 */

export interface SettlementManifest {
  chainId: number;
  treasuryAddress: string;
  withdrawalAddress: string;
  checkpointId: number;
  previousCheckpointId: number | null;
  fromRewardEpochId: number | null;
  throughRewardEpochId: number | null;
  previousRoot: string;
  previousPublishedCumulativeTotalACF: string;
  newRoot: string;
  newPublishedCumulativeTotalACF: string;
  publishedDeltaACF: string;
  leafCount: number;
}

export interface SignedManifest {
  manifest: SettlementManifest;
  manifestHash: string;
  canonical: string;
}

export async function buildManifest(checkpointId: number): Promise<SignedManifest> {
  const settle = {
    chainId: config.chainId,
    withdrawalAddress: getAddress(config.withdrawalAddress).toLowerCase(),
  };
  const cp = await RewardSettlementCheckpoint.findOne({ ...settle, checkpointId });
  assertInvariant(cp !== null, `No settlement checkpoint ${checkpointId}.`);
  assertInvariant(
    cp!.status === "CALCULATED" || cp!.status === "AUTHORIZED"
      || cp!.status === "FUNDING_SUBMITTED" || cp!.status === "FUNDED",
    `Checkpoint ${checkpointId} is ${cp!.status}; a manifest is only meaningful before finalization.`,
  );
  assertInvariant(!cp!.legacy, "The legacy checkpoint is already finalized on chain.");

  // A null previousCheckpointId means this is the FIRST checkpoint of the deployment: it chains
  // from the virgin contract's zero baseline, which is derived state and has no document. Only a
  // predecessor that was named but cannot be found is an error.
  const genesis = cp!.previousCheckpointId === null;
  const previous = genesis
    ? null
    : await RewardSettlementCheckpoint.findOne({ ...settle, checkpointId: cp!.previousCheckpointId });
  assertInvariant(
    genesis || previous !== null,
    `Previous checkpoint ${cp!.previousCheckpointId} is missing.`,
  );

  const manifest: SettlementManifest = {
    chainId: cp!.chainId,
    treasuryAddress: getAddress(cp!.treasuryAddress),
    withdrawalAddress: getAddress(cp!.withdrawalAddress),
    checkpointId: cp!.checkpointId,
    previousCheckpointId: cp!.previousCheckpointId ?? null,
    fromRewardEpochId: cp!.fromRewardEpochId ?? null,
    throughRewardEpochId: cp!.throughRewardEpochId ?? null,
    previousRoot: previous?.root ?? ZERO_ROOT,
    previousPublishedCumulativeTotalACF: previous?.publishedCumulativeTotalACF ?? "0",
    newRoot: cp!.root,
    newPublishedCumulativeTotalACF: cp!.publishedCumulativeTotalACF,
    publishedDeltaACF: cp!.publishedDeltaACF,
    leafCount: cp!.leafCount,
  };

  return {
    manifest,
    manifestHash: manifestHash(manifest),
    canonical: canonicalJson(manifest),
  };
}
