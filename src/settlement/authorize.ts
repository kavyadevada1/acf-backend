import { getAddress, parseEventLogs, type Log } from "viem";
import { config } from "../config.js";
import { publicClient } from "../lib/chain.js";
import { logger } from "../lib/logger.js";
import { RewardSettlementCheckpoint } from "../models/RewardSettlementCheckpoint.js";
import { assertInvariant, manifestHash, SettlementInvariantError } from "./policy.js";
import { buildManifest } from "./manifest.js";
import { settlementChainReader, type SettlementChainReader } from "./chain.js";
import { loadRewardAuthorizerSigner, rewardAuthorizerConfigured } from "../executor/signer.js";

/**
 * AUTHORIZE: committing what a settlement epoch may publish and cost, before anything can fund it.
 *
 * This is a deliberately separate step, run by a deliberately separate key. The executor that
 * funds and finalizes cannot reach `authorizeRewardEpoch`, so it can never decide which Merkle
 * root becomes claimable, how large the obligation is, or how much ACF leaves Treasury — only
 * relay what this step already committed.
 *
 *   CALCULATE   the backend derives the leaves, the root, the cumulative total and the delta
 *   AUTHORIZE   this step commits root + cumulative total + funding amount on chain, immutably
 *   EXECUTE     the executor funds the authorized amount and publishes the authorized root
 *   RECONCILE   chain evidence decides what actually happened
 *
 * Letting EXECUTE imply AUTHORIZE is audit finding C-01: a compromised executor key could build a
 * one-leaf tree paying itself, fund it from Treasury and finalize it. So this never runs from the
 * executor path and never touches the executor's signer.
 *
 * This module can encode exactly ONE call and no others. There is no generic send, no funding, no
 * finalization, no claim and no role change.
 *
 * Idempotent against the CHAIN, not against the database: an epoch the chain already reports as
 * authorized is accepted as done and the local row is brought into line, so a crash between a
 * confirmed transaction and the write costs a re-read and nothing else. A chain commitment that
 * disagrees with what was calculated is a hard failure — the commitment is immutable, so it
 * cannot be corrected by authorizing again.
 */

