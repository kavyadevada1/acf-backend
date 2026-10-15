import { getAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { ZERO_ADDRESS } from "../lib/chain.js";
import { ZERO_ROOT } from "../settlement/policy.js";
import { buildMemberCommitment } from "./memberTree.js";
import { RewardEpoch } from "../models/RewardEpoch.js";
import { DAORevenueEpoch } from "../models/DAORevenueEpoch.js";
import { DAORevenueMemberEntry } from "../models/DAORevenueMemberEntry.js";
import { snapshotAtOf, windowStartOf } from "../rewards/policy.js";
import {
  acfToUsd6, assertInvariant, batchIndexOf, compareByAddress, daoMarketingUSD6,
  daoRevenuePoolUSD6, DAORevenueInvariantError, isEligible, memberRevenueUSD6, usd6ToAcf,
} from "./policy.js";
import { resolveConfigAsOf } from "./configHistory.js";
import { loadActiveContributions, loadMemberIdentities, loadSystemRevenue } from "./inputs.js";
import {
  manifestHash, rebuildManifest, type DAORevenueManifest, type ManifestBatch,
} from "./manifest.js";
import { assertRowMatches, EPOCH_FIELDS, MEMBER_ENTRY_FIELDS } from "./verify.js";
import { daoRevenueChainReader, type DAORevenueChainReader } from "./chain.js";

/**
 * Calculates one DAO Member Revenue epoch. NO SIGNER, NO TRANSACTION.
 *
 * This produces an immutable obligation and a manifest; the separate executor process turns it
 * into transfers. Splitting them is what keeps the calculation path — which the public API and
 * the reward worker both import — free of any signing capability.
 */

export class Phase1NotSettledError extends Error {
  readonly code = "PHASE1_NOT_SETTLED";
  constructor(epochId: number, status: string | null) {
    super(
      `DAO revenue epoch ${epochId} cannot run: the Phase 1 staking epoch is ` +
        `${status ?? "missing"}, not CALCULATED or FINALIZED.`,
    );
    this.name = "Phase1NotSettledError";
  }
}

export type NothingReason =
  | "PROGRAM_DISABLED" | "NO_SYSTEM_REVENUE" | "EMPTY_POOL"
  | "NO_ELIGIBLE_MEMBERS" | "ALL_SHARES_ROUNDED_TO_ZERO";

export type DAORevenueEpochResult =
  | {
      epochId: number;
      status: "CALCULATED";
      eligibleMembers: number;
      systemSelfRewardACF: string;
      systemRevenueUSD6: string;
      daoRevenuePoolUSD6: string;
      totalMemberRevenueACF: string;
      roundingDustUSD6: string;
      batchCount: number;
      manifestHash: string;
    }
  | { epochId: number; status: "NOTHING_TO_DISTRIBUTE"; reason: NothingReason }
  | { epochId: number; status: "ALREADY_PROCESSED"; existing: string };

const key = () => ({
  chainId: config.chainId,
  daoContractAddress: getAddress(config.acfDaoAddress).toLowerCase(),
  distributorAddress: getAddress(config.daoRevenueDistributorAddress).toLowerCase(),
});

const deploymentAddresses = () => ({
  stakingContractAddress: getAddress(config.acfStakingAddress).toLowerCase(),
  treasuryAddress: getAddress(config.treasuryAddress).toLowerCase(),
});

/** Statuses that mean execution has begun or finished; calculation must not touch them. */
const EXECUTION_STARTED = ["FUNDING_SUBMITTED", "FUNDED", "DISTRIBUTING", "COMPLETED"];
/**
 * Statuses whose row carries no trusted financial content, so a recalculation may replace it.
 * Everything else is verified instead.
 */
const REPLACEABLE = ["CALCULATING", "FAILED"];

export async function runDAORevenueEpoch(
  epochId: number,
  reader: DAORevenueChainReader = daoRevenueChainReader,
): Promise<DAORevenueEpochResult> {
  const k = key();

  // ── 1. financial gate: Phase 1 only ───────────────────────────────────
  // Phase 2 is deliberately NOT a dependency. DAO revenue is priced from Self rewards and the
  // epoch price, both of which Phase 1 freezes; coupling it to Team reward would make a Phase 2
  // failure financially destroy a valid epoch.
  const phase1 = await RewardEpoch.findOne({
    chainId: config.chainId,
    stakingContractAddress: deploymentAddresses().stakingContractAddress,
    epochId,
  }).lean();
  if (!phase1 || (phase1.status !== "CALCULATED" && phase1.status !== "FINALIZED")) {
    throw new Phase1NotSettledError(epochId, phase1?.status ?? null);
  }

  const existing = await DAORevenueEpoch.findOne({ ...k, epochId }).lean();
  if (existing && (existing.status === "CALCULATED" || EXECUTION_STARTED.includes(existing.status)
    || existing.status === "NOTHING_TO_DISTRIBUTE")) {
    // Already decided, so nothing is recalculated — but the stored rows are still checked
    // against their recorded manifest hash. A tampered amount is then caught here as well as
    // in the executor's preflight, rather than only at the moment of signing.
    if (existing.status !== "NOTHING_TO_DISTRIBUTE") {
      const { hash, recordedHash } = await rebuildManifest(epochId);
      if (hash.toLowerCase() !== recordedHash.toLowerCase()) {
        throw new DAORevenueInvariantError(
          `DAO revenue epoch ${epochId} rows hash to ${hash} but the epoch recorded ` +
            `${recordedHash}. A financial field has changed since calculation; immutable ` +
            "history is never repaired.",
        );
      }
    }
    return { epochId, status: "ALREADY_PROCESSED", existing: existing.status };
  }

  // ── 2. the frozen boundary, inherited rather than recomputed ───────────
  const snapshotAt = phase1.snapshotAt ?? snapshotAtOf(epochId);
  const windowStart = phase1.windowStart ?? windowStartOf(epochId);
  const priceE18 = BigInt(phase1.priceE18 ?? "0");
  const snapshotBlockNumber = phase1.snapshotBlockNumber ?? null;

  assertInvariant(
    priceE18 > 0n,
    `Phase 1 epoch ${epochId} has no usable price (${phase1.priceE18}); DAO revenue cannot be priced.`,
  );
  if (snapshotBlockNumber === null) {
    throw new DAORevenueInvariantError(
      `Phase 1 epoch ${epochId} has no snapshotBlockNumber, so DAO configuration cannot be ` +
        "resolved as of its boundary. Refusing to use current configuration for a past epoch.",
    );
  }

  // ── 3. DAO configuration AS OF the snapshot block ─────────────────────
  const daoConfig = await resolveConfigAsOf(snapshotBlockNumber);

  if (!daoConfig.revenueEnabled) {
    // Recorded, not skipped: a historical epoch must never become payable later because the
    // programme was switched on afterwards.
    return finishNothing(epochId, "PROGRAM_DISABLED", {
      snapshotAt, windowStart, snapshotBlockNumber, priceE18, daoConfig,
      regularSelfACF: 0n, daoStakeRewardACF: 0n, systemSelfACF: 0n,
      systemRevenueUSD6: 0n, poolUSD6: 0n, totalEligibleUSDT6: 0n,
      // A disabled programme owes neither obligation. `setRevenueEnabled(false)` pauses the whole
      // revenue programme, marketing included: it is a share of the same programme's revenue.
      marketingUSD6: 0n, marketingACF: 0n,
    });
  }

  // ── 4. system revenue, with the mandatory independent cross-check ─────
  const revenue = await loadSystemRevenue(epochId, {
    totalRegularSelfACF: phase1.totalRegularSelfACF ?? "0",
    totalDAOStakeACF: phase1.totalDAOStakeACF ?? "0",
  });
  const systemRevenueUSD6 = acfToUsd6(revenue.totalSelfACF, priceE18);
  const poolUSD6 = daoRevenuePoolUSD6(systemRevenueUSD6, daoConfig.memberRevenueRateE6);

  // The marketing allocation: a SEPARATE share of the same SystemRevenueUSD, converted at the
  // same epoch price as every member amount. Computed here, next to the pool, so the two can
  // never be derived from different revenue, a different rate basis or a different price.
  const marketingUSD6 = daoMarketingUSD6(systemRevenueUSD6, daoConfig.marketingRateE6);
  const marketingACF = usd6ToAcf(marketingUSD6, priceE18);

  // A nonzero allocation with no recipient is unpayable. ACFDAO emits its rates before its
  // collector inside `initialize()`, so a history that starts mid-initialization can resolve to
  // no collector; refuse rather than calculate an obligation nothing can receive.
  assertInvariant(
    marketingACF === 0n || daoConfig.marketingCollector !== ZERO_ADDRESS,
    `Epoch ${epochId} owes ${marketingACF} ACF of marketing but no collector is known as of ` +
      `config block ${daoConfig.blockNumber}. Backfill MarketingFeeCollectorUpdated.`,
  );

  const common = {
    snapshotAt, windowStart, snapshotBlockNumber, priceE18, daoConfig,
    regularSelfACF: revenue.regularSelfACF,
    daoStakeRewardACF: revenue.daoStakeRewardACF,
    systemSelfACF: revenue.totalSelfACF,
    systemRevenueUSD6, poolUSD6, marketingUSD6, marketingACF,
  };

  if (revenue.totalSelfACF === 0n) {
    return finishNothing(epochId, "NO_SYSTEM_REVENUE", { ...common, totalEligibleUSDT6: 0n });
  }
  if (poolUSD6 === 0n && marketingACF === 0n) {
    return finishNothing(epochId, "EMPTY_POOL", { ...common, totalEligibleUSDT6: 0n });
  }

  // ── 5. active contributions as of the snapshot, then eligibility ──────
  const contributions = await loadActiveContributions(epochId, snapshotAt);

  const eligibleUsers = [...contributions.byUser.entries()]
    .filter(([, agg]) => isEligible(agg.activeUSDT6, daoConfig.silverMinimumUSDT6))
    .map(([userId, agg]) => ({ userId, ...agg }));

  const totalEligibleUSDT6 = eligibleUsers.reduce((sum, u) => sum + u.activeUSDT6, 0n);

  // No eligible members does NOT mean nothing is owed: the marketing allocation comes out of
  // SystemRevenue regardless of whether anyone qualified for the member pool. Only when BOTH are
  // zero is the epoch terminal; otherwise it proceeds with an empty member set and pays marketing.
  if (eligibleUsers.length === 0 || totalEligibleUSDT6 === 0n) {
    if (marketingACF === 0n) {
      return finishNothing(epochId, "NO_ELIGIBLE_MEMBERS", { ...common, totalEligibleUSDT6: 0n });
    }
  }

  const hasMembers = eligibleUsers.length > 0 && totalEligibleUSDT6 > 0n;

  // ── 6. payout identity ────────────────────────────────────────────────
  // Nothing to verify against: the distributor transfers to the address it is given, so the
  // address loaded here IS the recipient. There is no registry read and no pair to disagree.
  const identities = hasMembers
    ? await loadMemberIdentities(eligibleUsers.map((u) => u.userId))
    : new Map<string, { externalEOA: string }>();

  // ── 7. member obligations: floor each, deterministic order ────────────
  const batchSize = config.daoRevenueBatchSize;
  assertInvariant(batchSize > 0, `DAO_REVENUE_BATCH_SIZE must be positive, got ${batchSize}.`);

  const members = (hasMembers ? eligibleUsers : [])
    .map((user) => {
      const identity = identities.get(user.userId)!;
      const usd6 = memberRevenueUSD6(poolUSD6, user.activeUSDT6, totalEligibleUSDT6);
      return {
        userId: user.userId,
        externalEOA: identity.externalEOA,
        activeContributionUSDT6: user.activeUSDT6,
        activeContributionCount: user.count,
        memberRevenueUSD6: usd6,
        memberRevenueACF: usd6ToAcf(usd6, priceE18),
      };
    })
    .sort(compareByAddress)
    .map((member, index) => ({ ...member, batchIndex: batchIndexOf(index, batchSize) }));

  const totalMemberUSD6 = members.reduce((sum, m) => sum + m.memberRevenueUSD6, 0n);
  const totalMemberACF = members.reduce((sum, m) => sum + m.memberRevenueACF, 0n);
  const roundingDustUSD6 = poolUSD6 - totalMemberUSD6;

  // Flooring can take every share to zero when the pool is tiny relative to the member count.
  // Funding zero reverts InvalidAmount, so this is terminal rather than executable.
  if (totalMemberACF === 0n && marketingACF === 0n) {
    return finishNothing(epochId, "ALL_SHARES_ROUNDED_TO_ZERO", { ...common, totalEligibleUSDT6 });
  }

  // ── 8. invariants before anything is written ──────────────────────────
  assertInvariant(
    totalMemberUSD6 <= poolUSD6,
    `Member shares ${totalMemberUSD6} exceed the pool ${poolUSD6}.`,
  );
  assertInvariant(
    roundingDustUSD6 >= 0n,
    `Rounding dust is negative (${roundingDustUSD6}).`,
  );
  assertInvariant(
    totalEligibleUSDT6 === eligibleUsers.reduce((s, u) => s + u.activeUSDT6, 0n),
    "Total eligible contribution does not equal the sum of member contributions.",
  );
  assertInvariant(
    new Set(members.map((m) => m.externalEOA)).size === members.length,
    "Two eligible members share an external EOA; distributeBatch would revert AlreadyPaid.",
  );
  assertInvariant(
    new Set(members.map((m) => m.externalEOA)).size === members.length,
    "Two eligible members share an address.",
  );
  assertInvariant(
    members.every((m) => m.memberRevenueACF > 0n || m.memberRevenueUSD6 === 0n),
    "A member has a positive USD share but zero ACF; the conversion is inconsistent.",
  );

  // Members whose floored ACF is zero cannot be included: distributeBatch reverts InvalidAmount
  // on a zero amount, which would fail the whole batch.
  const payable = members.filter((m) => m.memberRevenueACF > 0n);
  assertInvariant(
    payable.length > 0 || marketingACF > 0n,
    "Neither a member nor marketing has a positive ACF obligation, yet the epoch is executable.",
  );

  // Re-batch over the payable set so no batch contains a zero-amount member, keeping the
  // deterministic address order.
  const finalMembers = payable.map((member, index) => ({
    ...member, batchIndex: batchIndexOf(index, batchSize),
  }));
  const finalTotalACF = finalMembers.reduce((sum, m) => sum + m.memberRevenueACF, 0n);
  const finalTotalUSD6 = finalMembers.reduce((sum, m) => sum + m.memberRevenueUSD6, 0n);
  const finalDust = poolUSD6 - finalTotalUSD6;
  const batchCount = finalMembers.length === 0 ? 0 : finalMembers.at(-1)!.batchIndex + 1;

  // What Treasury funds for this epoch: both obligations, and not a unit more. The distributor
  // has no sweep, so anything funded beyond what is actually paid out is stranded in it forever —
  // which is why this is the sum of the FLOORED amounts rather than the theoretical pool.
  const totalObligationACF = finalTotalACF + marketingACF;
  assertInvariant(
    totalObligationACF > 0n,
    `Epoch ${epochId} is executable but owes nothing; fundDAORevenueEpoch would revert.`,
  );

  // ── 9. manifest ───────────────────────────────────────────────────────
  const addresses = deploymentAddresses();
  const batches: ManifestBatch[] = [];
  for (let index = 0; index < batchCount; index += 1) {
    const slice = finalMembers.filter((m) => m.batchIndex === index);
    batches.push({
      batchIndex: index,
      externalEOAs: slice.map((m) => m.externalEOA),
      recipients: slice.map((m) => m.externalEOA),
      amountsACF: slice.map((m) => m.memberRevenueACF.toString()),
      batchTotalACF: slice.reduce((sum, m) => sum + m.memberRevenueACF, 0n).toString(),
    });
  }
  assertInvariant(
    batches.every((b) => b.externalEOAs.length > 0 && b.externalEOAs.length <= batchSize),
    "A batch is empty or exceeds the configured batch size.",
  );
  assertInvariant(
    batches.reduce((sum, b) => sum + BigInt(b.batchTotalACF), 0n) === finalTotalACF,
    "Batch totals do not sum to the epoch obligation.",
  );

  // The member commitment: what the AUTHORIZER will put on chain, and what every member transfer
  // must prove against. Built from the final payable set — the same amounts the manifest carries
  // — so the root, the manifest and the per-member rows cannot disagree.
  const commitment = finalMembers.length > 0
    ? buildMemberCommitment(epochId, finalMembers.map((m) => ({
        externalEOA: m.externalEOA, amountACF: m.memberRevenueACF,
      })))
    : null;
  const memberRoot = commitment?.root ?? ZERO_ROOT;
  assertInvariant(
    (finalTotalACF === 0n) === (memberRoot === ZERO_ROOT),
    `Epoch ${epochId} has a member total of ${finalTotalACF} and a root of ${memberRoot}; the ` +
      "contract refuses an authorization where one is zero and the other is not.",
  );

  const manifest: DAORevenueManifest = {
    chainId: config.chainId,
    daoAddress: k.daoContractAddress,
    treasuryAddress: addresses.treasuryAddress,
    distributorAddress: k.distributorAddress,
    stakingContractAddress: addresses.stakingContractAddress,
    epochId,
    windowStart,
    snapshotAt,
    snapshotBlockNumber,
    priceE18: priceE18.toString(),
    systemRegularSelfACF: revenue.regularSelfACF.toString(),
    systemDAOStakeRewardACF: revenue.daoStakeRewardACF.toString(),
    systemSelfRewardACF: revenue.totalSelfACF.toString(),
    systemRevenueUSD6: systemRevenueUSD6.toString(),
    memberRevenueRateE6: daoConfig.memberRevenueRateE6.toString(),
    silverMinimumUSDT6: daoConfig.silverMinimumUSDT6.toString(),
    daoRevenuePoolUSD6: poolUSD6.toString(),
    totalEligibleContributionUSDT6: totalEligibleUSDT6.toString(),
    totalMemberRevenueUSD6: finalTotalUSD6.toString(),
    totalMemberRevenueACF: finalTotalACF.toString(),
    roundingDustUSD6: finalDust.toString(),
    memberRoot,
    marketingRateE6: daoConfig.marketingRateE6.toString(),
    marketingCollector: daoConfig.marketingCollector,
    marketingRevenueUSD6: marketingUSD6.toString(),
    marketingRevenueACF: marketingACF.toString(),
    totalObligationACF: totalObligationACF.toString(),
    memberCount: finalMembers.length,
    batchCount,
    batches,
  };
  const hash = manifestHash(manifest);

  // ── 10. persist, then prove it landed ─────────────────────────────────
  const epochDoc = {
    ...k, ...addresses, epochId,
    windowStart, snapshotAt, snapshotBlockNumber,
    priceE18: priceE18.toString(),
    systemRegularSelfACF: revenue.regularSelfACF.toString(),
    systemDAOStakeRewardACF: revenue.daoStakeRewardACF.toString(),
    systemSelfRewardACF: revenue.totalSelfACF.toString(),
    systemRevenueUSD6: systemRevenueUSD6.toString(),
    revenueEnabledAtSnapshot: true,
    silverMinimumUSDT6: daoConfig.silverMinimumUSDT6.toString(),
    goldMinimumUSDT6: daoConfig.goldMinimumUSDT6.toString(),
    memberRevenueRateE6: daoConfig.memberRevenueRateE6.toString(),
    configBlockNumber: daoConfig.blockNumber,
    configLogIndex: daoConfig.logIndex,
    daoRevenuePoolUSD6: poolUSD6.toString(),
    totalEligibleContributionUSDT6: totalEligibleUSDT6.toString(),
    totalMemberRevenueUSD6: finalTotalUSD6.toString(),
    totalMemberRevenueACF: finalTotalACF.toString(),
    roundingDustUSD6: finalDust.toString(),
    marketingRateE6: daoConfig.marketingRateE6.toString(),
    marketingCollector: daoConfig.marketingCollector,
    marketingRevenueUSD6: marketingUSD6.toString(),
    marketingRevenueACF: marketingACF.toString(),
    totalObligationACF: totalObligationACF.toString(),
    memberRoot,
    eligibleMembers: finalMembers.length,
    batchCount,
    manifestHash: hash,
  };

  const memberDocs = finalMembers.map((member) => ({
    chainId: config.chainId,
    daoContractAddress: k.daoContractAddress,
    distributorAddress: k.distributorAddress,
    epochId,
    userId: member.userId,
    externalEOA: member.externalEOA,
    activeContributionUSDT6: member.activeContributionUSDT6.toString(),
    totalEligibleContributionUSDT6: totalEligibleUSDT6.toString(),
    activeContributionCount: member.activeContributionCount,
    memberRevenueRateE6: daoConfig.memberRevenueRateE6.toString(),
    systemRevenueUSD6: systemRevenueUSD6.toString(),
    daoRevenuePoolUSD6: poolUSD6.toString(),
    priceE18: priceE18.toString(),
    memberRevenueUSD6: member.memberRevenueUSD6.toString(),
    memberRevenueACF: member.memberRevenueACF.toString(),
    batchIndex: member.batchIndex,
  }));

  await persistMemberEntries(k, epochId, memberDocs);
  await persistEpoch(k, epochId, epochDoc, false);

  logger.info("dao revenue epoch calculated", {
    epochId, members: finalMembers.length, batchCount,
    obligationACF: finalTotalACF.toString(), manifestHash: hash,
  });

  return {
    epochId,
    status: "CALCULATED",
    eligibleMembers: finalMembers.length,
    systemSelfRewardACF: revenue.totalSelfACF.toString(),
    systemRevenueUSD6: systemRevenueUSD6.toString(),
    daoRevenuePoolUSD6: poolUSD6.toString(),
    totalMemberRevenueACF: finalTotalACF.toString(),
    roundingDustUSD6: finalDust.toString(),
    batchCount,
    manifestHash: hash,
  };
}

/**
 * Writes member entries, then PROVES they are present and correct.
 *
 * `insertMany(ordered: false)` cannot be trusted to report what it skipped, so its error is
 * deliberately not inspected: the only reliable question is what the database holds afterwards.
 * An identical existing row is fine on retry; a divergent one fails and is never repaired.
 */
async function persistMemberEntries(
  k: ReturnType<typeof key>,
  epochId: number,
  docs: Record<string, unknown>[],
): Promise<void> {
  try {
    await DAORevenueMemberEntry.insertMany(docs, { ordered: false });
  } catch {
    // Intentionally swallowed; the read-back below is the only authority.
  }

  const stored = await DAORevenueMemberEntry.find({
    chainId: k.chainId, distributorAddress: k.distributorAddress, epochId,
  }).lean();
  const byUserId = new Map(stored.map((row) => [row.userId, row as Record<string, unknown>]));

  const missing = docs.filter((doc) => !byUserId.has(doc.userId as string));
  if (missing.length > 0) {
    throw new DAORevenueInvariantError(
      `Persisted ${stored.length} of ${docs.length} DAO revenue member entries for epoch ` +
        `${epochId}; missing user(s): ${missing.map((d) => d.userId).slice(0, 10).join(", ")}.`,
    );
  }
  if (stored.length !== docs.length) {
    throw new DAORevenueInvariantError(
      `Epoch ${epochId} has ${stored.length} member entries but ${docs.length} were calculated. ` +
        "An unexpected row would be paid without a calculated obligation.",
    );
  }

  for (const doc of docs) {
    assertRowMatches(
      `DAO revenue member entry ${doc.userId} for epoch ${epochId}`,
      byUserId.get(doc.userId as string)!,
      doc,
      MEMBER_ENTRY_FIELDS,
    );
  }

  const storedTotal = stored.reduce((sum, row) => sum + BigInt(row.memberRevenueACF), 0n);
  const expectedTotal = docs.reduce((sum, doc) => sum + BigInt(doc.memberRevenueACF as string), 0n);
  assertInvariant(
    storedTotal === expectedTotal,
    `Stored member obligations total ${storedTotal} ACF, expected ${expectedTotal}.`,
  );
}

/**
 * Writes the epoch row, reads it back, verifies it, and only then marks it CALCULATED.
 *
 * Mongoose strips `immutable: true` fields from a `$set` on an existing document — silently —
 * so every financial field must land in the SAME write that creates the row. That is why no
 * lease row is taken before the numbers exist: a placeholder would permanently block them.
 *
 * A row left behind by an earlier FAILED or interrupted attempt carries no trusted financial
 * content and nothing was ever funded against it (funding only happens from CALCULATED, and
 * the executor re-reads the chain regardless), so it is replaced. A row that reached CALCULATED
 * or beyond is never replaced — it is verified, and a divergence is reported.
 */
async function persistEpoch(
  k: ReturnType<typeof key>,
  epochId: number,
  doc: Record<string, unknown>,
  terminal: boolean,
): Promise<void> {
  const existing = await DAORevenueEpoch.findOne({ ...k, epochId }).lean();

  if (existing && !REPLACEABLE.includes(existing.status)) {
    // Already decided. Prove the stored numbers match rather than writing over them.
    assertRowMatches(
      `DAO revenue epoch ${epochId}`, existing as Record<string, unknown>, doc, EPOCH_FIELDS,
    );
    return;
  }

  const attempts = (existing?.attempts ?? 0) + 1;
  if (existing) await DAORevenueEpoch.deleteOne({ _id: existing._id });

  try {
    await DAORevenueEpoch.create({
      ...doc,
      attempts,
      status: terminal ? "NOTHING_TO_DISTRIBUTE" : "CALCULATED",
      calculatedAt: new Date(),
      completedAt: terminal ? new Date() : null,
      leaseExpiresAt: null,
    });
  } catch (cause) {
    // A concurrent worker won the unique index. Its numbers are deterministic, so they must
    // equal ours; the read-back below is what decides.
    if ((cause as { code?: number }).code !== 11000) throw cause;
  }

  const stored = await DAORevenueEpoch.findOne({ ...k, epochId }).lean();
  if (!stored) {
    throw new DAORevenueInvariantError(
      `DAO revenue epoch ${epochId} is absent immediately after writing it.`,
    );
  }
  assertRowMatches(
    `DAO revenue epoch ${epochId}`, stored as Record<string, unknown>, doc, EPOCH_FIELDS,
  );
  if (stored.status !== (terminal ? "NOTHING_TO_DISTRIBUTE" : "CALCULATED")) {
    throw new DAORevenueInvariantError(
      `DAO revenue epoch ${epochId} is ${stored.status}, expected ` +
        `${terminal ? "NOTHING_TO_DISTRIBUTE" : "CALCULATED"} after a successful calculation.`,
    );
  }
}

/**
 * Records a terminal epoch with nothing owed.
 *
 * Written rather than skipped so the decision, and the configuration it was made under, are
 * permanent. No Treasury or distributor call is made: funding zero reverts InvalidAmount.
 */
async function finishNothing(
  epochId: number,
  reason: NothingReason,
  values: {
    snapshotAt: number; windowStart: number; snapshotBlockNumber: number; priceE18: bigint;
    daoConfig: Awaited<ReturnType<typeof resolveConfigAsOf>>;
    regularSelfACF: bigint; daoStakeRewardACF: bigint; systemSelfACF: bigint;
    systemRevenueUSD6: bigint; poolUSD6: bigint; totalEligibleUSDT6: bigint;
    marketingUSD6: bigint; marketingACF: bigint;
  },
): Promise<DAORevenueEpochResult> {
  const k = key();
  const addresses = deploymentAddresses();
  const doc = {
    ...k, ...addresses, epochId,
    windowStart: values.windowStart,
    snapshotAt: values.snapshotAt,
    snapshotBlockNumber: values.snapshotBlockNumber,
    priceE18: values.priceE18.toString(),
    systemRegularSelfACF: values.regularSelfACF.toString(),
    systemDAOStakeRewardACF: values.daoStakeRewardACF.toString(),
    systemSelfRewardACF: values.systemSelfACF.toString(),
    systemRevenueUSD6: values.systemRevenueUSD6.toString(),
    revenueEnabledAtSnapshot: values.daoConfig.revenueEnabled,
    silverMinimumUSDT6: values.daoConfig.silverMinimumUSDT6.toString(),
    goldMinimumUSDT6: values.daoConfig.goldMinimumUSDT6.toString(),
    memberRevenueRateE6: values.daoConfig.memberRevenueRateE6.toString(),
    marketingRateE6: values.daoConfig.marketingRateE6.toString(),
    marketingCollector: values.daoConfig.marketingCollector,
    configBlockNumber: values.daoConfig.blockNumber,
    configLogIndex: values.daoConfig.logIndex,
    daoRevenuePoolUSD6: values.poolUSD6.toString(),
    totalEligibleContributionUSDT6: values.totalEligibleUSDT6.toString(),
    totalMemberRevenueUSD6: "0",
    totalMemberRevenueACF: "0",
    roundingDustUSD6: values.poolUSD6.toString(),
    // Reached only when nothing is payable at all, so both obligations are zero here. The
    // marketing figures are still recorded, because what the epoch WOULD have owed is part of
    // the audit trail even when it owed nothing.
    marketingRevenueUSD6: values.marketingUSD6.toString(),
    marketingRevenueACF: "0",
    totalObligationACF: "0",
    memberRoot: ZERO_ROOT,
    eligibleMembers: 0,
    batchCount: 0,
    manifestHash: `0x${"0".repeat(64)}`,
    reason,
  };
  await persistEpoch(k, epochId, doc, true);
  logger.info("dao revenue epoch has nothing to distribute", { epochId, reason });
  return { epochId, status: "NOTHING_TO_DISTRIBUTE", reason };
}
