/**
 * Shared environment bootstrap for the settlement suites.
 *
 * config.ts reads process.env once at import time, so every value must be set before any module
 * that imports it loads. Kept in one place so the suites cannot drift apart.
 */
export const TEST_ROOT_EOA = "0x9999999999999999999999999999999999999999";
export const TEST_STAKING = "0x9eDbbf53f784450CC8Fd50730984Cb7D8DDF743d";
export const TEST_WITHDRAWAL = "0x882db912586869315C2720dE72224d79B9D99Ea1";
export const TEST_TREASURY = "0x114fe8e3414bc49A24C6efd9E702cD66B9A80251";

process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/unused-by-tests";
process.env.PORT ??= "3001";
process.env.DAO_REVENUE_DISTRIBUTOR_ADDRESS ??= "0xc152dF6448FB68702B661C4aE210E41f5E76931E";
process.env.JWT_SECRET ??= "test-secret-at-least-thirty-two-characters-long";
process.env.REGISTERED_EOA_DIRECT_RULE_START_EPOCH ??= "1";
process.env.JWT_EXPIRES_IN_SECONDS ??= "86400";
process.env.CHAIN_ID ??= "80002";
process.env.CHALLENGE_TTL_SECONDS ??= "300";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ACF_SWAP_ADDRESS ??= "0x16F2d748A5a4359d1948F261662dD9f0d5fEadDD";
process.env.ACF_STAKING_ADDRESS ??= TEST_STAKING;
process.env.ACF_TOKEN_ADDRESS ??= "0x7AEB95CaE1e5442Fe1170555ae81280B763D3BF1";
process.env.ACF_BOND_ADDRESS ??= "0x3a97D05a088aDBB79936914F245c2E0bf7F511f2";
process.env.ACF_DAO_ADDRESS ??= "0x9cf32271E052Cbbc1D6C564B6fE6a86B6ED08E45";
process.env.MOCK_USDT_ADDRESS ??= "0x21ff9e803fc496e4db1c1a6c354690636b9fc330";
process.env.SWAP_CONFIRMATIONS ??= "1";
process.env.REWARD_ENGINE_ACTIVATION_EPOCH ??= "41000";
process.env.WITHDRAWAL_ADDRESS ??= TEST_WITHDRAWAL;
process.env.TREASURY_ADDRESS ??= TEST_TREASURY;

