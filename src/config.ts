/**
 * Environment validation. Every value this milestone needs is read and checked once, at
 * import time, so a missing variable is a startup failure naming the variable rather than
 * an undefined surfacing later inside a request.
 */

// Node 22 loads .env natively; no dotenv dependency. A missing file is fine when the
// environment is supplied by the platform.
try {
  process.loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function requiredInt(name: string): number {
  const raw = required(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function requiredAddress(name: string): string {
  const raw = required(name);
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return raw;

  const body = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : null;
  if (body === null) {
    throw new Error(`Environment variable ${name} must start with 0x, got "${raw}"`);
  }
  if (!/^[0-9a-fA-F]*$/.test(body)) {
    const bad = [...body].find((c) => !/[0-9a-fA-F]/.test(c));
    throw new Error(
      `Environment variable ${name} contains a non-hexadecimal character ("${bad}"), got "${raw}"`,
    );
  }
  throw new Error(
    `Environment variable ${name} has ${body.length} hex characters; an address has exactly 40. ` +
      `That is ${Math.abs(body.length - 40)} too ${body.length > 40 ? "many" : "few"}. Got "${raw}"`,
  );
}

const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters.");
}

export const config = {
  nodeEnv: process.env.NODE_ENV?.trim() || "development",
  port: requiredInt("PORT"),
  mongodbUri: required("MONGODB_URI"),
  jwtSecret,
  jwtExpiresInSeconds: requiredInt("JWT_EXPIRES_IN_SECONDS"),
  chainId: requiredInt("CHAIN_ID"),
  rpcUrl: required("RPC_URL"),
  // Never hardcoded: superseded deployments exist on Amoy, and recording a position against
  // one of those would attribute it to a contract nobody is trading on.
  acfSwapAddress: requiredAddress("ACF_SWAP_ADDRESS"),
  acfStakingAddress: requiredAddress("ACF_STAKING_ADDRESS"),
  // Canonical ACF token. Used at startup to prove the staking proxy is the live one: a stale
  // Amoy deployment exists whose state looks healthy but which points at a dead token.
  acfTokenAddress: requiredAddress("ACF_TOKEN_ADDRESS"),
  acfBondAddress: requiredAddress("ACF_BOND_ADDRESS"),
  acfDaoAddress: requiredAddress("ACF_DAO_ADDRESS"),

  /**
   * The first epoch the reward engine may settle, as an epochId (snapshotAt / 43200).
   *
   * Deliberately explicit: without it a first run would backfill every twelve-hour window since
   * the contracts were deployed, inventing months of liability nobody agreed to. Epochs before
   * this produce no reward, ever.
   *
   * Find today's with:  node -e "console.log(Math.floor(Date.now()/1000/43200))"
   */
  rewardActivationEpoch: requiredInt("REWARD_ENGINE_ACTIVATION_EPOCH"),

  /**
   * Cron expression for the calculation worker, UTC.
   *
   * Overridable so a short interval can be used to prove the schedule fires without editing
   * code. The epochs themselves are still 12-hour and are keyed by time, so running more often
   * only re-checks for work — it cannot create extra epochs or double-pay anything.
   */
  rewardWorkerCron: process.env.REWARD_WORKER_CRON ?? "5 0,12 * * *",

  /** Bounded page sizes. Conservative by default; financial correctness over throughput. */
  rewardStakePageSize: optionalInt("REWARD_STAKE_PAGE_SIZE", 200),
  rewardMulticallBatchSize: optionalInt("REWARD_MULTICALL_BATCH", 100),

  /**
   * Ceiling on the as-of referral graph a Team Reward epoch will load.
   *
   * Exceeding it FAILS the epoch; it never truncates. Rank is computed from the entire
   * downline, so a partial graph would silently understate someone's team and nothing
   * downstream could detect it.
   */
  phase2MaxGraphNodes: optionalInt("REWARD_PHASE2_MAX_GRAPH_NODES", 100_000),

  /**
   * First reward epoch settled under the registered-EOA direct rule.
   *
   * REQUIRED, with no fallback. The clean protocol is not deployed yet, so the first epoch under
   * this rule is not yet knowable, and a default would be a guess that silently decides Level
   * unlock depth and Rank direct requirements. An absent or non-integer value fails at boot
   * rather than letting reward processing invent a cutover from the current clock.
   */
  registeredEoaDirectRuleStartEpoch: requiredInt("REGISTERED_EOA_DIRECT_RULE_START_EPOCH"),

  /**
   * A granted MINIMUM rank for the logical referral ROOT, applied when the ROOT registers.
   *
   * 0 disables it, which is the default: no user is ever granted a rank they did not earn
   * unless this is set deliberately. The value is written once onto the ROOT's own user
   * document; the epoch pass reads it from there, never from this config, so a later change
   * here cannot retroactively alter a settled epoch.
   */
  rootRankFloor: optionalInt("ROOT_RANK_FLOOR", 0),

  /**
   * How long a worker may own a PROCESSING Team Reward epoch before another may reclaim it.
   * Configurable because a whole-population pass is slower than Phase 1's per-stake loop.
   */
  phase2LeaseMs: optionalInt("REWARD_PHASE2_LEASE_MS", 30 * 60 * 1000),

  /**
   * Settlement (Phase 3) contracts. Only the settlement executor signs for these; the API
   * and the calculation worker reach them read-only.
   *
   * The Withdrawal address is part of every settlement record's identity, because the
   * cumulative root and the alreadyClaimed ledger live in that contract — a different
   * deployment is a different entitlement history.
   */
  withdrawalAddress: requiredAddress("WITHDRAWAL_ADDRESS"),
  treasuryAddress: requiredAddress("TREASURY_ADDRESS"),

  /** How long a worker may own a CALCULATING settlement checkpoint. */
  settlementLeaseMs: optionalInt("SETTLEMENT_LEASE_MS", 15 * 60 * 1000),
  /** Finalized Merkle trees held in memory for proof generation. */
  settlementProofCacheSize: optionalInt("SETTLEMENT_PROOF_CACHE_SIZE", 4),

  /**
   * DAO Member Revenue (Phase 4). The distributor's address is part of every DAO revenue
   * record's identity: `paid[epochId][user]` and the funded/distributed accounting live in that
   * contract, so a different deployment is a different payment history.
   *
   * The CALCULATION path is read-only, like every other worker path. Only the separate executor
   * process signs, and it reads its signer configuration itself rather than from here — so
   * importing `config` can never pull a signing key into the public API.
   */
  daoRevenueDistributorAddress: requiredAddress("DAO_REVENUE_DISTRIBUTOR_ADDRESS"),
  /**
   * Members per distributeBatch. Checked against the distributor's own MAX_BATCH_SIZE before
   * execution; a larger value would revert InvalidBatch after costing gas.
   */
  daoRevenueBatchSize: optionalInt("DAO_REVENUE_BATCH_SIZE", 50),
  /** How long a worker may own a CALCULATING DAO revenue epoch. */
  daoRevenueLeaseMs: optionalInt("DAO_REVENUE_LEASE_MS", 15 * 60 * 1000),
  /** How long the executor may own an epoch it is funding or distributing. */
  daoRevenueExecutorLeaseMs: optionalInt("DAO_REVENUE_EXECUTOR_LEASE_MS", 20 * 60 * 1000),
  /** Executor pause between sweeps for executable epochs. */
  daoRevenueExecutorPollMs: optionalInt("DAO_REVENUE_EXECUTOR_POLL_MS", 60 * 1000),
  /**
   * Blocks per eth_getLogs request when backfilling DAO config history. Amoy's free tier caps
   * this at 10, and exceeding it fails the whole range rather than degrading.
   */
  daoConfigLogChunkBlocks: optionalInt("DAO_CONFIG_LOG_CHUNK_BLOCKS", 10),
  // Needed to verify ACFBond.usdt(); the Bond pulls this token from the user's wallet.
  mockUsdtAddress: requiredAddress("MOCK_USDT_ADDRESS"),
  /**
   * Confirmations required before a swap is recorded, where a mined transaction counts as 1.
   *
   * Defaults to 1 — the receipt itself is proof of inclusion — because the client records
   * immediately after the receipt arrives. A reorg here costs only a row that can be
   * re-recorded from the same hash, or reconciled later by the indexer; it cannot cost funds.
   * Raising this makes the client retry rather than lose the record.
   */
  swapConfirmations: (() => {
    const raw = process.env.SWAP_CONFIRMATIONS?.trim();
    if (!raw) return 1;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`SWAP_CONFIRMATIONS must be an integer >= 1, got "${raw}"`);
    }
    return value;
  })(),
  challengeTtlSeconds: requiredInt("CHALLENGE_TTL_SECONDS"),
  /**
   * Allowed browser origins, as a comma-separated list.
   *
   * An ORIGIN is scheme + host + port and NEVER has a path or a trailing slash: the browser
   * sends `http://localhost:5173`, so a configured `http://localhost:5173/` fails to match and
   * every request is blocked with a CORS error that looks like a server fault. The trailing
   * slash is stripped here rather than trusted, because it is the single most common way this
   * variable is mistyped and the symptom points nowhere near the cause.
   *
   * Each entry is validated as a real origin at boot, so a malformed value fails loudly at
   * startup instead of silently refusing one deployment's frontend in production.
   *
   *   CORS_ORIGIN=http://localhost:5173
   *   CORS_ORIGIN=https://app.example.com,https://staging.example.com
   */
  corsOrigins: ((): string[] => {
    const raw = required("CORS_ORIGIN");
    const origins = raw.split(",").map(entry => entry.trim().replace(/\/+$/, "")).filter(Boolean);
    if (origins.length === 0) {
      throw new Error("CORS_ORIGIN is empty. Set at least one origin, e.g. http://localhost:5173");
    }
    for (const origin of origins) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error(`CORS_ORIGIN entry "${origin}" is not a valid origin. Expected scheme://host[:port], e.g. https://app.example.com`);
      }
      if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error(`CORS_ORIGIN entry "${origin}" must be scheme://host[:port] with no path, query or fragment.`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`CORS_ORIGIN entry "${origin}" must use http or https.`);
      }
    }
    return origins;
  })(),
  // Optional: defaults to "info". "debug" is noisy; "warn" hides successful requests.
  logLevel: ((): "debug" | "info" | "warn" | "error" => {
    const raw = process.env.LOG_LEVEL?.trim().toLowerCase() || "info";
    if (raw !== "debug" && raw !== "info" && raw !== "warn" && raw !== "error") {
      throw new Error(`LOG_LEVEL must be debug|info|warn|error, got "${raw}"`);
    }
    return raw;
  })(),
} as const;

export const isProduction = config.nodeEnv === "production";
