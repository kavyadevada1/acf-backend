import { getAddress, parseEventLogs, type Log } from "viem";
import { config } from "../config.js";
import { publicClient } from "../lib/chain.js";
import { logger } from "../lib/logger.js";
import { DAORevenueEpoch } from "../models/DAORevenueEpoch.js";
import { rebuildManifest } from "./manifest.js";
import { assertInvariant, DAORevenueInvariantError } from "./policy.js";
import {
  daoRevenueChainReader, daoRevenueEpochAuthorizedEventAbi, type DAORevenueChainReader,
} from "./chain.js";
import { loadDAORevenueAuthorizerSigner } from "../executor/signer.js";

/**
 * AUTHORIZE: committing what a DAO revenue epoch may pay, before anything can pay it.
 *
 * This is a deliberately separate step, run by a deliberately separate key. The executor that
 * funds and relays cannot reach `authorizeEpoch`, so it can never decide who is entitled to
 * protocol funds — only move what this step already committed.
 *
 *   CALCULATE   the backend derives the member set, the totals and the marketing allocation
 *   AUTHORIZE   this step commits the member root, both totals and the recipient on chain
 *   EXECUTE     the executor funds the exact authorized total and relays proved transfers
 *   RECONCILE   chain evidence decides what actually happened
 *
 * Letting EXECUTE imply AUTHORIZE would collapse the whole model, which is why this never runs
 * from the executor path and never uses the executor's signer.
 *
 * Idempotent against the chain, not against the database: an epoch the chain already reports as
 * authorized is accepted as done and the local row is brought into line, so a crash between a
 * confirmed transaction and the write costs a re-read and nothing else.
 */

const key = () => ({
  chainId: config.chainId,
  daoContractAddress: getAddress(config.acfDaoAddress).toLowerCase(),
  distributorAddress: getAddress(config.daoRevenueDistributorAddress).toLowerCase(),
});

const authorizeEpochAbi = [{
  type: "function", name: "authorizeEpoch", stateMutability: "nonpayable",
  inputs: [
    { type: "uint256" }, { type: "bytes32" }, { type: "uint256" },
    { type: "address" }, { type: "uint256" },
  ],
  outputs: [],
}] as const;

/** Statuses from which authorizing is the next step. */
export const AUTHORIZABLE = ["CALCULATED"];

export interface AuthorizationResult {
  epochId: number;
  authorized: boolean;
  /** Null when the chain already held the authorization and nothing was submitted. */
  txHash: string | null;
  memberRoot: string;
  memberTotalACF: string;
  marketingRecipient: string;
  marketingAmountACF: string;
  totalObligationACF: string;
}

