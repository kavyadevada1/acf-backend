import { getAddress, parseEventLogs, type Log } from "viem";
import { config } from "../config.js";
import { publicClient, ZERO_ADDRESS } from "../lib/chain.js";
import { logger } from "../lib/logger.js";
import { DAORevenueEpoch } from "../models/DAORevenueEpoch.js";
import { DAORevenueMemberEntry } from "../models/DAORevenueMemberEntry.js";
import { assertInvariant, DAORevenueInvariantError } from "./policy.js";
import { buildMemberCommitment } from "./memberTree.js";
import { rebuildManifest, type DAORevenueManifest } from "./manifest.js";
import { standardRewardLiability } from "./liability.js";
import {
  daoMarketingPaidEventAbi, daoRevenueChainReader, daoRevenuePaidEventAbi,
  type DAORevenueChainReader,
} from "./chain.js";
import { recordPayments, reconcileDAORevenueEpoch } from "./reconcile.js";
import {
  loadEpochExecutorSigner, signerConfigured, type EpochExecutorSigner,
} from "../executor/signer.js";

/**
 * The DAO Revenue Executor: the only code path that signs a transaction.
 *
 * It can construct exactly TWO calls and no others:
 *
 *   Treasury.fundDAORevenueEpoch(epochId, amount)
 *   DAORevenueDistributor.distributeBatch(epochId, users[], amounts[])
 *
 * There is deliberately no generic send, no arbitrary contract write, no grantRole, no
 * adjustReserve and no upgrade path. Even though the on-chain EPOCH_EXECUTOR_ROLE is broader
 * than these two functions, this process cannot reach the rest of it.
 *
 * It never decides an amount. Every figure comes from the immutable manifest the calculation
 * service produced, whose hash is recomputed here and compared before anything is signed.
 */

// Only the three state-changing functions. Nothing else is encodable from this module.
const treasuryFundAbi = [{
  type: "function", name: "fundDAORevenueEpoch", stateMutability: "nonpayable",
  inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [],
}] as const;

const distributeBatchAbi = [{
  type: "function", name: "distributeBatch", stateMutability: "nonpayable",
  // Addresses and amounts travel WITH their proofs: the contract rebuilds each leaf and verifies
  // it against the authorized root, so neither can be substituted.
  inputs: [
    { type: "uint256" }, { type: "address[]" }, { type: "uint256[]" }, { type: "bytes32[][]" },
  ],
  outputs: [],
}] as const;

const payMarketingAbi = [{
  type: "function", name: "payMarketing", stateMutability: "nonpayable",
  // Epoch only. The recipient and the amount were pinned at funding, so there is nothing here
  // for this executor to choose or to get wrong.
  inputs: [{ type: "uint256" }], outputs: [],
}] as const;

const key = () => ({
  chainId: config.chainId,
  daoContractAddress: getAddress(config.acfDaoAddress).toLowerCase(),
  distributorAddress: getAddress(config.daoRevenueDistributorAddress).toLowerCase(),
});

/**
 * Statuses the executor may act on.
 *
 * `CALCULATED` is deliberately NOT one of them: a calculated epoch has no on-chain commitment
 * yet, so there is nothing the executor is permitted to relay. AUTHORIZE is a separate step run
 * by a separate key, and leaving CALCULATED out is what keeps EXECUTE from implying AUTHORIZE.
 */
export const EXECUTABLE = ["AUTHORIZED", "FUNDING_SUBMITTED", "FUNDED", "DISTRIBUTING"];

