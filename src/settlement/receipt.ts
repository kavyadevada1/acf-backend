import { decodeEventLog, getAddress } from "viem";
import { config } from "../config.js";
import { publicClient } from "../lib/chain.js";
import { HttpError } from "../lib/errors.js";
import { User } from "../models/User.js";
import { RewardClaim } from "../models/RewardClaim.js";
import { RewardSettlementCheckpoint } from "../models/RewardSettlementCheckpoint.js";
import { UserRewardCheckpoint } from "../models/UserRewardCheckpoint.js";
import { rewardClaimedEventAbi, settlementChainReader, type SettlementChainReader } from "./chain.js";
import { reconcileClaimStates } from "./reconcile.js";

/**
 * Validates ONE claim receipt the frontend reports, for audit enrichment.
 *
 * A user-supplied transaction hash is just a string until every one of these holds, so each is
 * checked: the receipt succeeded, it went to the configured Withdrawal, it carries a
 * RewardClaimed from that contract, the beneficiary is the caller's OWN address, and the event's
 * cumulative pair agrees with the chain.
 *
 * Financial state is not derived from here — the claim watermark comes from
 * alreadyClaimed(user), so a receipt that never arrives costs only metadata.
 */

export interface ClaimReceiptResult {
  recorded: boolean;
  alreadyPresent: boolean;
  checkpointId: number;
  claimedACF: string;
  usdtFee: string;
}

export async function recordClaimReceipt(
  userId: string,
  txHash: string,
  reader: SettlementChainReader = settlementChainReader,
): Promise<ClaimReceiptResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new HttpError(400, "INVALID_TX_HASH", "That is not a transaction hash.");
  }
  const settle = {
    chainId: config.chainId,
    withdrawalAddress: getAddress(config.withdrawalAddress).toLowerCase(),
  };

  const user = await User.findOne({ userId }, { externalEOA: 1 }).lean();
  if (!user?.externalEOA) {
    // `externalEOA` is required and immutable on every user, so this is an integrity failure
    // rather than a state a caller can be in.
    throw new HttpError(500, "INTERNAL_ERROR", "This account has no address on record.");
  }
  const claimant = user.externalEOA.toLowerCase();

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
  if (receipt.status !== "success") {
    throw new HttpError(422, "RECEIPT_FAILED", "That transaction did not succeed.");
  }

  /**
   * The transaction's `to` is deliberately NOT checked.
   *
   * ACFWithdrawal builds its Merkle leaf from `_msgSender()`, and the user signs the claim
   * themselves, so a direct claim does target the Withdrawal. The guard is still omitted because
   * it would be the weaker of two checks and would reject legitimate claims: the search below
   * requires a RewardClaimed event emitted BY the Withdrawal address, which binds the
   * transaction to the contract far more tightly than a `to` field can, and the beneficiary
   * check then binds it to this user. A caller routing their own claim through a contract they
   * control still satisfies both.
   */

  // Find the RewardClaimed log emitted BY the Withdrawal contract.
  let decoded: { args: Record<string, unknown> } | null = null;
  let logIndex = -1;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== settle.withdrawalAddress) continue;
    try {
      const d = decodeEventLog({
        abi: [rewardClaimedEventAbi], data: log.data, topics: log.topics,
      });
      if (d.eventName === "RewardClaimed") {
        decoded = { args: d.args as unknown as Record<string, unknown> };
        logIndex = log.logIndex;
        break;
      }
    } catch {
      continue;                                  // an unrelated log from the same address
    }
  }
  if (!decoded) {
    throw new HttpError(422, "NO_CLAIM_EVENT", "That transaction emitted no RewardClaimed event.");
  }

  const beneficiary = String(decoded.args.beneficiary).toLowerCase();
  if (beneficiary !== claimant) {
    throw new HttpError(
      403, "NOT_YOUR_CLAIM",
      "That claim belongs to a different address.",
    );
  }

  const cumulativeSelf = decoded.args.cumulativeSelfACF as bigint;
  const cumulativeTeam = decoded.args.cumulativeTeamACF as bigint;

  const onChain = await reader.alreadyClaimed([claimant]);
  if ((onChain.get(claimant) ?? 0n) !== cumulativeSelf + cumulativeTeam) {
    throw new HttpError(
      409, "CLAIM_SUPERSEDED",
      "The event's cumulative total no longer matches this account's on-chain claimed amount.",
    );
  }

  /**
   * Resolve the checkpoint that was LIVE at the claim's block — not the current root, which may
   * since have been replaced.
   *
   * A checkpoint finalized AFTER the claim is excluded by block number. A null block number is
   * allowed rather than excluded: checkpoints finalized before the executor began recording it
   * carry none, and excluding them made every claim unresolvable. The cumulative-value match
   * below is what actually identifies the checkpoint — those amounts can only have come from
   * the root that published them — so a missing block costs precision, not correctness.
   */
  const candidates = await RewardSettlementCheckpoint.find(
    {
      ...settle, status: "FINALIZED",
      $or: [
        { finalizedBlockNumber: null },
        { finalizedBlockNumber: { $lte: Number(receipt.blockNumber) } },
      ],
    },
    { checkpointId: 1 },
  ).sort({ checkpointId: -1 }).lean();

  let checkpointId: number | null = null;
  for (const c of candidates) {
    const row = await UserRewardCheckpoint.findOne({
      ...settle, checkpointId: c.checkpointId, userId,
    }, { cumulativeSelfACF: 1, cumulativeTeamACF: 1 }).lean();
    if (row
      && BigInt(row.cumulativeSelfACF) === cumulativeSelf
      && BigInt(row.cumulativeTeamACF) === cumulativeTeam) {
      checkpointId = c.checkpointId;
      break;
    }
  }
  if (checkpointId === null) {
    throw new HttpError(
      422, "CHECKPOINT_UNRESOLVED",
      "No finalized checkpoint at or before that block publishes those cumulative values.",
    );
  }

  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const existing = await RewardClaim.findOne({
    ...settle, txHash: txHash.toLowerCase(), logIndex,
  });
  const claimedACF = String(decoded.args.claimedACF);
  const usdtFee = String(decoded.args.usdtFee);

  if (!existing) {
    await RewardClaim.create({
      ...settle,
      txHash: txHash.toLowerCase(),
      logIndex,
      userId,
      externalEOA: claimant,
      checkpointId,
      claimedACF,
      cumulativeSelfACF: cumulativeSelf.toString(),
      cumulativeTeamACF: cumulativeTeam.toString(),
      usdtFee,
      claimFeePercentage: String(decoded.args.claimFeePercentage),
      priceE18: String(decoded.args.priceE18),
      blockNumber: Number(receipt.blockNumber),
      blockTimestamp: Number(block.timestamp),
    }).catch((cause: { code?: number }) => {
      if (cause?.code !== 11000) throw cause;    // a concurrent post won; fine
    });
  }

  // The watermark still comes from the chain, never from this event.
  await reconcileClaimStates(reader);

  return {
    recorded: !existing,
    alreadyPresent: existing !== null,
    checkpointId,
    claimedACF,
    usdtFee,
  };
}
