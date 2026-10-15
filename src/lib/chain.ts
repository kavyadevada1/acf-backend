import { createPublicClient, http, getAddress, type Chain } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import { config } from "../config.js";
import { stakingReadAbi } from "../abi/stakingEvent.js";
import { bondReadAbi } from "../abi/bondEvent.js";
import { daoReadAbi, daoStateAbi, stakingPoolAbi } from "../abi/daoEvent.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const CHAIN_REGISTRY: Record<number, Chain> = {
  [polygonAmoy.id]: polygonAmoy, // 80002
  [polygon.id]: polygon, //        137
};

const chain = CHAIN_REGISTRY[config.chainId];
if (!chain) {
  throw new Error(
    `CHAIN_ID=${config.chainId} is not supported. Supported: ${Object.keys(CHAIN_REGISTRY).join(", ")}`,
  );
}

export const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });

/**
 * Reads the chain. Injectable so services can be tested without an RPC endpoint — the tests
 * supply a fake reader rather than mocking viem.
 */
export interface SwapLog {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex: number;
}

export interface SwapReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  logs: readonly SwapLog[];
}

export interface SwapReader {
  /** Receipt for a transaction hash, or null when it is unknown to the node. */
  receiptOf(txHash: string): Promise<SwapReceipt | null>;
  /** Current head block, for the confirmation check. */
  headBlock(): Promise<bigint>;
  /** Unix seconds of a block, for the swap timestamp. */
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
}

/** Live ACFDAO state. Split out so existing fakes in Swap/Bond tests keep compiling. */
export interface DAOReader {
  /** Live Silver/Gold thresholds and the one shared member revenue percentage. */
  daoRevenueConfig(): Promise<{
    silverMinimumUSDT: bigint;
    goldMinimumUSDT: bigint;
    memberRevenuePercentage: bigint;
    marketingPercentage: bigint;
  }>;
  daoPoolId(): Promise<bigint>;
  daoLockDuration(): Promise<bigint>;
  daoRevenueEnabled(): Promise<boolean>;
  daoClosed(): Promise<boolean>;
  daoNextContributionId(): Promise<bigint>;
  daoContribution(id: bigint): Promise<{
    beneficiary: string;
    usdtContributed: bigint;
    acfStaked: bigint;
    poolId: bigint;
    stakeId: bigint;
    timestamp: bigint;
  }>;
  /** Current activity of the linked Staking position; maturity alone never makes it false. */
  daoContributionActive(id: bigint): Promise<boolean>;
}

export interface ChainReader extends SwapReader, DAOReader {}

const daoRead = <T>(functionName: string, args: readonly unknown[] = []) =>
  publicClient.readContract({
    address: getAddress(config.acfDaoAddress),
    abi: daoStateAbi,
    functionName: functionName as "daoPoolId",
    args: args as [],
  }) as Promise<T>;

export const chainReader: ChainReader = {
  async daoRevenueConfig() {
    const c = await daoRead<{
      silverMinimumUSDT: bigint; goldMinimumUSDT: bigint;
      memberRevenuePercentage: bigint; marketingPercentage: bigint;
    }>("getRevenueConfig");
    return c;
  },
  daoPoolId: () => daoRead<bigint>("daoPoolId"),
  daoLockDuration: () => daoRead<bigint>("DAO_LOCK_DURATION"),
  daoRevenueEnabled: () => daoRead<boolean>("revenueEnabled"),
  daoClosed: () => daoRead<boolean>("daoClosed"),
  daoNextContributionId: () => daoRead<bigint>("nextContributionId"),

  async daoContribution(id) {
    const c = await daoRead<{
      beneficiary: string; usdtContributed: bigint; acfStaked: bigint;
      poolId: bigint; stakeId: bigint; timestamp: bigint;
    }>("getContribution", [id]);
    return { ...c, beneficiary: c.beneficiary.toLowerCase() };
  },

  daoContributionActive: (id) => daoRead<boolean>("isContributionActive", [id]),

  async receiptOf(txHash) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        logs: receipt.logs.map((log) => ({
          address: log.address.toLowerCase(),
          topics: log.topics,
          data: log.data,
          logIndex: log.logIndex,
        })),
      };
    } catch {
      // An unknown hash is a client error, not an outage; the caller distinguishes them.
      return null;
    }
  },

  async headBlock() {
    return publicClient.getBlockNumber();
  },

  async blockTimestamp(blockNumber) {
    const block = await publicClient.getBlock({ blockNumber });
    return block.timestamp;
  },
};