export async function authorizeDAORevenueEpoch(
  epochId: number,
  reader: DAORevenueChainReader = daoRevenueChainReader,
): Promise<AuthorizationResult> {
  const k = key();
  const epoch = await DAORevenueEpoch.findOne({ ...k, epochId }).lean();
  if (!epoch) throw new DAORevenueInvariantError(`DAO revenue epoch ${epochId} has no record.`);
  if (epoch.status === "NOTHING_TO_DISTRIBUTE") {
    throw new DAORevenueInvariantError(
      `Epoch ${epochId} owes nothing, so there is nothing to authorize.`,
    );
  }

  // Every figure comes from the manifest whose hash the calculation recorded, re-derived from the
  // persisted member rows. Nothing here is recomputed from live state, so authorizing twice after
  // a restart commits the same values or fails loudly rather than committing different ones.
  const { manifest, hash, recordedHash } = await rebuildManifest(epochId);
  assertInvariant(
    hash === recordedHash,
    `Epoch ${epochId} manifest hash ${hash} does not match the recorded ${recordedHash}. ` +
      "Refusing to authorize a payable set that does not match what was calculated.",
  );

  const memberRoot = manifest.memberRoot as `0x${string}`;
  const memberTotal = BigInt(manifest.totalMemberRevenueACF);
  const marketingAmount = BigInt(manifest.marketingRevenueACF);
  const marketingRecipient = marketingAmount === 0n
    ? ZERO_ADDRESS
    : getAddress(manifest.marketingCollector);
  const total = BigInt(manifest.totalObligationACF);
  assertInvariant(
    memberTotal + marketingAmount === total,
    `Epoch ${epochId} totals disagree: ${memberTotal} + ${marketingAmount} != ${total}.`,
  );

  // Already committed? The chain is the authority. Accept it, and verify it says what this epoch
  // calculated — a disagreement means the on-chain commitment is not this payable set, which
  // cannot be corrected by authorizing again because the commitment is immutable.
  const existing = await reader.epochAuthorization(epochId);
  if (existing.authorized) {
    assertInvariant(
      existing.memberRoot === memberRoot.toLowerCase()
        && existing.memberTotalACF === memberTotal
        && existing.marketingRecipient === marketingRecipient.toLowerCase()
        && existing.marketingAmountACF === marketingAmount,
      `Epoch ${epochId} is already authorized on chain with a DIFFERENT payable set ` +
        `(root ${existing.memberRoot}, members ${existing.memberTotalACF}, marketing ` +
        `${existing.marketingAmountACF} to ${existing.marketingRecipient}). The commitment is ` +
        "immutable; this needs an operator decision.",
    );
    await markAuthorized(k, epochId, {});
    return describe(epochId, null, manifest);
  }

  const signer = loadDAORevenueAuthorizerSigner();
  logger.info("dao revenue epoch authorization submitted", {
    epochId, memberRoot, memberTotal: memberTotal.toString(),
    marketingAmount: marketingAmount.toString(), authorizer: signer.address,
  });

  const txHash = await signer.client.writeContract({
    address: getAddress(config.daoRevenueDistributorAddress),
    abi: authorizeEpochAbi,
    functionName: "authorizeEpoch",
    args: [BigInt(epochId), memberRoot, memberTotal, marketingRecipient, marketingAmount],
    chain: signer.chain,
    account: signer.client.account!,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new DAORevenueInvariantError(`Authorization reverted for epoch ${epochId}: ${txHash}`);
  }

  // Verified against the EVENT and then re-read from state, not from the receipt: what matters is
  // that the chain now holds exactly this payable set.
  const events = parseEventLogs({
    abi: [daoRevenueEpochAuthorizedEventAbi], logs: receipt.logs as Log[],
  }).filter((event) => Number(event.args.epochId) === epochId);
  assertInvariant(
    events.length === 1,
    `Epoch ${epochId} authorization emitted ${events.length} events, expected 1.`,
  );
  const stored = await reader.epochAuthorization(epochId);
  assertInvariant(
    stored.authorized
      && stored.memberRoot === memberRoot.toLowerCase()
      && stored.memberTotalACF === memberTotal
      && stored.marketingRecipient === marketingRecipient.toLowerCase()
      && stored.marketingAmountACF === marketingAmount
      && stored.totalObligationACF === total,
    `Epoch ${epochId} authorization did not store the expected payable set.`,
  );

  await markAuthorized(k, epochId, {
    authorizationTxHash: txHash.toLowerCase(),
    authorizationBlockNumber: Number(receipt.blockNumber),
  });
  logger.info("dao revenue epoch authorized", { epochId, txHash });
  return describe(epochId, txHash, manifest);
}

const ZERO_ADDRESS = `0x${"0".repeat(40)}` as `0x${string}`;

async function markAuthorized(
  k: ReturnType<typeof key>, epochId: number, extra: Record<string, unknown>,
): Promise<void> {
  await DAORevenueEpoch.updateOne(
    { ...k, epochId, status: { $in: AUTHORIZABLE } },
    { $set: { status: "AUTHORIZED", authorizedAt: new Date(), leaseExpiresAt: null, ...extra } },
  );
  // A row already past CALCULATED keeps its later status: funding or distribution has begun, and
  // moving it backwards would misreport progress.
  if (Object.keys(extra).length > 0) {
    await DAORevenueEpoch.updateOne({ ...k, epochId, authorizationTxHash: null }, { $set: extra });
  }
}

function describe(
  epochId: number, txHash: string | null,
  manifest: Awaited<ReturnType<typeof rebuildManifest>>["manifest"],
): AuthorizationResult {
  return {
    epochId,
    authorized: true,
    txHash,
    memberRoot: manifest.memberRoot,
    memberTotalACF: manifest.totalMemberRevenueACF,
    marketingRecipient: manifest.marketingCollector,
    marketingAmountACF: manifest.marketingRevenueACF,
    totalObligationACF: manifest.totalObligationACF,
  };
}