// The only state-changing function this module can reach.
const authorizeRewardEpochAbi = [{
  type: "function", name: "authorizeRewardEpoch", stateMutability: "nonpayable",
  inputs: [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
  outputs: [],
}] as const;

const rewardEpochAuthorizedEventAbi = {
  type: "event",
  name: "RewardEpochAuthorized",
  inputs: [
    { name: "epochId", type: "uint256", indexed: true },
    { name: "cumulativeMerkleRoot", type: "bytes32", indexed: true },
    { name: "cumulativeTotalEntitlementACF", type: "uint256", indexed: false },
    { name: "fundingAmountACF", type: "uint256", indexed: false },
    { name: "authorizer", type: "address", indexed: true },
  ],
} as const;

const key = () => ({
  chainId: config.chainId,
  withdrawalAddress: getAddress(config.withdrawalAddress).toLowerCase(),
});

/** Statuses from which authorizing is the next step. */
export const AUTHORIZABLE = ["CALCULATED"];

export interface SettlementAuthorizationPreflight {
  checkpointId: number;
  status: string;
  manifestHash: string;
  chainId: number;
  authorizerAddress: string | null;
  authorizerHasRole: boolean | null;
  root: string;
  cumulativeTotalACF: string;
  fundingAmountACF: string;
  alreadyAuthorized: boolean;
  /** Present only when the chain already holds a commitment for this epoch. */
  onChainRoot: string | null;
  onChainCumulativeTotalACF: string | null;
  onChainFundingAmountACF: string | null;
  commitmentMatches: boolean | null;
  withdrawalTreasury: string;
  plannedCalls: string[];
  blockers: string[];
}

export interface SettlementAuthorizationResult {
  checkpointId: number;
  authorized: boolean;
  /** Null when the chain already held the commitment and nothing was submitted. */
  txHash: string | null;
  root: string;
  cumulativeTotalACF: string;
  fundingAmountACF: string;
}

/**
 * The three figures this epoch commits to, rebuilt from the persisted rows.
 *
 * Nothing here is recomputed from live chain state and nothing is accepted from a CLI argument:
 * authorizing twice after a restart therefore commits the same values or fails loudly, rather
 * than committing different ones.
 */
async function commitment(checkpointId: number) {
  const { manifest } = await buildManifest(checkpointId);
  const rebuiltHash = manifestHash(manifest as unknown as Record<string, unknown>);
  const root = manifest.newRoot.toLowerCase() as `0x${string}`;
  const total = BigInt(manifest.newPublishedCumulativeTotalACF);
  const funding = BigInt(manifest.publishedDeltaACF);
  // The delta IS the funding amount, and the published total must be the previous total plus it.
  // Re-derived here rather than trusted: the contract does not police the relationship, so this
  // is the only place it is checked before the figures become immutable.
  assertInvariant(
    BigInt(manifest.previousPublishedCumulativeTotalACF) + funding === total,
    `Checkpoint ${checkpointId} is internally inconsistent: previous total ` +
      `${manifest.previousPublishedCumulativeTotalACF} + delta ${funding} != new total ${total}.`,
  );
  assertInvariant(
    funding > 0n,
    `Checkpoint ${checkpointId} has a non-positive funding amount ${funding}; a settlement epoch ` +
      "only exists when the cumulative total strictly increases.",
  );
  assertInvariant(
    root !== `0x${"0".repeat(64)}`,
    `Checkpoint ${checkpointId} has a zero root; the contract refuses to commit one.`,
  );
  return { manifest, rebuiltHash, root, total, funding };
}

/** Every precondition, with no transaction sent. This is also the dry run. */
export async function authorizePreflight(
  checkpointId: number,
  reader: SettlementChainReader = settlementChainReader,
  authorizerAddress?: string,
): Promise<SettlementAuthorizationPreflight> {
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

  const { rebuiltHash, root, total, funding } = await commitment(checkpointId);

  const chainId = await reader.chainId();
  if (chainId !== config.chainId) {
    blockers.push(`RPC reports chain ${chainId}, configured ${config.chainId}.`);
  }

  // The authorize/execute split only exists once ACFWithdrawal is bound to canonical Treasury.
  const withdrawalTreasury = await reader.withdrawalTreasury();
  if (withdrawalTreasury !== getAddress(config.treasuryAddress).toLowerCase()) {
    blockers.push(
      `ACFWithdrawal.treasury() is ${withdrawalTreasury}, not the configured Treasury ` +
        `${getAddress(config.treasuryAddress)}. Funding could not be registered, so authorizing ` +
        "would commit an epoch nobody can fund.",
    );
  }

  const existing = await reader.rewardEpochAuthorization(checkpointId);
  let commitmentMatches: boolean | null = null;
  if (existing.authorized) {
    commitmentMatches = existing.cumulativeMerkleRoot === root
      && existing.cumulativeTotalEntitlementACF === total
      && existing.fundingAmountACF === funding;
    if (!commitmentMatches) {
      blockers.push(
        `Checkpoint ${checkpointId} is already authorized on chain with a DIFFERENT commitment ` +
          `(root ${existing.cumulativeMerkleRoot}, total ${existing.cumulativeTotalEntitlementACF}, ` +
          `funding ${existing.fundingAmountACF}). The commitment is immutable; this needs an ` +
          "operator decision.",
      );
    }
  } else if (!AUTHORIZABLE.includes(checkpoint.status)) {
    blockers.push(
      `Checkpoint status is ${checkpoint.status}; authorizable statuses are ${AUTHORIZABLE.join(", ")}.`,
    );
  }

  if (await reader.epochFinalized(checkpointId)) {
    blockers.push(`Checkpoint ${checkpointId} is already finalized on chain.`);
  }

  // Monotonicity, as the contract will check it at commitment time.
  const live = await reader.liveState();
  if (total < live.cumulativeTotalEntitlementACF) {
    blockers.push(
      `Cumulative total ${total} is below the live ${live.cumulativeTotalEntitlementACF}; the ` +
        "contract refuses a decrease. Another settlement landed in between.",
    );
  }
  if (total < live.totalClaimedACF) {
    blockers.push(`Cumulative total ${total} is below the ${live.totalClaimedACF} already claimed.`);
  }

  let authorizerHasRole: boolean | null = null;
  if (authorizerAddress) {
    authorizerHasRole = await reader.rewardAuthorizerRole(authorizerAddress);
    if (!authorizerHasRole) {
      blockers.push(`${authorizerAddress} lacks REWARD_AUTHORIZER_ROLE on the Withdrawal.`);
    }
    // The separation is the whole protection, so it is checked against the LIVE roles too, not
    // only against the two environment variables.
    const relays = await reader.executorRoles(authorizerAddress);
    if (relays.treasury || relays.withdrawal) {
      blockers.push(
        `${authorizerAddress} also holds EPOCH_EXECUTOR_ROLE (Treasury ${relays.treasury}, ` +
          `Withdrawal ${relays.withdrawal}). One key must not both commit a settlement and relay it.`,
      );
    }
  }

  return {
    checkpointId,
    status: checkpoint.status,
    manifestHash: rebuiltHash,
    chainId,
    authorizerAddress: authorizerAddress ?? null,
    authorizerHasRole,
    root,
    cumulativeTotalACF: total.toString(),
    fundingAmountACF: funding.toString(),
    alreadyAuthorized: existing.authorized,
    onChainRoot: existing.authorized ? existing.cumulativeMerkleRoot : null,
    onChainCumulativeTotalACF: existing.authorized
      ? existing.cumulativeTotalEntitlementACF.toString() : null,
    onChainFundingAmountACF: existing.authorized ? existing.fundingAmountACF.toString() : null,
    commitmentMatches,
    withdrawalTreasury,
    plannedCalls: existing.authorized
      ? []
      : [`Withdrawal.authorizeRewardEpoch(${checkpointId}, ${root}, ${total}, ${funding})`],
    blockers,
  };
}

/** Commits one checkpoint's root, cumulative total and funding amount on chain. */
export async function authorizeSettlementCheckpoint(
  checkpointId: number,
  options: { reader?: SettlementChainReader } = {},
): Promise<SettlementAuthorizationResult> {
  const reader = options.reader ?? settlementChainReader;
  const k = key();
  // Loaded before anything is read, so a missing or collapsed key fails immediately rather than
  // after the work of rebuilding the manifest.
  const signer = loadRewardAuthorizerSigner();

  const report = await authorizePreflight(checkpointId, reader, signer.address);
  if (report.blockers.length > 0) {
    throw new SettlementInvariantError(
      `Refusing to authorize checkpoint ${checkpointId}:\n  - ${report.blockers.join("\n  - ")}`,
    );
  }

  const { root, total, funding } = await commitment(checkpointId);

  // Already committed, and verified above to be exactly these figures. Bring the row into line.
  if (report.alreadyAuthorized) {
    await markAuthorized(k, checkpointId, {});
    logger.info("settlement checkpoint already authorized on chain", { checkpointId });
    return describe(checkpointId, null, root, total, funding);
  }

  logger.info("settlement authorization submitted", {
    checkpointId, root, cumulativeTotalACF: total.toString(),
    fundingAmountACF: funding.toString(), authorizer: signer.address,
  });

  const txHash = await signer.client.writeContract({
    address: getAddress(config.withdrawalAddress),
    abi: authorizeRewardEpochAbi,
    functionName: "authorizeRewardEpoch",
    args: [BigInt(checkpointId), root, total, funding],
    chain: signer.chain,
    account: signer.client.account!,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new SettlementInvariantError(
      `Authorization reverted for checkpoint ${checkpointId}: ${txHash}`,
    );
  }

  // Verified against the EVENT and then re-read from state, not from the receipt: what matters is
  // that the chain now holds exactly this commitment.
  const events = parseEventLogs({ abi: [rewardEpochAuthorizedEventAbi], logs: receipt.logs as Log[] })
    .filter((event) => Number(event.args.epochId) === checkpointId);
  assertInvariant(
    events.length === 1,
    `Checkpoint ${checkpointId} authorization emitted ${events.length} events, expected 1.`,
  );
  const stored = await reader.rewardEpochAuthorization(checkpointId);
  assertInvariant(
    stored.authorized
      && stored.cumulativeMerkleRoot === root
      && stored.cumulativeTotalEntitlementACF === total
      && stored.fundingAmountACF === funding,
    `Checkpoint ${checkpointId} authorization did not store the expected commitment.`,
  );

  await markAuthorized(k, checkpointId, {
    authorizationTxHash: txHash.toLowerCase(),
    authorizationBlockNumber: Number(receipt.blockNumber),
  });
  logger.info("settlement checkpoint authorized", { checkpointId, txHash });
  return describe(checkpointId, txHash, root, total, funding);
}

async function markAuthorized(
  k: ReturnType<typeof key>, checkpointId: number, extra: Record<string, unknown>,
): Promise<void> {
  await RewardSettlementCheckpoint.updateOne(
    { ...k, checkpointId, status: { $in: AUTHORIZABLE } },
    { $set: { status: "AUTHORIZED", authorizedAt: new Date(), leaseExpiresAt: null, ...extra } },
  );
  // A row already past CALCULATED keeps its later status: funding or finalization has begun, and
  // moving it backwards would misreport progress. The audit trail is still worth filling in.
  if (Object.keys(extra).length > 0) {
    await RewardSettlementCheckpoint.updateOne(
      { ...k, checkpointId, authorizationTxHash: null }, { $set: extra },
    );
  }
}

function describe(
  checkpointId: number, txHash: string | null, root: string, total: bigint, funding: bigint,
): SettlementAuthorizationResult {
  return {
    checkpointId,
    authorized: true,
    txHash,
    root,
    cumulativeTotalACF: total.toString(),
    fundingAmountACF: funding.toString(),
  };
}

/** The oldest checkpoint waiting to be authorized, or null. */
export async function nextAuthorizableCheckpoint(): Promise<number | null> {
  const row = await RewardSettlementCheckpoint.findOne({
    ...key(), legacy: false, status: { $in: AUTHORIZABLE },
  }).sort({ checkpointId: 1 }).lean();
  return row?.checkpointId ?? null;
}

export { rewardAuthorizerConfigured };
