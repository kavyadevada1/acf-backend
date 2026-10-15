import { getAddress } from "viem";
import { config } from "../config.js";
import { publicClient } from "../lib/chain.js";

/**
 * READ-ONLY DAO revenue contract reads.
 *
 * Every function here is an eth_call. The calculation worker and the public API import this
 * module; neither can sign. The two state-changing calls — Treasury.fundDAORevenueEpoch and
 * distributor.distributeBatch — live exclusively in executor.ts, which is the only module that
 * ever constructs a wallet client.
 */

const distributorViewAbi = [
  { type: "function", name: "acf", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "MAX_BATCH_SIZE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalReservedUndistributed", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochFundedAmount", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochDistributedAmount", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochMarketingPaidAmount", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochMarketingRecipient", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "epochMarketingAmount", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochMemberDistributedAmount", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "epochAuthorization", stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "memberRoot", type: "bytes32" },
        { name: "memberTotalACF", type: "uint256" },
        { name: "marketingRecipient", type: "address" },
        { name: "marketingAmountACF", type: "uint256" },
        { name: "totalObligationACF", type: "uint256" },
        { name: "authorized", type: "bool" },
      ],
    }],
  },
  { type: "function", name: "isPaid", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "EPOCH_EXECUTOR_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

const treasuryViewAbi = [
  { type: "function", name: "daoRevenueEpochFunded", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  // Phase 3's standard-reward funding mark. Read ONLY to size the liability DAO funding must
  // leave behind; Phase 4 never calls fundRewardEpoch.
  { type: "function", name: "rewardEpochFunded", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "daoPayoutDestination", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "requiredReserve", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "acf", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "EPOCH_EXECUTOR_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;


const erc20ViewAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** The three ACFDAO configuration events, the sole source of historical revenue config. */
export const revenueConfigUpdatedEventAbi = {
  type: "event",
  name: "RevenueConfigUpdated",
  inputs: [
    { name: "silverMinimumUSDT", type: "uint256", indexed: false },
    { name: "goldMinimumUSDT", type: "uint256", indexed: false },
    { name: "memberRevenuePercentage", type: "uint256", indexed: false },
    { name: "marketingPercentage", type: "uint256", indexed: false },
    { name: "executor", type: "address", indexed: true },
  ],
} as const;

export const revenueEnabledUpdatedEventAbi = {
  type: "event",
  name: "RevenueEnabledUpdated",
  inputs: [
    { name: "enabled", type: "bool", indexed: false },
    { name: "executor", type: "address", indexed: true },
  ],
} as const;

/**
 * MarketingFeeCollectorUpdated, so an epoch's marketing recipient is historical rather than live.
 *
 * The collector is admin-mutable. Resolving it by reading the contract at execution time would
 * mean a change between calculation and payout silently redirected a finalized obligation, so it
 * is folded into the configuration history exactly as the rates are, and the epoch records the
 * address in force at its own snapshot block.
 */
export const marketingFeeCollectorUpdatedEventAbi = {
  type: "event",
  name: "MarketingFeeCollectorUpdated",
  inputs: [
    { name: "previousCollector", type: "address", indexed: true },
    { name: "newCollector", type: "address", indexed: true },
    { name: "executor", type: "address", indexed: true },
  ],
} as const;

/**
 * DAORevenueEpochAuthorized, the only evidence of what an epoch was permitted to pay.
 *
 * Emitted by the AUTHORIZER's transaction, not the executor's. Reconciliation reads it rather
 * than trusting any local record: the chain decides what was payable, and the database cannot
 * override it.
 */
export const daoRevenueEpochAuthorizedEventAbi = {
  type: "event",
  name: "DAORevenueEpochAuthorized",
  inputs: [
    { name: "epochId", type: "uint256", indexed: true },
    { name: "memberRoot", type: "bytes32", indexed: true },
    { name: "memberTotalACF", type: "uint256", indexed: false },
    { name: "marketingRecipient", type: "address", indexed: true },
    { name: "marketingAmountACF", type: "uint256", indexed: false },
    { name: "totalObligationACF", type: "uint256", indexed: false },
    { name: "authorizer", type: "address", indexed: false },
  ],
} as const;

/** DAOMarketingPaid, the only evidence that an epoch's marketing allocation was transferred. */
export const daoMarketingPaidEventAbi = {
  type: "event",
  name: "DAOMarketingPaid",
  inputs: [
    { name: "epochId", type: "uint256", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "executor", type: "address", indexed: false },
  ],
} as const;

/**
 * DAORevenuePaid, for reconciling what the distributor actually transferred.
 *
 * `user` is both the submitted member and the recipient: the distributor transfers to exactly
 * the address it was given, so there is no second address to cross-check.
 */
export const daoRevenuePaidEventAbi = {
  type: "event",
  name: "DAORevenuePaid",
  inputs: [
    { name: "epochId", type: "uint256", indexed: true },
    { name: "user", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "executor", type: "address", indexed: false },
  ],
} as const;

const dao = () => getAddress(config.acfDaoAddress);
const distributor = () => getAddress(config.daoRevenueDistributorAddress);
const treasury = () => getAddress(config.treasuryAddress);

export interface DistributorWiring {
  acf: string;
  treasury: string;
  maxBatchSize: number;
}

/** An epoch's on-chain payable set, exactly as the distributor stores it. */
export interface EpochAuthorizationState {
  memberRoot: string;
  memberTotalACF: bigint;
  marketingRecipient: string;
  marketingAmountACF: bigint;
  totalObligationACF: bigint;
  authorized: boolean;
}

export interface DAORevenueChainReader {
  /** Everything initialize() fixed, so a stale deployment is caught before any signing. */
  distributorWiring(): Promise<DistributorWiring>;
  treasuryDaoPayoutDestination(): Promise<string>;
  treasuryAcf(): Promise<string>;
  /** Treasury's own replay mark, independent of the distributor's. */
  treasuryFunded(epochId: number): Promise<boolean>;
  /**
   * Whether Phase 3 has already funded a standard-reward checkpoint.
   *
   * Read-only, and only to decide whether that checkpoint's obligation still has to be left in
   * the Treasury. Phase 4 has no code path that funds or finalizes a standard reward epoch.
   */
  standardRewardEpochFunded(checkpointId: number): Promise<boolean>;
  /** The exact amount the distributor recorded, or 0n if the epoch was never funded. */
  epochFundedAmount(epochId: number): Promise<bigint>;
  epochDistributedAmount(epochId: number): Promise<bigint>;
  /** Marketing ACF already paid for an epoch; zero means unpaid. The chain's replay flag. */
  epochMarketingPaidAmount(epochId: number): Promise<bigint>;
  /**
   * The epoch's complete authorized payable set, or an unauthorized zero record.
   *
   * The on-chain answer to "who may be paid what in this epoch". Preflight and reconciliation
   * compare the epoch's own calculated figures against THIS rather than trusting either side,
   * because this is what the distributor will actually act on.
   */
  epochAuthorization(epochId: number): Promise<EpochAuthorizationState>;
  /** ACF already paid to members for an epoch, bounded on chain by the authorized member total. */
  epochMemberDistributedAmount(epochId: number): Promise<bigint>;
  /** Keyed by EXTERNAL EOA, matching distributeBatch's users[] argument. */
  isPaid(epochId: number, externalEOAs: string[]): Promise<Map<string, boolean>>;
  treasuryBalanceACF(): Promise<bigint>;
  requiredReserve(): Promise<bigint>;
  /** Whether an address may fund (Treasury) and distribute (distributor). */
  executorRoles(address: string): Promise<{ treasury: boolean; distributor: boolean }>;
  chainId(): Promise<number>;
  blockNumber(): Promise<number>;
  daoAddress(): string;
  distributorAddress(): string;
}

export const daoRevenueChainReader: DAORevenueChainReader = {
  async distributorWiring() {
    const [acf, treasuryAddr, maxBatchSize] = await Promise.all([
      publicClient.readContract({ address: distributor(), abi: distributorViewAbi, functionName: "acf" }),
      publicClient.readContract({ address: distributor(), abi: distributorViewAbi, functionName: "treasury" }),
      publicClient.readContract({ address: distributor(), abi: distributorViewAbi, functionName: "MAX_BATCH_SIZE" }),
    ]);
    return {
      acf: String(acf).toLowerCase(),
      treasury: String(treasuryAddr).toLowerCase(),
      maxBatchSize: Number(maxBatchSize),
    };
  },

  async treasuryDaoPayoutDestination() {
    const value = await publicClient.readContract({
      address: treasury(), abi: treasuryViewAbi, functionName: "daoPayoutDestination",
    });
    return String(value).toLowerCase();
  },

  async treasuryAcf() {
    const value = await publicClient.readContract({
      address: treasury(), abi: treasuryViewAbi, functionName: "acf",
    });
    return String(value).toLowerCase();
  },

  async treasuryFunded(epochId) {
    return (await publicClient.readContract({
      address: treasury(), abi: treasuryViewAbi, functionName: "daoRevenueEpochFunded",
      args: [BigInt(epochId)],
    })) as boolean;
  },

  async standardRewardEpochFunded(checkpointId) {
    return (await publicClient.readContract({
      address: treasury(), abi: treasuryViewAbi, functionName: "rewardEpochFunded",
      args: [BigInt(checkpointId)],
    })) as boolean;
  },

  async epochFundedAmount(epochId) {
    return (await publicClient.readContract({
      address: distributor(), abi: distributorViewAbi, functionName: "epochFundedAmount",
      args: [BigInt(epochId)],
    })) as bigint;
  },

  async epochDistributedAmount(epochId) {
    return (await publicClient.readContract({
      address: distributor(), abi: distributorViewAbi, functionName: "epochDistributedAmount",
      args: [BigInt(epochId)],
    })) as bigint;
  },

  async epochMarketingPaidAmount(epochId) {
    return (await publicClient.readContract({
      address: distributor(), abi: distributorViewAbi, functionName: "epochMarketingPaidAmount",
      args: [BigInt(epochId)],
    })) as bigint;
  },

  async epochAuthorization(epochId) {
    const auth = await publicClient.readContract({
      address: distributor(), abi: distributorViewAbi, functionName: "epochAuthorization",
      args: [BigInt(epochId)],
    }) as {
      memberRoot: string; memberTotalACF: bigint; marketingRecipient: string;
      marketingAmountACF: bigint; totalObligationACF: bigint; authorized: boolean;
    };
    return {
      memberRoot: auth.memberRoot.toLowerCase(),
      memberTotalACF: auth.memberTotalACF,
      marketingRecipient: auth.marketingRecipient.toLowerCase(),
      marketingAmountACF: auth.marketingAmountACF,
      totalObligationACF: auth.totalObligationACF,
      authorized: auth.authorized,
    };
  },

  async epochMemberDistributedAmount(epochId) {
    return (await publicClient.readContract({
      address: distributor(), abi: distributorViewAbi,
      functionName: "epochMemberDistributedAmount", args: [BigInt(epochId)],
    })) as bigint;
  },

  async isPaid(epochId, externalEOAs) {
    const entries = await Promise.all(
      externalEOAs.map(async (eoa) => {
        const paid = await publicClient.readContract({
          address: distributor(), abi: distributorViewAbi, functionName: "isPaid",
          args: [BigInt(epochId), getAddress(eoa)],
        });
        return [eoa.toLowerCase(), paid as boolean] as const;
      }),
    );
    return new Map(entries);
  },

  async treasuryBalanceACF() {
    return (await publicClient.readContract({
      address: getAddress(config.acfTokenAddress), abi: erc20ViewAbi, functionName: "balanceOf",
      args: [treasury()],
    })) as bigint;
  },

  async requiredReserve() {
    return (await publicClient.readContract({
      address: treasury(), abi: treasuryViewAbi, functionName: "requiredReserve",
    })) as bigint;
  },

  async executorRoles(address) {
    const who = getAddress(address);
    const [treasuryRole, distributorRole] = await Promise.all([
      publicClient.readContract({ address: treasury(), abi: treasuryViewAbi, functionName: "EPOCH_EXECUTOR_ROLE" }),
      publicClient.readContract({ address: distributor(), abi: distributorViewAbi, functionName: "EPOCH_EXECUTOR_ROLE" }),
    ]);
    const [onTreasury, onDistributor] = await Promise.all([
      publicClient.readContract({
        address: treasury(), abi: treasuryViewAbi, functionName: "hasRole",
        args: [treasuryRole as `0x${string}`, who],
      }),
      publicClient.readContract({
        address: distributor(), abi: distributorViewAbi, functionName: "hasRole",
        args: [distributorRole as `0x${string}`, who],
      }),
    ]);
    return { treasury: onTreasury as boolean, distributor: onDistributor as boolean };
  },

  async chainId() {
    return publicClient.getChainId();
  },

  async blockNumber() {
    return Number(await publicClient.getBlockNumber());
  },

  daoAddress() {
    return dao().toLowerCase();
  },

  distributorAddress() {
    return distributor().toLowerCase();
  },
};
