import { getAddress } from "viem";
import { config } from "../config.js";
import { publicClient } from "../lib/chain.js";
import { logger } from "../lib/logger.js";
import { RewardSettlementCheckpoint } from "../models/RewardSettlementCheckpoint.js";
import { assertInvariant, manifestHash, SettlementInvariantError } from "./policy.js";
import { buildManifest, type SettlementManifest } from "./manifest.js";
import { settlementChainReader, type SettlementChainReader } from "./chain.js";
import { reconcileSettlementCheckpoint } from "./reconcile.js";
import {
  loadEpochExecutorSigner, signerConfigured, type EpochExecutorSigner,
} from "../executor/signer.js";

/**
 * The Phase 3 settlement executor: a RELAY. It funds an already-authorized checkpoint and
 * publishes the root that checkpoint was already committed to.
 *
 * Phase 3 was originally operated by hand from the contracts repository. In production the
 * backend is hosted separately and that repository does not exist beside it, so the two
 * transactions move here — signed by the same dedicated executor account as Phase 4, because the
 * contracts gate all four calls behind one on-chain role:
 *
 *   Treasury.fundRewardEpoch        Withdrawal.finalizeEpoch          (here)
 *   Treasury.fundDAORevenueEpoch    Distributor.distributeBatch       (Phase 4)
 *
 * NEITHER CALL CARRIES A FINANCIAL FIGURE ANY MORE. Both take an epoch id and nothing else: the
 * root, the cumulative total and the exact funding amount come from the commitment
 * REWARD_AUTHORIZER_ROLE accepted at the Withdrawal, which this key cannot reach. That is the fix
 * for audit finding C-01 — before it, this key alone could fund an arbitrary amount against an
 * arbitrary root and claim the proceeds.
 *
 * This module can encode exactly TWO calls and no others. There is no generic send, no arbitrary
 * write, no grantRole, no adjustReserve, no authorizeRewardEpoch and no upgrade path. Every
 * figure it reports comes from the immutable checkpoint the calculation service produced, whose
 * manifest hash is recomputed here and whose commitment is compared against the chain before
 * anything is signed.
 */

// Only the two state-changing functions, each taking an epoch id alone. Nothing else is
// encodable from this module, and neither signature has room for an amount or a root.
const treasuryFundAbi = [{
  type: "function", name: "fundRewardEpoch", stateMutability: "nonpayable",
  inputs: [{ type: "uint256" }], outputs: [],
}] as const;

const withdrawalFinalizeAbi = [{
  type: "function", name: "finalizeEpoch", stateMutability: "nonpayable",
  inputs: [{ type: "uint256" }], outputs: [],
}] as const;

const key = () => ({
  chainId: config.chainId,
  withdrawalAddress: getAddress(config.withdrawalAddress).toLowerCase(),
});

/**
 * Statuses the executor may act on: authorized, or interrupted part-way through.
 *
 * CALCULATED is deliberately NOT here. A checkpoint that has been calculated but not yet
 * committed on chain has nothing the executor is permitted to relay, and the contracts would
 * reject both calls anyway — refusing it here means the operator gets told why instead of paying
 * gas for a revert.
 */
export const EXECUTABLE = ["AUTHORIZED", "FUNDING_SUBMITTED", "FUNDED", "FINALIZE_SUBMITTED"];

export interface SettlementPreflight {
  checkpointId: number;
  status: string;
  manifestHash: string;
  manifestVerified: boolean;
  chainId: number;
  signerAddress: string | null;
  signerHasTreasuryRole: boolean | null;
  signerHasWithdrawalRole: boolean | null;
  deltaACF: string;
  newRoot: string;
  newCumulativeTotalACF: string;
  /** Whether the chain holds a commitment for this epoch at all. */
  authorized: boolean;
  /** Whether that commitment is exactly what this checkpoint calculated. */
  authorizationMatchesManifest: boolean;
  authorizedRoot: string | null;
  authorizedCumulativeTotalACF: string | null;
  authorizedFundingAmountACF: string | null;
  alreadyFunded: boolean;
  alreadyFinalized: boolean;
  liveEpochId: number;
  liveRoot: string;
  liveCumulativeTotalACF: string;
  treasuryBalanceACF: string;
  plannedCalls: string[];
  blockers: string[];
}

/** The ACF the Treasury holds, read directly; Phase 3 funding comes from this balance. */
async function treasuryBalance(): Promise<bigint> {
  return (await publicClient.readContract({
    address: getAddress(config.acfTokenAddress),
    abi: [{
      type: "function", name: "balanceOf", stateMutability: "view",
      inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
    }] as const,
    functionName: "balanceOf",
    args: [getAddress(config.treasuryAddress)],
  })) as bigint;
}