export interface PreflightReport {
  epochId: number;
  manifestHash: string;
  manifestVerified: boolean;
  chainId: number;
  signerAddress: string | null;
  signerHasTreasuryRole: boolean | null;
  signerHasDistributorRole: boolean | null;
  obligationACF: string;
  memberObligationACF: string;
  marketingObligationACF: string;
  marketingCollector: string;
  /** The epoch's on-chain payable set; all zero and `false` before the authorizer commits it. */
  epochAuthorized: boolean;
  authorizedMemberRoot: string;
  authorizedMarketingRecipient: string;
  authorizedMarketingACF: string;
  authorizedTotalACF: string;
  marketingPaidACF: string;
  marketingOutstanding: boolean;
  fundedACF: string;
  distributedACF: string;
  treasuryBalanceACF: string;
  requiredReserveACF: string;
  /** ACF that must stay behind for Phase 3 checkpoints the operator has not yet funded. */
  pendingStandardObligationACF: string;
  /** requiredReserve + pendingStandardObligation: the floor the balance must clear. */
  requiredHeadroomACF: string;
  postFundingBalanceACF: string;
  headroomOk: boolean;
  memberCount: number;
  batchCount: number;
  unpaidMembers: number;
  plannedCalls: string[];
  blockers: string[];
}

/**
 * Every precondition, with no transaction sent. This is also the dry run.
 *
 * `signer` is optional so a dry run can validate everything else without unlocking a production
 * key; the role checks are then reported as unknown rather than assumed.
 */
