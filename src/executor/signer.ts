import { createWalletClient, http, type Chain, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";

/**
 * The ONLY module in this repository that can construct a signer.
 *
 * It is deliberately not reachable from `config.ts`, `src/index.ts`, the public API or the
 * reward worker: nothing in those import paths touches this file, so no key material can be
 * pulled into a process that should not have it. The executor entry points import it explicitly.
 *
 * It reads its own environment rather than going through `config`, for the same reason — adding
 * a signer field to the shared config object would make every importer a potential key holder.
 *
 * ONE RELAY KEY, BOTH PHASES — AND A SEPARATE AUTHORIZING KEY
 * -----------------------------------------------------------
 * The executor account signs Phase 3 settlement and Phase 4 DAO revenue, because the contracts
 * gate all four calls behind the same on-chain role:
 *
 *   Treasury.fundRewardEpoch        Withdrawal.finalizeEpoch          (Phase 3)
 *   Treasury.fundDAORevenueEpoch    Distributor.distributeBatch       (Phase 4)
 *
 * so the variable is named after that role rather than after either phase.
 *
 * It can only RELAY, in both phases. What each epoch may pay is committed on chain by a SECOND,
 * independent key, holding a different role in each phase:
 *
 *   Phase 4   DAO_REVENUE_AUTHORIZER_ROLE on ACFDAORevenueDistributor — the member Merkle root,
 *             the member total, the marketing recipient and its amount.
 *   Phase 3   REWARD_AUTHORIZER_ROLE on ACFWithdrawal — the cumulative Merkle root, the
 *             cumulative total entitlement and the exact Treasury funding amount.
 *
 * ONE KEY, BOTH AUTHORIZER ROLES. DAO_REVENUE_AUTHORIZER_PRIVATE_KEY holds both, deliberately:
 * they are two distinct on-chain roles asking the same question of the same kind of key — "is
 * this payable set the one the backend actually calculated?" — and that key is already custodied
 * apart from the executor. A third signing identity for the same duty would be one more key to
 * fund, rotate and lose, with no authority it does not already have. The variable keeps its name
 * so no deployment has to be re-keyed, and `loadRewardAuthorizerSigner` reads the same value.
 *
 * Either authorizer must be a different account from the executor. If one key held both halves, a
 * compromise of it could redirect every unit of the 5% member pool and the 2% marketing
 * allocation — and, worse, publish a Phase 3 Merkle root paying itself the funded Treasury amount
 * and then fund and finalize it. That is audit finding C-01, and the separation is what removes it.
 *
 * The two keys should not share custody either. Co-locating them in one secret store, one host
 * or one KMS principal recreates the single point of failure that the on-chain split closed.
 *
 * PRODUCTION KEY CUSTODY
 * ----------------------
 * A raw private key in an environment variable is the WEAKEST acceptable option and is intended
 * for local development only. In production, prefer in order:
 *
 *   1. A cloud KMS/HSM signer, so the key never exists in process memory.
 *   2. A secret manager injecting the key at boot, never written to disk.
 *   3. An encrypted keystore whose password comes from a secret manager.
 *
 * Whichever is used, the executor account should hold EPOCH_EXECUTOR_ROLE and nothing else. The
 * key is never logged, never persisted, and never returned through any API.
 */

export interface EpochExecutorSigner {
  address: string;
  /** Submits a prepared call and returns its hash. Narrow on purpose — see executor.ts. */
  client: WalletClient;
  chain: Chain;
}

const CHAIN_REGISTRY: Record<number, Chain> = {
  [polygonAmoy.id]: polygonAmoy,
  [polygon.id]: polygon,
};

export class SignerUnavailableError extends Error {
  readonly code = "SIGNER_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "SignerUnavailableError";
  }
}

/**
 * Builds the executor signer from the environment.
 *
 * Throws rather than falling back to any other key: an executor that silently signed with the
 * admin key would defeat the entire separation this module exists to enforce.
 */
export function loadEpochExecutorSigner(): EpochExecutorSigner {
  // Named executor-only so it can never be confused with the deployer/admin key, and
  // deliberately absent from .env.example so no value is ever committed. The older
  // DAO-specific name is still accepted so an existing deployment keeps working.
  const raw = process.env.EPOCH_EXECUTOR_PRIVATE_KEY
    ?? process.env.DAO_REVENUE_EXECUTOR_PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;
  const chainId = Number(process.env.CHAIN_ID);

  if (!raw) {
    throw new SignerUnavailableError(
      "EPOCH_EXECUTOR_PRIVATE_KEY is not set. The executor processes are the only ones that " +
        "sign; they will not fall back to the admin or any other key.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new SignerUnavailableError(
      "EPOCH_EXECUTOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key.",
    );
  }
  if (!rpcUrl) throw new SignerUnavailableError("RPC_URL is not set.");

  const chain = CHAIN_REGISTRY[chainId];
  if (!chain) {
    throw new SignerUnavailableError(`CHAIN_ID=${chainId} is not a supported network.`);
  }

  const account = privateKeyToAccount(raw as `0x${string}`);
  return {
    address: account.address.toLowerCase(),
    client: createWalletClient({ account, chain, transport: http(rpcUrl) }),
    chain,
  };
}

/** True when a signer could be built, without building one. Used by dry-run reporting. */
export function signerConfigured(): boolean {
  return Boolean(
    process.env.EPOCH_EXECUTOR_PRIVATE_KEY ?? process.env.DAO_REVENUE_EXECUTOR_PRIVATE_KEY,
  );
}

