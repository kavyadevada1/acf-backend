/**
 * Environment bootstrap for the DAO revenue suites.
 *
 * config.ts reads process.env once at import time, so every value must be set before any module
 * that imports it loads. Kept beside the Phase 3 equivalent so the two cannot drift.
 */
type EpochAuthorizationState = import("./chain.js").EpochAuthorizationState;

export const TEST_ROOT_EOA = "0x9999999999999999999999999999999999999999";
export const TEST_STAKING = "0x9eDbbf53f784450CC8Fd50730984Cb7D8DDF743d";
export const TEST_DAO = "0x9cf32271E052Cbbc1D6C564B6fE6a86B6ED08E45";
export const TEST_DISTRIBUTOR = "0xc152dF6448FB68702B661C4aE210E41f5E76931E";
export const TEST_TREASURY = "0x114fe8e3414bc49A24C6efd9E702cD66B9A80251";
export const TEST_ACF = "0x7AEB95CaE1e5442Fe1170555ae81280B763D3BF1";
/** The DAO marketing recipient every fixture models, matching MARKETING_FEE_COLLECTOR_ADDRESS. */
export const TEST_MARKETING_COLLECTOR = "0x000000000000000000000000000000000000a7e1";

process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/unused-by-tests";
process.env.PORT ??= "3001";
process.env.JWT_SECRET ??= "test-secret-at-least-thirty-two-characters-long";
process.env.REGISTERED_EOA_DIRECT_RULE_START_EPOCH ??= "1";
process.env.JWT_EXPIRES_IN_SECONDS ??= "86400";
process.env.CHAIN_ID ??= "80002";
process.env.CHALLENGE_TTL_SECONDS ??= "300";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ACF_SWAP_ADDRESS ??= "0x16F2d748A5a4359d1948F261662dD9f0d5fEadDD";
process.env.ACF_STAKING_ADDRESS ??= TEST_STAKING;
process.env.ACF_TOKEN_ADDRESS ??= TEST_ACF;
process.env.ACF_BOND_ADDRESS ??= "0x3a97D05a088aDBB79936914F245c2E0bf7F511f2";
process.env.ACF_DAO_ADDRESS ??= TEST_DAO;
process.env.MOCK_USDT_ADDRESS ??= "0x21ff9e803fc496e4db1c1a6c354690636b9fc330";
process.env.SWAP_CONFIRMATIONS ??= "1";
process.env.REWARD_ENGINE_ACTIVATION_EPOCH ??= "41000";
process.env.WITHDRAWAL_ADDRESS ??= "0x882db912586869315C2720dE72224d79B9D99Ea1";
process.env.TREASURY_ADDRESS ??= TEST_TREASURY;
process.env.DAO_REVENUE_DISTRIBUTOR_ADDRESS ??= TEST_DISTRIBUTOR;