export async function preflight(
  epochId: number,
  reader: DAORevenueChainReader = daoRevenueChainReader,
  signerAddress?: string,
): Promise<PreflightReport> {
  const k = key();
  const blockers: string[] = [];
  const epoch = await DAORevenueEpoch.findOne({ ...k, epochId }).lean();
  if (!epoch) throw new DAORevenueInvariantError(`No DAO revenue epoch ${epochId}.`);

  if (!EXECUTABLE.includes(epoch.status)) {
    blockers.push(`Epoch status is ${epoch.status}; executable statuses are ${EXECUTABLE.join(", ")}.`);
  }

  // ── manifest integrity ────────────────────────────────────────────────
  const { manifest, hash, recordedHash } = await rebuildManifest(epochId);
  const manifestVerified = hash.toLowerCase() === recordedHash.toLowerCase();
  if (!manifestVerified) {
    blockers.push(
      `Manifest hash mismatch: rows hash to ${hash} but the epoch recorded ${recordedHash}. ` +
        "A financial field has changed since calculation.",
    );
  }

  // ── deployment identity ───────────────────────────────────────────────
  const chainId = await reader.chainId();
  if (chainId !== config.chainId) {
    blockers.push(`RPC reports chain ${chainId}, configured ${config.chainId}.`);
  }
  if (manifest.distributorAddress !== k.distributorAddress) {
    blockers.push(`Manifest distributor ${manifest.distributorAddress} is not the configured one.`);
  }
  if (manifest.epochId !== epochId) {
    blockers.push(`Manifest epoch ${manifest.epochId} does not match ${epochId}.`);
  }

  const [wiring, payoutDestination, treasuryAcf] = await Promise.all([
    reader.distributorWiring(),
    reader.treasuryDaoPayoutDestination(),
    reader.treasuryAcf(),
  ]);
  if (payoutDestination !== k.distributorAddress) {
    blockers.push(
      `Treasury.daoPayoutDestination is ${payoutDestination}, not the configured distributor.`,
    );
  }
  if (wiring.treasury !== getAddress(config.treasuryAddress).toLowerCase()) {
    blockers.push(`distributor.treasury is ${wiring.treasury}, not the configured Treasury.`);
  }
  if (wiring.acf !== getAddress(config.acfTokenAddress).toLowerCase()) {
    blockers.push(`distributor.acf is ${wiring.acf}, not the configured ACF token.`);
  }
  if (treasuryAcf !== getAddress(config.acfTokenAddress).toLowerCase()) {
    blockers.push(`Treasury.acf is ${treasuryAcf}, not the configured ACF token.`);
  }
  if (config.daoRevenueBatchSize > wiring.maxBatchSize) {
    blockers.push(
      `DAO_REVENUE_BATCH_SIZE ${config.daoRevenueBatchSize} exceeds the distributor's ` +
        `MAX_BATCH_SIZE ${wiring.maxBatchSize}; distributeBatch would revert InvalidBatch.`,
    );
  }
  for (const batch of manifest.batches) {
    if (batch.externalEOAs.length > wiring.maxBatchSize) {
      blockers.push(`Batch ${batch.batchIndex} has ${batch.externalEOAs.length} members.`);
    }
  }

  // ── funding state ─────────────────────────────────────────────────────
  // The epoch owes TWO things out of one funding: every member's share of the 5% pool and the
  // whole 2% marketing allocation. Funding only the member share would leave marketing unpayable;
  // funding more than both would strand ACF in a distributor that has no sweep.
  const memberObligation = BigInt(epoch.totalMemberRevenueACF);
  const marketingObligation = BigInt(epoch.marketingRevenueACF);
  const obligation = BigInt(epoch.totalObligationACF);
  assertInvariant(
    obligation === memberObligation + marketingObligation,
    `Epoch ${epochId} records a total obligation of ${obligation} ACF, but its member ` +
      `(${memberObligation}) and marketing (${marketingObligation}) shares sum to ` +
      `${memberObligation + marketingObligation}.`,
  );
  const [funded, distributed, balance, requiredReserve, marketingPaid, authorization] =
    await Promise.all([
      reader.epochFundedAmount(epochId),
      reader.epochDistributedAmount(epochId),
      reader.treasuryBalanceACF(),
      reader.requiredReserve(),
      reader.epochMarketingPaidAmount(epochId),
      reader.epochAuthorization(epochId),
    ])

  // The authorization IS the contract's answer to who may be paid what. Nothing can proceed
  // without it, and a disagreement with what this epoch calculated cannot be fixed by retrying —
  // the commitment is immutable — so it stops here rather than becoming a wrong payout.
  if (!authorization.authorized) {
    blockers.push(
      `Epoch ${epochId} is not authorized on chain. The authorizer must commit its payable set ` +
        "before the executor can fund or relay anything; the executor cannot authorize it.",
    );
  } else {
    const expectedRecipient = marketingObligation === 0n ? ZERO_ADDRESS : epoch.marketingCollector;
    for (const [label, onChain, calculated] of [
      ["member root", authorization.memberRoot, epoch.memberRoot],
      ["member total", authorization.memberTotalACF.toString(), memberObligation.toString()],
      ["marketing recipient", authorization.marketingRecipient, expectedRecipient],
      ["marketing amount", authorization.marketingAmountACF.toString(), marketingObligation.toString()],
      ["total obligation", authorization.totalObligationACF.toString(), obligation.toString()],
    ] as const) {
      if (onChain !== calculated) {
        blockers.push(
          `Epoch ${epochId} is authorized on chain with ${label} ${onChain}, but it was ` +
            `calculated as ${calculated}. The authorization is immutable; this needs an ` +
            "operator decision.",
        );
      }
    }
  }
  if (marketingObligation > 0n && marketingPaid !== 0n && marketingPaid !== marketingObligation) {
    blockers.push(
      `The chain reports ${marketingPaid} ACF of marketing already paid for epoch ${epochId}, ` +
        `not the calculated ${marketingObligation}. This needs an operator decision.`,
    );
  }
  if (obligation <= 0n) {
    blockers.push(`Obligation is ${obligation}; fundDAORevenueEpoch would revert InvalidAmount.`);
  }
  if (funded !== 0n && funded !== obligation) {
    blockers.push(
      `Epoch already funded with ${funded} ACF, not the obligation ${obligation}. ` +
        "The distributor has no sweep; this needs an operator decision.",
    );
  }

  // ── Treasury headroom ─────────────────────────────────────────────────
  // Nothing on chain enforces requiredReserve, and DAO funding competes with Phase 3 standard
  // reward funding for the SAME balance. So the floor is the reserve PLUS any checkpoint the
  // operator has calculated but not yet funded: DAO revenue is automated and Phase 3 funding is
  // a manual step, so the automated side must yield to the manual one.
  //
  // adjustReserve() is deliberately never called. Minting to replace what was paid out is a
  // monetary decision, not an automation one.
  const liability = await standardRewardLiability(reader);
  const needsFunding = funded === 0n;
  const postFunding = needsFunding ? balance - obligation : balance;
  const requiredHeadroom = requiredReserve + liability.reservedACF;
  const headroomOk = liability.undetermined === null && postFunding >= requiredHeadroom;

  if (liability.undetermined !== null) {
    // Never guess zero: an unknown Phase 3 liability means DAO funding could spend ACF the
    // operator is about to need.
    blockers.push(`Pending standard-reward obligation is undetermined. ${liability.undetermined}`);
  }
  if (needsFunding && balance < obligation) {
    blockers.push(`Treasury holds ${balance} ACF, less than the obligation ${obligation}.`);
  }
  if (liability.undetermined === null && postFunding < requiredHeadroom) {
    blockers.push(
      `Funding would leave the Treasury at ${postFunding} ACF against a required headroom of ` +
        `${requiredHeadroom} (reserve ${requiredReserve} + pending standard-reward obligation ` +
        `${liability.reservedACF}). Refusing to erode reward backing or a pending settlement; ` +
        "escalate rather than minting.",
    );
  }

  // ── signer roles ──────────────────────────────────────────────────────
  let treasuryRole: boolean | null = null;
  let distributorRole: boolean | null = null;
  if (signerAddress) {
    const roles = await reader.executorRoles(signerAddress);
    treasuryRole = roles.treasury;
    distributorRole = roles.distributor;
    if (!roles.treasury && needsFunding) {
      blockers.push(`${signerAddress} lacks EPOCH_EXECUTOR_ROLE on the Treasury.`);
    }
    if (!roles.distributor) {
      blockers.push(`${signerAddress} lacks EPOCH_EXECUTOR_ROLE on the distributor.`);
    }
  }

  // ── what remains to pay ───────────────────────────────────────────────
  const entries = await DAORevenueMemberEntry.find({
    chainId: k.chainId, distributorAddress: k.distributorAddress, epochId,
  }).lean();
  const paid = await reader.isPaid(epochId, entries.map((e) => e.externalEOA));
  const unpaid = entries.filter((e) => paid.get(e.externalEOA.toLowerCase()) !== true);

  const marketingOutstanding = marketingObligation > 0n && marketingPaid === 0n;
  const plannedCalls: string[] = [];
  if (needsFunding) {
    plannedCalls.push(`Treasury.fundDAORevenueEpoch(${epochId}, ${obligation})`);
  }
  if (marketingOutstanding) {
    plannedCalls.push(
      `distributor.payMarketing(${epochId}, ${epoch.marketingCollector}, ${marketingObligation})`,
    );
  }
  for (const batch of manifest.batches) {
    const remaining = batch.externalEOAs.filter(
      (eoa) => paid.get(eoa.toLowerCase()) !== true,
    );
    if (remaining.length > 0) {
      plannedCalls.push(
        `distributor.distributeBatch(${epochId}, [${remaining.length} users], [...])`,
      );
    }
  }

  return {
    epochId,
    manifestHash: hash,
    manifestVerified,
    chainId,
    signerAddress: signerAddress ?? null,
    signerHasTreasuryRole: treasuryRole,
    signerHasDistributorRole: distributorRole,
    obligationACF: obligation.toString(),
    fundedACF: funded.toString(),
    distributedACF: distributed.toString(),
    treasuryBalanceACF: balance.toString(),
    requiredReserveACF: requiredReserve.toString(),
    pendingStandardObligationACF: liability.reservedACF.toString(),
    requiredHeadroomACF: requiredHeadroom.toString(),
    postFundingBalanceACF: postFunding.toString(),
    headroomOk,
    memberCount: entries.length,
    batchCount: manifest.batchCount,
    unpaidMembers: unpaid.length,
    memberObligationACF: memberObligation.toString(),
    marketingObligationACF: marketingObligation.toString(),
    marketingCollector: epoch.marketingCollector,
    epochAuthorized: authorization.authorized,
    authorizedMemberRoot: authorization.memberRoot,
    authorizedMarketingRecipient: authorization.marketingRecipient,
    authorizedMarketingACF: authorization.marketingAmountACF.toString(),
    authorizedTotalACF: authorization.totalObligationACF.toString(),
    marketingPaidACF: marketingPaid.toString(),
    marketingOutstanding,
    plannedCalls,
    blockers,
  };
}