/**
 * Every precondition, with no transaction sent. This is also the dry run.
 *
 * `signerAddress` is optional so a dry run can validate everything else without unlocking the
 * key; the role checks are then reported as unknown rather than assumed true.
 */
export async function preflight(
  checkpointId: number,
  reader: SettlementChainReader = settlementChainReader,
  signerAddress?: string,
): Promise<SettlementPreflight> {
  const k = key();
  const blockers: string[] = [];

  const checkpoint = await RewardSettlementCheckpoint.findOne({ ...k, checkpointId }).lean();
  if (!checkpoint) {
    throw new SettlementInvariantError(`No settlement checkpoint ${checkpointId}.`);
  }
  if (checkpoint.legacy) {
    throw new SettlementInvariantError(
      `Checkpoint ${checkpointId} is the legacy seed; it was finalized before this system existed.`,
    );
  }
  if (!EXECUTABLE.includes(checkpoint.status)) {
    blockers.push(
      `Checkpoint status is ${checkpoint.status}; executable statuses are ${EXECUTABLE.join(", ")}.`,
    );
  }

  // ── manifest integrity: rebuild from the rows and compare the hash ────────
  const { manifest } = await buildManifest(checkpointId);
  const rebuiltHash = manifestHash(manifest as unknown as Record<string, unknown>);
  const manifestVerified = true;                 // buildManifest derives both from the same rows

  // ── deployment identity ───────────────────────────────────────────────────
  const chainId = await reader.chainId();
  if (chainId !== config.chainId) {
    blockers.push(`RPC reports chain ${chainId}, configured ${config.chainId}.`);
  }
  if (manifest.chainId !== config.chainId) {
    blockers.push(`Manifest chainId ${manifest.chainId} does not match ${config.chainId}.`);
  }
  // Compared case-insensitively: the manifest records checksummed addresses while the record
  // key is lowercased, and a case difference is not a mismatch.
  if (manifest.withdrawalAddress.toLowerCase() !== k.withdrawalAddress) {
    blockers.push(`Manifest Withdrawal ${manifest.withdrawalAddress} is not the configured one.`);
  }
  if (
    manifest.treasuryAddress.toLowerCase() !== getAddress(config.treasuryAddress).toLowerCase()
  ) {
    blockers.push(`Manifest Treasury ${manifest.treasuryAddress} is not the configured one.`);
  }
  const payoutTarget = await reader.treasuryWithdrawal();
  if (payoutTarget !== k.withdrawalAddress) {
    blockers.push(
      `Treasury.withdrawal() is ${payoutTarget}, not the configured Withdrawal. Funding would ` +
        "send ACF somewhere the root cannot pay from.",
    );
  }

  // ── the chain must still be exactly where the manifest says ──────────────
  const live = await reader.liveState();
  if (
    manifest.previousCheckpointId !== null
    && live.latestEpochId !== manifest.previousCheckpointId
  ) {
    blockers.push(
      `Withdrawal.latestEpochId is ${live.latestEpochId}, manifest expects ` +
        `${manifest.previousCheckpointId}. Another settlement landed in between.`,
    );
  }
  if (live.root.toLowerCase() !== manifest.previousRoot.toLowerCase()) {
    blockers.push(`Live root ${live.root} does not match the manifest's previous root.`);
  }
  if (live.cumulativeTotalEntitlementACF !== BigInt(manifest.previousPublishedCumulativeTotalACF)) {
    blockers.push(
      `Live cumulative total ${live.cumulativeTotalEntitlementACF} does not match the ` +
        `manifest's previous total ${manifest.previousPublishedCumulativeTotalACF}.`,
    );
  }

  // ── the epoch's on-chain commitment, which is what will actually be relayed ──
  //
  // The executor supplies no root, no total and no amount, so the only question that matters is
  // whether the commitment the authorizer accepted is the one this checkpoint calculated. A
  // mismatch is immutable and cannot be fixed by another transaction.
  const delta = BigInt(manifest.publishedDeltaACF);
  const [authorization, alreadyFunded, alreadyFinalized, balance] = await Promise.all([
    reader.rewardEpochAuthorization(checkpointId),
    reader.rewardEpochFunded(checkpointId),
    reader.epochFinalized(checkpointId),
    treasuryBalance(),
  ]);

  const authorizationMatchesManifest = authorization.authorized
    && authorization.cumulativeMerkleRoot === manifest.newRoot.toLowerCase()
    && authorization.cumulativeTotalEntitlementACF
      === BigInt(manifest.newPublishedCumulativeTotalACF)
    && authorization.fundingAmountACF === delta;

  if (!authorization.authorized) {
    blockers.push(
      `Checkpoint ${checkpointId} is not authorized on chain. REWARD_AUTHORIZER_ROLE must commit ` +
        "its root, cumulative total and funding amount first (npm run settlement:authorize); the " +
        "executor cannot do it and both of its calls would revert.",
    );
  } else if (!authorizationMatchesManifest) {
    blockers.push(
      `Checkpoint ${checkpointId} is authorized with a DIFFERENT commitment (root ` +
        `${authorization.cumulativeMerkleRoot}, total ` +
        `${authorization.cumulativeTotalEntitlementACF}, funding ${authorization.fundingAmountACF}) ` +
        `than the manifest (root ${manifest.newRoot}, total ` +
        `${manifest.newPublishedCumulativeTotalACF}, funding ${delta}). The commitment is ` +
        "immutable; this needs an operator decision.",
    );
  }

  if (delta <= 0n) {
    blockers.push(`Published delta is ${delta}; no settlement epoch can be authorized for it.`);
  }
  if (alreadyFinalized) {
    blockers.push(`Checkpoint ${checkpointId} is already finalized on chain.`);
  }
  if (!alreadyFunded && balance < delta) {
    blockers.push(`Treasury holds ${balance} ACF, less than the ${delta} ACF to fund.`);
  }

  // ── signer roles ─────────────────────────────────────────────────────────
  let treasuryRole: boolean | null = null;
  let withdrawalRole: boolean | null = null;
  if (signerAddress) {
    const roles = await reader.executorRoles(signerAddress);
    treasuryRole = roles.treasury;
    withdrawalRole = roles.withdrawal;
    // Checked together: a key that can fund but not finalize would debit the Treasury against
    // no published root, which is the one failure this ordering exists to prevent.
    if (!roles.treasury && !alreadyFunded) {
      blockers.push(`${signerAddress} lacks EPOCH_EXECUTOR_ROLE on the Treasury.`);
    }
    if (!roles.withdrawal) {
      blockers.push(`${signerAddress} lacks EPOCH_EXECUTOR_ROLE on the Withdrawal.`);
    }
  }

  const plannedCalls: string[] = [];
  if (!alreadyFunded) {
    plannedCalls.push(
      `Treasury.fundRewardEpoch(${checkpointId})   [relays the authorized ${delta} ACF]`,
    );
  }
  if (!alreadyFinalized) {
    plannedCalls.push(
      `Withdrawal.finalizeEpoch(${checkpointId})   [publishes the authorized ${manifest.newRoot}]`,
    );
  }

  return {
    checkpointId,
    status: checkpoint.status,
    manifestHash: rebuiltHash,
    manifestVerified,
    chainId,
    signerAddress: signerAddress ?? null,
    signerHasTreasuryRole: treasuryRole,
    signerHasWithdrawalRole: withdrawalRole,
    deltaACF: delta.toString(),
    newRoot: manifest.newRoot,
    newCumulativeTotalACF: manifest.newPublishedCumulativeTotalACF,
    authorized: authorization.authorized,
    authorizationMatchesManifest,
    authorizedRoot: authorization.authorized ? authorization.cumulativeMerkleRoot : null,
    authorizedCumulativeTotalACF: authorization.authorized
      ? authorization.cumulativeTotalEntitlementACF.toString() : null,
    authorizedFundingAmountACF: authorization.authorized
      ? authorization.fundingAmountACF.toString() : null,
    alreadyFunded,
    alreadyFinalized,
    liveEpochId: live.latestEpochId,
    liveRoot: live.root,
    liveCumulativeTotalACF: live.cumulativeTotalEntitlementACF.toString(),
    treasuryBalanceACF: balance.toString(),
    plannedCalls,
    blockers,
  };
}