/**
 * Builds the DAO revenue AUTHORIZER signer, which decides what an epoch may pay.
 *
 * Deliberately a separate function and a separate variable from the executor's, so a process can
 * hold one without holding the other: the authorize step and the execute step are meant to run as
 * different jobs, with different key access.
 *
 * Refuses outright when the two keys are the same account. The distributor's initializer refuses
 * the collapsed role configuration on chain, but an operator could still point both backend
 * variables at one key and authorize-then-relay from a single compromised process — which would
 * give that process exactly the authority the split exists to remove.
 */
export function loadDAORevenueAuthorizerSigner(): EpochExecutorSigner {
  const raw = process.env.DAO_REVENUE_AUTHORIZER_PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;
  const chainId = Number(process.env.CHAIN_ID);

  if (!raw) {
    throw new SignerUnavailableError(
      "DAO_REVENUE_AUTHORIZER_PRIVATE_KEY is not set. Authorizing a DAO revenue epoch requires " +
        "its own key; it will not fall back to the executor, the admin or any other.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new SignerUnavailableError(
      "DAO_REVENUE_AUTHORIZER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key.",
    );
  }
  if (!rpcUrl) throw new SignerUnavailableError("RPC_URL is not set.");

  const chain = CHAIN_REGISTRY[chainId];
  if (!chain) {
    throw new SignerUnavailableError(`CHAIN_ID=${chainId} is not a supported network.`);
  }

  const account = privateKeyToAccount(raw as `0x${string}`);
  const executorKey = process.env.EPOCH_EXECUTOR_PRIVATE_KEY
    ?? process.env.DAO_REVENUE_EXECUTOR_PRIVATE_KEY;
  if (executorKey && privateKeyToAccount(executorKey as `0x${string}`).address === account.address) {
    throw new SignerUnavailableError(
      "DAO_REVENUE_AUTHORIZER_PRIVATE_KEY and EPOCH_EXECUTOR_PRIVATE_KEY are the same account. " +
        "One key would then both decide what DAO revenue is payable and relay it, so its " +
        "compromise could redirect the member pool and the marketing allocation. Use two keys.",
    );
  }

  return {
    address: account.address.toLowerCase(),
    client: createWalletClient({ account, chain, transport: http(rpcUrl) }),
    chain,
  };
}

/** True when an authorizer signer could be built, without building one. */
export function authorizerConfigured(): boolean {
  return Boolean(process.env.DAO_REVENUE_AUTHORIZER_PRIVATE_KEY);
}

/**
 * Builds the PHASE 3 settlement authorizer, which decides what a settlement epoch may publish and
 * what it may cost.
 *
 * Reuses DAO_REVENUE_AUTHORIZER_PRIVATE_KEY — see the note at the top of this file. A separate
 * function rather than an alias, so the two duties stay visible at every call site and so
 * separating them later means changing this function and nothing else: set
 * REWARD_AUTHORIZER_PRIVATE_KEY and it is preferred over the shared value.
 *
 * Refuses outright when the key is the executor's account. ACFWithdrawal refuses the collapsed
 * role configuration on chain, but an operator could still point both backend variables at one
 * key and authorize-then-relay from a single compromised process — which is exactly the authority
 * C-01's fix removes.
 */
export function loadRewardAuthorizerSigner(): EpochExecutorSigner {
  const raw = process.env.REWARD_AUTHORIZER_PRIVATE_KEY
    ?? process.env.DAO_REVENUE_AUTHORIZER_PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;
  const chainId = Number(process.env.CHAIN_ID);

  if (!raw) {
    throw new SignerUnavailableError(
      "Neither REWARD_AUTHORIZER_PRIVATE_KEY nor DAO_REVENUE_AUTHORIZER_PRIVATE_KEY is set. " +
        "Authorizing a settlement epoch requires the independent authorizer key; it will not " +
        "fall back to the executor, the admin or any other.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new SignerUnavailableError(
      "The reward authorizer key must be a 0x-prefixed 32-byte hex key.",
    );
  }
  if (!rpcUrl) throw new SignerUnavailableError("RPC_URL is not set.");

  const chain = CHAIN_REGISTRY[chainId];
  if (!chain) {
    throw new SignerUnavailableError(`CHAIN_ID=${chainId} is not a supported network.`);
  }

  const account = privateKeyToAccount(raw as `0x${string}`);
  const executorKey = process.env.EPOCH_EXECUTOR_PRIVATE_KEY
    ?? process.env.DAO_REVENUE_EXECUTOR_PRIVATE_KEY;
  if (executorKey && privateKeyToAccount(executorKey as `0x${string}`).address === account.address) {
    throw new SignerUnavailableError(
      "The reward authorizer key and EPOCH_EXECUTOR_PRIVATE_KEY are the same account. One key " +
        "would then both decide what a settlement epoch publishes and costs AND relay it, so its " +
        "compromise could finalize a Merkle root paying itself the funded amount. Use two keys.",
    );
  }

  return {
    address: account.address.toLowerCase(),
    client: createWalletClient({ account, chain, transport: http(rpcUrl) }),
    chain,
  };
}

/** True when a reward authorizer signer could be built, without building one. */
export function rewardAuthorizerConfigured(): boolean {
  return Boolean(
    process.env.REWARD_AUTHORIZER_PRIVATE_KEY ?? process.env.DAO_REVENUE_AUTHORIZER_PRIVATE_KEY,
  );
}