export interface ExecutionResult {
  epochId: number;
  funded: boolean;
  fundingTxHash: string | null;
  batchesSubmitted: number;
  membersPaid: number;
  /** Whether this run paid the marketing allocation; false when it was already paid or zero. */
  marketingPaid: boolean;
  marketingTxHash: string | null;
  status: string;
}

/**
 * Funds and distributes one epoch, resuming from chain state after any crash.
 *
 * Deliberately sequential: funding must be confirmed and registered before any transfer, and
 * each batch is reconciled before the next, so a partial run leaves a state the next attempt can
 * read rather than guess.
 */
export async function executeDAORevenueEpoch(
  epochId: number,
  options: { reader?: DAORevenueChainReader; signer?: EpochExecutorSigner } = {},
): Promise<ExecutionResult> {
  const reader = options.reader ?? daoRevenueChainReader;
  const signer = options.signer ?? loadEpochExecutorSigner();
  const k = key();

  const report = await preflight(epochId, reader, signer.address);
  if (report.blockers.length > 0) {
    throw new DAORevenueInvariantError(
      `Refusing to execute DAO revenue epoch ${epochId}:\n  - ${report.blockers.join("\n  - ")}`,
    );
  }
  assertInvariant(report.manifestVerified, `Epoch ${epochId} manifest is not verified.`);

  // Taken BEFORE anything is signed. Losing the race is not an error: another executor owns
  // this epoch, and the two must never submit for it concurrently.
  if (!(await claimExecutorLease(epochId))) {
    throw new DAORevenueInvariantError(
      `DAO revenue epoch ${epochId} is already leased by another executor. Refusing to ` +
        "submit concurrently; the lease expires on its own if that process died.",
    );
  }

  const obligation = BigInt(report.obligationACF);
  let fundingTxHash: string | null = null;

  // Rebuilt BEFORE funding, not after: the funding call must carry the marketing split that
  // Treasury will pin, and those figures have to come from the manifest whose hash was verified
  // above rather than from anything this process computed.
  const { manifest } = await rebuildManifest(epochId);
  assertInvariant(
    BigInt(manifest.totalObligationACF) === obligation,
    `Manifest total obligation ${manifest.totalObligationACF} disagrees with ${obligation}.`,
  );
  // The proofs every member transfer must carry, rebuilt from the persisted member rows — the
  // same rows the authorized root was built from, so a proof either verifies or the row set has
  // changed since authorization and the contract refuses it.
  const commitment = buildMemberCommitment(epochId, manifest.batches.flatMap((batch) =>
    batch.externalEOAs.map((eoa, index) => ({
      externalEOA: eoa, amountACF: BigInt(batch.amountsACF[index]!),
    }))));
  assertInvariant(
    commitment.root === manifest.memberRoot,
    `Rebuilt member root ${commitment.root} does not match the manifest's ${manifest.memberRoot}.`,
  );

  // ── 1. funding, skipped when the chain already records it ─────────────
  if (BigInt(report.fundedACF) === 0n) {
    await DAORevenueEpoch.updateOne(
      { ...k, epochId }, { $set: { status: "FUNDING_SUBMITTED" } },
    );
    logger.info("dao revenue funding submitted", { epochId, amount: obligation.toString() });

    const hash = await signer.client.writeContract({
      address: getAddress(config.treasuryAddress),
      abi: treasuryFundAbi,
      functionName: "fundDAORevenueEpoch",
      // Carries no payout metadata. The distributor refuses any amount other than the authorized
      // total, so this executor cannot move more ACF than the authorizer permitted — even though
      // it is the caller and chooses this argument.
      args: [BigInt(epochId), obligation],
      chain: signer.chain,
      account: signer.client.account!,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new DAORevenueInvariantError(`Funding reverted for epoch ${epochId}: ${hash}`);
    }
    fundingTxHash = hash;

    // Read back from BOTH contracts: the Treasury's replay mark and the distributor's recorded
    // amount. A receipt alone does not prove the callback registered the right figure.
    const [treasuryFunded, registered] = await Promise.all([
      reader.treasuryFunded(epochId),
      reader.epochFundedAmount(epochId),
    ]);
    assertInvariant(treasuryFunded, `Treasury does not record epoch ${epochId} as funded.`);
    assertInvariant(
      registered === obligation,
      `Distributor registered ${registered} ACF for epoch ${epochId}, expected ${obligation}.`,
    );

    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    await DAORevenueEpoch.updateOne({ ...k, epochId }, {
      $set: {
        status: "FUNDED",
        fundingTxHash: hash.toLowerCase(),
        fundingBlockNumber: Number(receipt.blockNumber),
        fundingBlockTimestamp: Number(block.timestamp),
        fundedACF: registered.toString(),
        fundedAt: new Date(),
      },
    });
    logger.info("dao revenue epoch funded", { epochId, txHash: hash });
  }

  // ── 2. the marketing allocation: one recipient, one transfer, once ────
  //
  // Before the member batches, deliberately. Both draw on the same epoch funding, and paying the
  // single epoch-level obligation first means a crash part-way through the member batches leaves
  // marketing already settled rather than depending on a later retry reaching the end.
  //
  // Resumed from chain state like everything else: `epochMarketingPaidAmount` is the authority,
  // so a crash between a confirmed transaction and the database write costs only a re-read.
  const marketingObligation = BigInt(manifest.marketingRevenueACF);
  let marketingPaid = false;
  let marketingTxHash: string | null = null;

  if (marketingObligation > 0n && (await reader.epochMarketingPaidAmount(epochId)) === 0n) {
    const hash = await signer.client.writeContract({
      address: getAddress(config.daoRevenueDistributorAddress),
      abi: payMarketingAbi,
      functionName: "payMarketing",
      // Epoch only: the recipient and the amount were pinned when Treasury funded this epoch,
      // so a later change to the DAO's configured collector can neither redirect this payout
      // nor strand it.
      args: [BigInt(epochId)],
      chain: signer.chain,
      account: signer.client.account!,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new DAORevenueInvariantError(
        `Marketing payment reverted for epoch ${epochId}: ${hash}`,
      );
    }

    // Verified against the EVENT, not the receipt: the amount and recipient the chain actually
    // moved must match the immutable obligation, exactly as member payments are verified.
    const events = parseEventLogs({
      abi: [daoMarketingPaidEventAbi],
      logs: receipt.logs as Log[],
    }).filter((event) => Number(event.args.epochId) === epochId);
    assertInvariant(
      events.length === 1,
      `Epoch ${epochId} marketing payment emitted ${events.length} DAOMarketingPaid events, expected 1.`,
    );
    const event = events[0]!;
    assertInvariant(
      String(event.args.recipient).toLowerCase() === manifest.marketingCollector.toLowerCase(),
      `Marketing was paid to ${event.args.recipient}, not the calculated ` +
        `${manifest.marketingCollector}.`,
    );
    assertInvariant(
      (event.args.amount as bigint) === marketingObligation,
      `Marketing paid ${event.args.amount} ACF, not the calculated ${marketingObligation}.`,
    );

    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    await DAORevenueEpoch.updateOne({ ...k, epochId }, {
      $set: {
        marketingPaidACF: marketingObligation.toString(),
        marketingTxHash: hash.toLowerCase(),
        marketingBlockNumber: Number(receipt.blockNumber),
        marketingPaidAt: new Date(Number(block.timestamp) * 1000),
      },
    });
    marketingPaid = true;
    marketingTxHash = hash;
    logger.info("dao revenue marketing paid", {
      epochId, recipient: manifest.marketingCollector, amount: marketingObligation.toString(),
      txHash: hash,
    });
  }

  // ── 3. member distribution, batch by batch, resuming from chain ───────
  await DAORevenueEpoch.updateOne({ ...k, epochId }, { $set: { status: "DISTRIBUTING" } });

  let batchesSubmitted = 0;
  let membersPaid = 0;

  for (const batch of manifest.batches) {
    const paid = await reader.isPaid(epochId, batch.externalEOAs);
    const remaining = batch.externalEOAs
      .map((eoa, index) => ({ eoa, amount: BigInt(batch.amountsACF[index]!) }))
      .filter(({ eoa }) => paid.get(eoa.toLowerCase()) !== true);

    if (remaining.length === 0) continue;

    const hash = await signer.client.writeContract({
      address: getAddress(config.daoRevenueDistributorAddress),
      abi: distributeBatchAbi,
      functionName: "distributeBatch",
      args: [
        BigInt(epochId),
        remaining.map((r) => getAddress(r.eoa)),
        remaining.map((r) => r.amount),
        remaining.map((r) => commitment.proofFor(r.eoa, r.amount)),
      ],
      chain: signer.chain,
      account: signer.client.account!,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new DAORevenueInvariantError(
        `Batch ${batch.batchIndex} reverted for epoch ${epochId}: ${hash}`,
      );
    }
    batchesSubmitted += 1;

    // Verify against the events, not the receipt status: each DAORevenuePaid must match an
    // immutable obligation in address and amount.
    const events = parseEventLogs({
      abi: [daoRevenuePaidEventAbi],
      logs: receipt.logs as Log[],
    }).filter((event) => Number(event.args.epochId) === epochId);

    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    await recordPayments(epochId, events.map((event) => ({
      user: String(event.args.user),
      amount: event.args.amount as bigint,
      txHash: hash,
      logIndex: Number(event.logIndex),
      blockNumber: Number(receipt.blockNumber),
      blockTimestamp: Number(block.timestamp),
    })));
    membersPaid += events.length;

    logger.info("dao revenue batch distributed", {
      epochId, batchIndex: batch.batchIndex, members: events.length, txHash: hash,
    });
  }

  // ── 4. completion is decided by chain state, never by this loop ───────
  const reconciliation = await reconcileDAORevenueEpoch(epochId, reader);
  await DAORevenueEpoch.updateOne({ ...k, epochId }, { $set: { leaseExpiresAt: null } });

  return {
    epochId,
    funded: true,
    fundingTxHash,
    batchesSubmitted,
    membersPaid,
    marketingPaid,
    marketingTxHash,
    status: reconciliation?.statusAfter ?? "UNKNOWN",
  };
}

/** Next epoch the executor should act on: oldest actionable first, one at a time. */
export async function nextExecutableEpoch(): Promise<number | null> {
  const k = key();
  const now = new Date();
  const row = await DAORevenueEpoch.findOne({
    ...k,
    status: { $in: EXECUTABLE },
    $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lt: now } }],
  }).sort({ epochId: 1 }).lean();
  return row?.epochId ?? null;
}

/**
 * Takes the execution lease ATOMICALLY, or returns false.
 *
 * The filter requires the lease to be absent or expired, so of two executors selecting the same
 * epoch exactly one update matches — a read-then-write pair would let both through, and the
 * loser would then spend gas on a transaction the chain rejects.
 *
 * The chain guards (`daoRevenueEpochFunded`, `paid[epochId][user]`) remain the last defence
 * against double payment; this is the local coordination that should stop it reaching them.
 */
async function claimExecutorLease(epochId: number): Promise<boolean> {
  const now = new Date();
  const expires = new Date(now.getTime() + config.daoRevenueExecutorLeaseMs);
  const result = await DAORevenueEpoch.updateOne(
    {
      ...key(), epochId,
      $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lt: now } }],
    },
    { $set: { leaseExpiresAt: expires }, $inc: { attempts: 1 } },
  );
  return result.modifiedCount === 1;
}

export { signerConfigured };
export { rebuildManifest };