export function assertDisposable(uri: string): string {
  const name = new URL(uri).pathname.replace(/^\//, "");
  if (!name || !/test/i.test(name)) {
    throw new Error(`MONGODB_TEST_URI must name a test database (got "${name}").`);
  }
  return uri;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export interface FakeDAOChainOptions {
  /** Phase 3 checkpoints the chain reports as already funded. */
  standardFunded?: Set<number>;
  funded?: Map<number, bigint>;
  distributed?: Map<number, bigint>;
  paid?: Map<string, boolean>;
  treasuryFunded?: Set<number>;
  treasuryBalance?: bigint;
  requiredReserve?: bigint;
  maxBatchSize?: number;
  payoutDestination?: string;
  roles?: { treasury: boolean; distributor: boolean };
  chainId?: number;
  /** Marketing ACF the chain reports paid per epoch; absent or zero means unpaid. */
  marketingPaid?: Map<number, bigint>;
  /**
   * Each epoch's on-chain payable set, as the authorizer committed it.
   *
   * `authorize()` writes it and `fund()` refuses an amount that does not match its total, exactly
   * as the contracts do — so a fixture cannot reach a payout from a state the chain cannot be in.
   */
  authorizations?: Map<number, EpochAuthorizationState>;
  /** ACF already paid to members per epoch. */
  memberDistributed?: Map<number, bigint>;
}

/** A fully controllable stand-in for every DAO revenue chain read. */
const ZERO_ROOT = `0x${"0".repeat(64)}`;
const UNAUTHORIZED: EpochAuthorizationState = {
  memberRoot: ZERO_ROOT,
  memberTotalACF: 0n,
  marketingRecipient: `0x${"0".repeat(40)}`,
  marketingAmountACF: 0n,
  totalObligationACF: 0n,
  authorized: false,
};

export function fakeDAOChain(o: FakeDAOChainOptions = {}) {
  const state = {
    funded: o.funded ?? new Map<number, bigint>(),
    distributed: o.distributed ?? new Map<number, bigint>(),
    paid: o.paid ?? new Map<string, boolean>(),
    treasuryFunded: o.treasuryFunded ?? new Set<number>(),
    treasuryBalance: o.treasuryBalance ?? 499_995n * 10n ** 18n,
    requiredReserve: o.requiredReserve ?? 10_783n * 10n ** 18n,
    maxBatchSize: o.maxBatchSize ?? 50,
    payoutDestination: (o.payoutDestination ?? TEST_DISTRIBUTOR).toLowerCase(),
    roles: o.roles ?? { treasury: true, distributor: true },
    standardFunded: o.standardFunded ?? new Set<number>(),
    chainId: o.chainId ?? 80002,
    marketingPaid: o.marketingPaid ?? new Map<number, bigint>(),
    authorizations: o.authorizations ?? new Map<number, EpochAuthorizationState>(),
    memberDistributed: o.memberDistributed ?? new Map<number, bigint>(),
  };
  const paidKey = (epochId: number, eoa: string) => `${epochId}:${eoa.toLowerCase()}`;

  return {
    state,
    reader: {
      async distributorWiring() {
        return {
          acf: TEST_ACF.toLowerCase(),
          treasury: TEST_TREASURY.toLowerCase(),
          maxBatchSize: state.maxBatchSize,
        };
      },
      async treasuryDaoPayoutDestination() { return state.payoutDestination; },
      async treasuryAcf() { return TEST_ACF.toLowerCase(); },
      async treasuryFunded(epochId: number) { return state.treasuryFunded.has(epochId); },
      async standardRewardEpochFunded(checkpointId: number) {
        return state.standardFunded.has(checkpointId);
      },
      async epochFundedAmount(epochId: number) { return state.funded.get(epochId) ?? 0n; },
      async epochDistributedAmount(epochId: number) { return state.distributed.get(epochId) ?? 0n; },
      async epochMarketingPaidAmount(epochId: number) {
        return state.marketingPaid.get(epochId) ?? 0n;
      },
      async epochAuthorization(epochId: number) {
        return state.authorizations.get(epochId) ?? UNAUTHORIZED;
      },
      async epochMemberDistributedAmount(epochId: number) {
        return state.memberDistributed.get(epochId) ?? 0n;
      },
      async isPaid(epochId: number, eoas: string[]) {
        return new Map(eoas.map((e) => [
          e.toLowerCase(), state.paid.get(paidKey(epochId, e)) === true,
        ]));
      },
      async treasuryBalanceACF() { return state.treasuryBalance; },
      async requiredReserve() { return state.requiredReserve; },
      async executorRoles() { return state.roles; },
      async chainId() { return state.chainId; },
      async blockNumber() { return 1_000_000; },
      daoAddress() { return TEST_DAO.toLowerCase(); },
      distributorAddress() { return TEST_DISTRIBUTOR.toLowerCase(); },
    },
    /**
     * Applies what a successful funding would do on chain, PINNING the marketing split.
     *
     * Treasury pins the recipient and amount atomically with the transfer, so a fake that funded
     * without pinning would let a test reach the payout with nothing pinned — a state the chain
     * cannot be in.
     */
    fund(epochId: number, amount: bigint) {
      // Mirrors the contract: funding is refused unless it equals the authorized total exactly,
      // so a fixture cannot fund an unauthorized or over-funded epoch and reach a payout from a
      // state the chain would never allow.
      const auth = state.authorizations.get(epochId);
      if (!auth?.authorized) {
        throw new Error(`fakeDAOChain.fund: epoch ${epochId} is not authorized`);
      }
      if (auth.totalObligationACF !== amount) {
        throw new Error(
          `fakeDAOChain.fund: epoch ${epochId} is authorized for ${auth.totalObligationACF}, ` +
            `not ${amount}`,
        );
      }
      state.funded.set(epochId, amount);
      state.treasuryFunded.add(epochId);
      state.treasuryBalance -= amount;
    },
    /** Applies what the AUTHORIZER's transaction would do: commits the epoch's payable set. */
    authorize(
      epochId: number,
      values: {
        memberRoot?: string; memberTotalACF?: bigint;
        marketingRecipient?: string; marketingAmountACF?: bigint;
      } = {},
    ) {
      const memberTotal = values.memberTotalACF ?? 0n;
      const marketing = values.marketingAmountACF ?? 0n;
      state.authorizations.set(epochId, {
        memberRoot: (values.memberRoot ?? ZERO_ROOT).toLowerCase(),
        memberTotalACF: memberTotal,
        marketingRecipient: (marketing === 0n
          ? `0x${"0".repeat(40)}`
          : values.marketingRecipient ?? TEST_MARKETING_COLLECTOR).toLowerCase(),
        marketingAmountACF: marketing,
        totalObligationACF: memberTotal + marketing,
        authorized: true,
      });
    },
    /** Applies what a successful distributeBatch would do. */
    pay(epochId: number, eoa: string, amount: bigint) {
      state.paid.set(paidKey(epochId, eoa), true);
      state.distributed.set(epochId, (state.distributed.get(epochId) ?? 0n) + amount);
      state.memberDistributed.set(epochId, (state.memberDistributed.get(epochId) ?? 0n) + amount);
    },
    /**
     * Applies what a successful payMarketing would do.
     *
     * Advances the SAME `distributed` accumulator the member batches use, exactly as the contract
     * does: one epoch funding covers both obligations, so a fake that tracked them separately
     * would let a reconciliation test pass against arithmetic the chain does not perform.
     */
    payMarketing(epochId: number, amount: bigint) {
      state.marketingPaid.set(epochId, amount);
      state.distributed.set(epochId, (state.distributed.get(epochId) ?? 0n) + amount);
    },
  };
}