/**
 * Refuses to start against the wrong staking deployment.
 *
 * A superseded ACFStaking proxy exists on Amoy that reports plausible pool and stake state
 * but is wired to a dead ACF token. Staking against it would pull a worthless token and the
 * failure would be silent, so the live proxy is identified by the token it holds.
 */
export async function assertStakingToken(): Promise<void> {
  const token = await publicClient.readContract({
    address: getAddress(config.acfStakingAddress),
    abi: stakingReadAbi,
    functionName: "acf",
  });
  if (token.toLowerCase() !== config.acfTokenAddress.toLowerCase()) {
    throw new Error(
      `ACF_STAKING_ADDRESS ${config.acfStakingAddress} reports acf()=${token}, but ACF_TOKEN_ADDRESS ` +
        `is ${config.acfTokenAddress}. This is probably the superseded staking proxy. Refusing to start.`,
    );
  }
}

/**
 * Refuses to start if the Bond contract points at anything other than the canonical set.
 *
 * Bond pulls USDT into the Swap, draws ACF from ALS and stakes through Staking; a mismatch
 * in any of those would move real funds through the wrong contract, and the symptom would be
 * subtle rather than a clean failure.
 */
export async function assertBondDependencies(): Promise<void> {
  const address = getAddress(config.acfBondAddress);
  const read = (functionName: "acf" | "usdt" | "staking" | "swap") =>
    publicClient.readContract({ address, abi: bondReadAbi, functionName });

  const [acf, usdt, staking, swap] = await Promise.all([
    read("acf"), read("usdt"), read("staking"), read("swap"),
  ]);

  const expected: [string, string, string][] = [
    ["acf()", acf, config.acfTokenAddress],
    ["usdt()", usdt, config.mockUsdtAddress],
    ["staking()", staking, config.acfStakingAddress],
    ["swap()", swap, config.acfSwapAddress],
  ];

  for (const [name, actual, want] of expected) {
    if (actual.toLowerCase() !== want.toLowerCase()) {
      throw new Error(
        `ACFBond.${name} is ${actual} but the configured address is ${want}. ` +
          "Refusing to start against a mismatched Bond deployment.",
      );
    }
  }
}

export async function assertDAODependencies(): Promise<void> {
  const address = getAddress(config.acfDaoAddress);
  const read = (functionName: "acf" | "usdt" | "als" | "staking" | "swap") =>
    publicClient.readContract({ address, abi: daoReadAbi, functionName });

  const [acf, usdt, als, staking, swap] = await Promise.all([
    read("acf"), read("usdt"), read("als"), read("staking"), read("swap"),
  ]);

  const expected: [string, string, string][] = [
    ["acf()", acf, config.acfTokenAddress],
    ["usdt()", usdt, config.mockUsdtAddress],
    ["staking()", staking, config.acfStakingAddress],
    ["swap()", swap, config.acfSwapAddress],
  ];

  for (const [name, actual, want] of expected) {
    if (actual.toLowerCase() !== want.toLowerCase()) {
      throw new Error(
        `ACFDAO.${name} is ${actual} but the configured address is ${want}. ` +
          "Refusing to start against a mismatched DAO deployment.",
      );
    }
  }

  // ALS has no separate config entry; assert only that the DAO declares one.
  if (!als || als === ZERO_ADDRESS) {
    throw new Error("ACFDAO.als() is unset. Refusing to start against an uninitialised DAO.");
  }

  // The 750-day term is the product promise; prove the pinned pool really carries it.
  const [poolId, lockDuration] = await Promise.all([
    publicClient.readContract({ address, abi: daoStateAbi, functionName: "daoPoolId" }),
    publicClient.readContract({ address, abi: daoStateAbi, functionName: "DAO_LOCK_DURATION" }),
  ]);
  const pool = await publicClient.readContract({
    address: getAddress(config.acfStakingAddress),
    abi: stakingPoolAbi,
    functionName: "getPool",
    args: [poolId],
  });
  if (pool.lockDuration !== lockDuration) {
    throw new Error(
      `ACFDAO.daoPoolId() is ${poolId}, whose lock duration is ${pool.lockDuration}s, but ` +
        `DAO_LOCK_DURATION is ${lockDuration}s. Refusing to start against a mismatched DAO pool.`,
    );
  }
}

export async function assertChainId(): Promise<void> {
  const actual = await publicClient.getChainId();
  if (actual !== config.chainId) {
    throw new Error(
      `RPC_URL points at chain ${actual} but CHAIN_ID is ${config.chainId}. Refusing to start.`,
    );
  }
}
