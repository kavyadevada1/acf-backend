import { getAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { DAORevenueEpoch } from "../models/DAORevenueEpoch.js";
import { DAORevenueMemberEntry } from "../models/DAORevenueMemberEntry.js";
import { DAORevenuePayment } from "../models/DAORevenuePayment.js";
import { assertInvariant, DAORevenueInvariantError } from "./policy.js";
import { daoRevenueChainReader, type DAORevenueChainReader } from "./chain.js";

/**
 * Reconciles a DAO revenue epoch against chain state.
 *
 * The chain is the authority throughout. `isPaid(epochId, eoa)`, `epochFundedAmount` and
 * `epochDistributedAmount` decide what has happened — never a local flag — so a crash between a
 * confirmed transaction and a database write costs nothing but a re-read.
 *
 * COMPLETED is only reachable when the chain proves that every calculated member is paid, that
 * the marketing allocation is paid, and that the distributed total equals the calculated
 * obligation. No one of those is sufficient alone: all-members-paid with a larger distributed
 * total would mean someone was paid who has no obligation, and all-members-paid with marketing
 * still outstanding would report an epoch settled while real money remained unsent.
 */

const key = () => ({
  chainId: config.chainId,
  daoContractAddress: getAddress(config.acfDaoAddress).toLowerCase(),
  distributorAddress: getAddress(config.daoRevenueDistributorAddress).toLowerCase(),
});

export interface DAORevenueReconciliation {
  epochId: number;
  statusBefore: string;
  statusAfter: string;
  fundedACF: string;
  distributedACF: string;
  obligationACF: string;
  memberObligationACF: string;
  marketingObligationACF: string;
  marketingPaidACF: string;
  epochAuthorized: boolean;
  authorizedMemberRoot: string;
  paidMembers: number;
  totalMembers: number;
  warnings: string[];
}

export async function reconcileDAORevenueEpoch(
  epochId: number,
  reader: DAORevenueChainReader = daoRevenueChainReader,
): Promise<DAORevenueReconciliation | null> {
  const k = key();
  const epoch = await DAORevenueEpoch.findOne({ ...k, epochId }).lean();
  if (!epoch) return null;

  const statusBefore = epoch.status;
  const warnings: string[] = [];

  if (statusBefore === "NOTHING_TO_DISTRIBUTE") {
    // Nothing was ever owed, so nothing may have been funded against this epoch id.
    const funded = await reader.epochFundedAmount(epochId);
    if (funded !== 0n) {
      throw new DAORevenueInvariantError(
        `Epoch ${epochId} is terminal with nothing owed, but the distributor reports ${funded} ` +
          "ACF funded against it. That ACF cannot be distributed and cannot be swept.",
      );
    }
    return {
      epochId, statusBefore, statusAfter: statusBefore,
      fundedACF: "0", distributedACF: "0", obligationACF: "0",
      memberObligationACF: "0", marketingObligationACF: "0", marketingPaidACF: "0",
      epochAuthorized: false, authorizedMemberRoot: `0x${"0".repeat(64)}`,
      paidMembers: 0, totalMembers: 0, warnings,
    };
  }

  const entries = await DAORevenueMemberEntry.find({
    chainId: k.chainId, distributorAddress: k.distributorAddress, epochId,
  }).lean();
  const memberObligation = BigInt(epoch.totalMemberRevenueACF);
  const marketingObligation = BigInt(epoch.marketingRevenueACF);
  // What was funded and what must be distributed: both obligations out of one epoch funding.
  const obligation = BigInt(epoch.totalObligationACF);

  const [treasuryFunded, funded, distributed, marketingPaidOnChain, authorization] =
    await Promise.all([
      reader.treasuryFunded(epochId),
      reader.epochFundedAmount(epochId),
      reader.epochDistributedAmount(epochId),
      reader.epochMarketingPaidAmount(epochId),
      reader.epochAuthorization(epochId),
    ]);

  // ── the authorization is the chain's account of what was payable ──────
  //
  // Checked before anything else financial, and against the chain rather than the local row: the
  // database cannot override the commitment, and a disagreement means the epoch's recorded
  // entitlements are not the ones the distributor will act on.
  if (authorization.authorized) {
    if (authorization.memberRoot !== epoch.memberRoot) {
      throw new DAORevenueInvariantError(
        `Epoch ${epochId} is authorized on chain with member root ${authorization.memberRoot} ` +
          `but records ${epoch.memberRoot}. The commitment is immutable; the recorded member ` +
          "entitlements are not the ones that can be paid.",
      );
    }
    if (authorization.totalObligationACF !== obligation) {
      throw new DAORevenueInvariantError(
        `Epoch ${epochId} is authorized for ${authorization.totalObligationACF} ACF but records ` +
          `an obligation of ${obligation}.`,
      );
    }
    if (authorization.marketingAmountACF !== marketingObligation
      || (marketingObligation > 0n && authorization.marketingRecipient !== epoch.marketingCollector)) {
      throw new DAORevenueInvariantError(
        `Epoch ${epochId} is authorized to pay ${authorization.marketingAmountACF} ACF of ` +
          `marketing to ${authorization.marketingRecipient}, but records ${marketingObligation} ` +
          `to ${epoch.marketingCollector}.`,
      );
    }
  } else if (funded !== 0n) {
    throw new DAORevenueInvariantError(
      `Epoch ${epochId} was funded with ${funded} ACF but holds no on-chain authorization. ` +
        "Funding cannot outrun the commitment; investigate before distributing.",
    );
  }

  // ── funding agreement ─────────────────────────────────────────────────
  if (funded !== 0n && funded !== obligation) {
    throw new DAORevenueInvariantError(
      `Epoch ${epochId} was funded with ${funded} ACF but the calculated obligation is ` +
        `${obligation}. The distributor has no sweep, so a mismatch cannot be corrected by ` +
        "distributing; this needs an operator decision.",
    );
  }
  if (treasuryFunded && funded === 0n) {
    warnings.push(
      "Treasury records this epoch as funded but the distributor registered no amount.",
    );
  }

  // ── per-member payment state, from chain ──────────────────────────────
  const paidMap = await reader.isPaid(epochId, entries.map((e) => e.externalEOA));
  const paidEntries = entries.filter((e) => paidMap.get(e.externalEOA.toLowerCase()) === true);

  assertInvariant(
    distributed <= funded,
    `Epoch ${epochId} distributed ${distributed} ACF against ${funded} funded.`,
  );

  // `distributed` is the epoch's single accumulator and the contract advances it for marketing
  // too, so the members the chain reports paid plus the marketing it reports paid must account
  // for all of it. Anything left over means someone was paid without a calculated obligation.
  const expectedPaidTotal =
    paidEntries.reduce((sum, e) => sum + BigInt(e.memberRevenueACF), 0n) + marketingPaidOnChain;
  if (distributed !== expectedPaidTotal) {
    throw new DAORevenueInvariantError(
      `Epoch ${epochId} distributed ${distributed} ACF, but the members the chain reports as ` +
        `paid plus the ${marketingPaidOnChain} of marketing account for ${expectedPaidTotal}. ` +
        "Either someone was paid without a calculated obligation, or an amount differs from " +
        "what was calculated.",
    );
  }
  if (marketingPaidOnChain !== 0n && marketingPaidOnChain !== marketingObligation) {
    throw new DAORevenueInvariantError(
      `Epoch ${epochId} paid ${marketingPaidOnChain} ACF of marketing but the calculated ` +
        `allocation is ${marketingObligation}. The distributor has no sweep, so this cannot be ` +
        "corrected by distributing; it needs an operator decision.",
    );
  }

  // ── status ────────────────────────────────────────────────────────────
  let statusAfter = statusBefore;
  // An epoch with a marketing allocation but no eligible members has zero entries and is still a
  // real, payable epoch, so "every member paid" has to mean "none outstanding" rather than
  // "at least one paid".
  const allMembersPaid = paidEntries.length === entries.length;
  const marketingSettled = marketingObligation === 0n || marketingPaidOnChain === marketingObligation;
  const anythingPaid = paidEntries.length > 0 || marketingPaidOnChain > 0n;

  if (allMembersPaid && marketingSettled && distributed === obligation) {
    statusAfter = "COMPLETED";
  } else if (funded === obligation && funded > 0n) {
    statusAfter = anythingPaid ? "DISTRIBUTING" : "FUNDED";
  } else if (statusBefore === "FUNDING_SUBMITTED" && funded === 0n) {
    // Submitted but never landed; safe to retry funding. It returns to AUTHORIZED rather than
    // CALCULATED, because the on-chain commitment still stands and must not be re-made.
    statusAfter = authorization.authorized ? "AUTHORIZED" : "CALCULATED";
  }

  const update: Record<string, unknown> = {
    status: statusAfter,
    paidMembers: paidEntries.length,
    fundedACF: funded.toString(),
    marketingPaidACF: marketingPaidOnChain.toString(),
  };
  if (statusAfter === "COMPLETED" && !epoch.completedAt) update.completedAt = new Date();
  if ((statusAfter === "FUNDED" || statusAfter === "DISTRIBUTING") && !epoch.fundedAt) {
    update.fundedAt = new Date();
  }
  if (statusAfter !== statusBefore) update.leaseExpiresAt = null;
  await DAORevenueEpoch.updateOne({ ...k, epochId }, { $set: update });

  if (statusAfter !== statusBefore) {
    logger.info("dao revenue epoch reconciled", {
      epochId, statusBefore, statusAfter,
      paid: paidEntries.length, total: entries.length,
    });
  }

  return {
    epochId, statusBefore, statusAfter,
    fundedACF: funded.toString(),
    distributedACF: distributed.toString(),
    obligationACF: obligation.toString(),
    memberObligationACF: memberObligation.toString(),
    marketingObligationACF: marketingObligation.toString(),
    marketingPaidACF: marketingPaidOnChain.toString(),
    epochAuthorized: authorization.authorized,
    authorizedMemberRoot: authorization.memberRoot,
    paidMembers: paidEntries.length,
    totalMembers: entries.length,
    warnings,
  };
}

/**
 * Records confirmed DAORevenuePaid events against their calculated obligations.
 *
 * Every field is verified against the immutable member entry: the address and the amount. A
 * payment the calculation did not authorise fails rather than being recorded as a fact. The
 * event carries one address, which is both who was paid and where the ACF went, so matching it
 * to an obligation is the entire reconciliation.
 */
export async function recordPayments(
  epochId: number,
  events: Array<{
    user: string; amount: bigint;
    txHash: string; logIndex: number; blockNumber: number; blockTimestamp: number;
  }>,
): Promise<{ recorded: number; alreadyPresent: number }> {
  const k = key();
  const entries = await DAORevenueMemberEntry.find({
    chainId: k.chainId, distributorAddress: k.distributorAddress, epochId,
  }).lean();
  const byEOA = new Map(entries.map((e) => [e.externalEOA.toLowerCase(), e]));

  let recorded = 0;
  let alreadyPresent = 0;

  for (const event of events) {
    const eoa = event.user.toLowerCase();
    const entry = byEOA.get(eoa);
    if (!entry) {
      throw new DAORevenueInvariantError(
        `Epoch ${epochId} paid ${eoa}, which has no calculated obligation. Refusing to record ` +
          "a payment the calculation never authorised.",
      );
    }
    if (event.amount !== BigInt(entry.memberRevenueACF)) {
      throw new DAORevenueInvariantError(
        `Epoch ${epochId} paid ${eoa} ${event.amount} ACF, but the obligation is ` +
          `${entry.memberRevenueACF}.`,
      );
    }

    const result = await DAORevenuePayment.updateOne(
      { chainId: k.chainId, distributorAddress: k.distributorAddress, epochId, userId: entry.userId },
      {
        $setOnInsert: {
          chainId: k.chainId,
          distributorAddress: k.distributorAddress,
          epochId,
          userId: entry.userId,
          externalEOA: eoa,
          expectedAmountACF: entry.memberRevenueACF,
          amountPaidACF: event.amount.toString(),
          txHash: event.txHash.toLowerCase(),
          logIndex: event.logIndex,
          blockNumber: event.blockNumber,
          blockTimestamp: event.blockTimestamp,
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount > 0) recorded += 1;
    else alreadyPresent += 1;
  }

  return { recorded, alreadyPresent };
}