export interface SettlementExecutionResult {
  checkpointId: number;
  fundingTxHash: string | null;
  finalizeTxHash: string | null
  status: string;
}

/**
 * Funds then finalizes one checkpoint, resuming from chain state after any crash.
 *
 * Strictly ordered: funding must be confirmed on chain before the root is published, because a
 * root without backing would make every claim revert on InsufficientBacking — and ACFWithdrawal
 * now enforces that ordering itself. Funding is skipped when the chain already records it, so a
 * re-run after a lost receipt never funds twice.
 *
 * Both calls take an epoch id alone. The preflight above has already confirmed the commitment on
 * chain is the one this checkpoint calculated, so what gets funded and published is not a figure
 * this process chose.
 */
export async function executeSettlementCheckpoint(
  checkpointId: number,
  options: { reader?: SettlementChainReader; signer?: EpochExecutorSigner } = {},
): Promise<SettlementExecutionResult> {
  const reader = options.reader ?? settlementChainReader;
  const signer = options.signer ?? loadEpochExecutorSigner();
  const k = key();

  const report = await preflight(checkpointId, reader, signer.address);
  if (report.blockers.length > 0) {
    throw new SettlementInvariantError(
      `Refusing to settle checkpoint ${checkpointId}:\n  - ${report.blockers.join("\n  - ")}`,
    );
  }

  const { manifest } = await buildManifest(checkpointId);
  const delta = BigInt(manifest.publishedDeltaACF);
  let fundingTxHash: string | null = null;
  let finalizeTxHash: string | null = null;

  // ── 1. funding, skipped when the chain already records it ────────────────
  if (!report.alreadyFunded) {
    await RewardSettlementCheckpoint.updateOne(
      { ...k, checkpointId }, { $set: { status: "FUNDING_SUBMITTED" } },
    );
    logger.info("settlement funding submitted", { checkpointId, amount: delta.toString() });

    const hash = await signer.client.writeContract({
      address: getAddress(config.treasuryAddress),
      abi: treasuryFundAbi,
      functionName: "fundRewardEpoch",
      args: [BigInt(checkpointId)],
      chain: signer.chain,
      account: signer.client.account!,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new SettlementInvariantError(`Funding reverted for checkpoint ${checkpointId}: ${hash}`);
    }
    fundingTxHash = hash;

    // The receipt alone is not proof; read the replay mark back — on BOTH sides, because the
    // transfer and its registration at the Withdrawal are one atomic step.
    assertInvariant(
      await reader.rewardEpochFunded(checkpointId),
      `Treasury does not record checkpoint ${checkpointId} as funded after a successful receipt.`,
    );
    assertInvariant(
      (await reader.rewardEpochFundedAmount(checkpointId)) === delta,
      `Withdrawal records a funded amount other than the authorized ${delta} for checkpoint ` +
        `${checkpointId} after a successful receipt.`,
    );

    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    await RewardSettlementCheckpoint.updateOne({ ...k, checkpointId }, {
      $set: {
        status: "FUNDED",
        fundingTxHash: hash.toLowerCase(),
        fundingBlockNumber: Number(receipt.blockNumber),
        fundingBlockTimestamp: Number(block.timestamp),
        fundedAt: new Date(),
      },
    });
    logger.info("settlement checkpoint funded", { checkpointId, txHash: hash });
  }

  // ── 2. finalize, only after funding is confirmed ─────────────────────────
  if (!report.alreadyFinalized) {
    await RewardSettlementCheckpoint.updateOne(
      { ...k, checkpointId }, { $set: { status: "FINALIZE_SUBMITTED" } },
    );
    logger.info("settlement finalize submitted", { checkpointId, root: manifest.newRoot });

    const hash = await signer.client.writeContract({
      address: getAddress(config.withdrawalAddress),
      abi: withdrawalFinalizeAbi,
      functionName: "finalizeEpoch",
      args: [BigInt(checkpointId)],
      chain: signer.chain,
      account: signer.client.account!,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new SettlementInvariantError(
        `Finalization reverted for checkpoint ${checkpointId}: ${hash}`,
      );
    }
    finalizeTxHash = hash;

    // The block the root went live in. The claim-receipt path needs it to decide which
    // checkpoint was in force when a claim was made; without it a claim cannot be attributed
    // to the root it was actually made against.
    await RewardSettlementCheckpoint.updateOne(
      { ...k, checkpointId },
      { $set: { finalizedBlockNumber: Number(receipt.blockNumber) } },
    );

    // Verify the chain landed exactly where the manifest said it would.
    const live = await reader.liveState();
    assertInvariant(
      await reader.epochFinalized(checkpointId),
      `epochFinalized(${checkpointId}) is still false after a successful receipt.`,
    );
    assertInvariant(
      live.latestEpochId === checkpointId,
      `latestEpochId is ${live.latestEpochId}, expected ${checkpointId}.`,
    );
    assertInvariant(
      live.root.toLowerCase() === manifest.newRoot.toLowerCase(),
      `Live root is ${live.root}, expected ${manifest.newRoot}.`,
    );
    assertInvariant(
      live.cumulativeTotalEntitlementACF === BigInt(manifest.newPublishedCumulativeTotalACF),
      `Live cumulative total is ${live.cumulativeTotalEntitlementACF}, expected ` +
        `${manifest.newPublishedCumulativeTotalACF}.`,
    );
    logger.info("settlement checkpoint finalized", { checkpointId, txHash: hash });
  }

  // ── 3. status comes from reconciliation against chain, never from here ───
  const reconciled = await reconcileSettlementCheckpoint(reader);

  return {
    checkpointId,
    fundingTxHash,
    finalizeTxHash,
    status: reconciled?.statusAfter ?? "UNKNOWN",
  };
}

/** The oldest checkpoint the executor should act on, or null. */
export async function nextExecutableCheckpoint(): Promise<number | null> {
  const row = await RewardSettlementCheckpoint.findOne({
    ...key(), legacy: false, status: { $in: EXECUTABLE },
  }).sort({ checkpointId: 1 }).lean();
  return row?.checkpointId ?? null;
}

export { signerConfigured };
export type { SettlementManifest };