export function assertDisposable(uri: string): string {
  const name = new URL(uri).pathname.replace(/^\//, "");
  if (!name || !/test/i.test(name)) {
    throw new Error(`MONGODB_TEST_URI must name a test database (got "${name}").`);
  }
  return uri;
}

import type { SettlementChainReader } from "./chain.js";
import { User } from "../models/User.js";

/** A fully controllable stand-in for the Withdrawal/Treasury views. */
export interface FakeChainOptions {
  root?: string;
  cumulativeTotal?: bigint;
  totalClaimed?: bigint;
  latestEpochId?: number;
  finalized?: Set<number>;
  funded?: Set<number>;
  claimed?: Map<string, bigint>;
  treasuryWithdrawal?: string;
  blockNumber?: number;
  /** Claim-fee and balance views, used by the quote path. */
  priceE18?: bigint;
  percentageE6?: bigint;
  usdtBalance?: bigint;
  usdtAllowance?: bigint;
  executorRoles?: { treasury: boolean; withdrawal: boolean };
  /** Whether the probed address holds REWARD_AUTHORIZER_ROLE on the Withdrawal. */
  rewardAuthorizerRole?: boolean;
  /**
   * ACFWithdrawal.treasury(), the only address it registers funding from.
   *
   * Defaults to the configured Treasury, which is the correctly bound state. Set it to something
   * else to model a Withdrawal that was never bound, or bound to the wrong Treasury.
   */
  withdrawalTreasuryBinding?: string;
  /**
   * The epochs ACFWithdrawal holds a commitment for, keyed by checkpoint id.
   *
   * Nothing can be funded or finalized without one, so a fixture that wants to model an
   * executable checkpoint seeds it with `authorize` below rather than with `funded` alone.
   */
  authorizations?: Map<number, { root: string; total: bigint; funding: bigint }>;
  /**
   * The ROOT account the contract reports.
   *
   * Left unset, the fake agrees with the seeded tree: it answers with the EOA of the single
   * parentless user, or TEST_ROOT_EOA when there is none. That is the normal state of the world
   * — the contract's ROOT is the wallet that registered as the referral root — so a fixture does
   * not have to restate it, and no suite accidentally models a rotation it did not intend.
   *
   * Set it explicitly to model a rotation the backend has not yet synchronized.
   */
  currentRootEOA?: string;
  /** Makes currentRootEOA() throw, for the fail-closed paths. */
  rootReadFails?: boolean;
  /**
   * Addresses the contract flags as ROOT-routed, beyond the current ROOT.
   *
   * The current ROOT is always flagged, as it is on chain from initialization onward, so this
   * lists the HISTORICAL ones — the addresses a rotation left behind. The contract never clears
   * the flag, and neither does this fake.
   */
  rootRewardAccounts?: string[];
  /**
   * The ONE cumulative claim watermark shared by every ROOT EOA.
   *
   * `alreadyClaimed` answers with this figure for any ROOT-routed address, exactly as the
   * contract does, rather than with a per-address entry. A fixture models "the outgoing ROOT had
   * already claimed 10" by setting this, and the incoming ROOT then reads the same 10.
   */
  rootClaimed?: bigint;
  /** Makes isRootRewardAccount() throw, for the reservation fail-closed path. */
  rootRewardAccountReadFails?: boolean;
}

export function fakeChain(o: FakeChainOptions = {}) {
  const state = {
    root: o.root ?? `0x${"0".repeat(64)}`,
    cumulativeTotal: o.cumulativeTotal ?? 0n,
    totalClaimed: o.totalClaimed ?? 0n,
    latestEpochId: o.latestEpochId ?? 0,
    finalized: o.finalized ?? new Set<number>(),
    funded: o.funded ?? new Set<number>(),
    claimed: o.claimed ?? new Map<string, bigint>(),
    treasuryWithdrawal: (o.treasuryWithdrawal ?? TEST_WITHDRAWAL).toLowerCase(),
    blockNumber: o.blockNumber ?? 1_000,
    priceE18: o.priceE18 ?? 10n ** 18n,
    percentageE6: o.percentageE6 ?? 250_000n,
    usdtBalance: o.usdtBalance ?? 0n,
    usdtAllowance: o.usdtAllowance ?? 0n,
    executorRoles: o.executorRoles ?? { treasury: true, withdrawal: true },
    rewardAuthorizerRole: o.rewardAuthorizerRole ?? true,
    withdrawalTreasuryBinding: (o.withdrawalTreasuryBinding ?? TEST_TREASURY).toLowerCase(),
    authorizations: o.authorizations
      ?? new Map<number, { root: string; total: bigint; funding: bigint }>(),
    fundedAmounts: new Map<number, bigint>(),
    currentRootEOA: o.currentRootEOA?.toLowerCase() ?? null,
    rootReadFails: o.rootReadFails ?? false,
    rootRewardAccounts: new Set((o.rootRewardAccounts ?? []).map((a) => a.toLowerCase())),
    rootClaimed: o.rootClaimed ?? 0n,
    rootRewardAccountReadFails: o.rootRewardAccountReadFails ?? false,
  };
  return {
    state,
    reader: {
      async liveState() {
        return {
          root: state.root.toLowerCase(),
          cumulativeTotalEntitlementACF: state.cumulativeTotal,
          totalClaimedACF: state.totalClaimed,
          latestEpochId: state.latestEpochId,
        };
      },
      async currentRootEOA() {
        if (state.rootReadFails) throw new Error("RPC unavailable (test)");
        if (state.currentRootEOA) return state.currentRootEOA;
        // Agree with the seeded tree. Read per call rather than captured, so a fixture that
        // seeds its users after building the fake still gets a consistent answer.
        const parentless = await User.collection
          .find({ referredByUserId: null }, { projection: { externalEOA: 1 } })
          .limit(2).toArray();
        return parentless.length === 1
          ? String(parentless[0]!.externalEOA).toLowerCase()
          : TEST_ROOT_EOA.toLowerCase();
      },
      async isRootRewardAccount(address: string) {
        if (state.rootRewardAccountReadFails) throw new Error("RPC unavailable (test)");
        const who = address.toLowerCase();
        if (state.rootRewardAccounts.has(who)) return true;
        // The current ROOT is flagged on chain from initialization onward, so the fake does not
        // make a fixture restate it.
        return who === (await this.currentRootEOA());
      },
      async epochFinalized(id: number) { return state.finalized.has(id); },
      async rewardEpochFunded(id: number) { return state.funded.has(id); },
      async treasuryWithdrawal() { return state.treasuryWithdrawal; },
      async alreadyClaimed(wallets: string[]) {
        // Mirrors the contract: every ROOT EOA, current or historical, reports the ONE shared
        // watermark; everyone else reports their own. A fake that kept ROOT per-address would let
        // a rotation test pass against behaviour the contract does not have.
        const out = new Map<string, bigint>();
        for (const w of wallets) {
          const who = w.toLowerCase();
          out.set(who, (await this.isRootRewardAccount(who))
            ? state.rootClaimed
            : state.claimed.get(who) ?? 0n);
        }
        return out;
      },
      async blockNumber() { return state.blockNumber; },
      // The rest of SettlementChainReader. The modules under test here never call them, but the
      // fixture implements the WHOLE interface so a signature change shows up as a type error
      // instead of silently leaving a stale fixture behind.
      async executorRoles(_address: string) { return state.executorRoles; },
      async rewardAuthorizerRole(_address: string) { return state.rewardAuthorizerRole; },
      async rewardEpochAuthorization(id: number) {
        const auth = state.authorizations.get(id);
        return auth
          ? {
              authorized: true,
              cumulativeMerkleRoot: auth.root.toLowerCase(),
              cumulativeTotalEntitlementACF: auth.total,
              fundingAmountACF: auth.funding,
            }
          : {
              authorized: false,
              cumulativeMerkleRoot: `0x${"0".repeat(64)}`,
              cumulativeTotalEntitlementACF: 0n,
              fundingAmountACF: 0n,
            };
      },
      async rewardEpochFundedAmount(id: number) { return state.fundedAmounts.get(id) ?? 0n; },
      async withdrawalTreasury() { return state.withdrawalTreasuryBinding; },
      async chainId() { return 80002; },
      async claimFeeInputs() {
        return { priceE18: state.priceE18, percentageE6: state.percentageE6 };
      },
      async tokenDecimals() { return { acf: 18, usdt: 6 }; },
      async usdtPosition(_wallet: string) {
        return { balance: state.usdtBalance, allowance: state.usdtAllowance };
      },
    } satisfies SettlementChainReader,
    /**
     * Records the commitment REWARD_AUTHORIZER_ROLE would have accepted.
     *
     * Separate from `settle` because the two are separate authorities on chain: a fixture that
     * only wants to model "the authorizer has committed, the executor has not relayed yet" calls
     * this alone.
     */
    authorize(id: number, root: string, total: bigint, funding: bigint) {
      state.authorizations.set(id, { root: root.toLowerCase(), total, funding });
    },
    /**
     * Applies what a successful operator run would do on chain.
     *
     * Records the commitment too, because on chain neither funding nor finalization is reachable
     * without one — a fake that marked an epoch funded but uncommitted would describe a state the
     * contracts cannot produce.
     */
    settle(id: number, root: string, total: bigint, funding?: bigint) {
      const amount = funding ?? total - state.cumulativeTotal;
      state.authorizations.set(id, { root: root.toLowerCase(), total, funding: amount });
      state.fundedAmounts.set(id, amount);
      state.funded.add(id);
      state.finalized.add(id);
      state.root = root;
      state.cumulativeTotal = total;
      state.latestEpochId = id;
    },
  };
}
