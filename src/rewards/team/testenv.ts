/**
 * Shared environment bootstrap for the Team Reward test suites.
 *
 * config.ts reads process.env once at import time, so every value must be set before any
 * module that imports it is loaded. Kept in one place so the two suites cannot drift.
 */
const STAKING = "0x9eDbbf53f784450CC8Fd50730984Cb7D8DDF743d";

export const TEST_ROOT_EOA = "0x9999999999999999999999999999999999999999";
export const TEST_STAKING = STAKING;

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
process.env.ACF_STAKING_ADDRESS ??= STAKING;
process.env.WITHDRAWAL_ADDRESS ??= "0x882db912586869315C2720dE72224d79B9D99Ea1";
process.env.TREASURY_ADDRESS ??= "0x114fe8e3414bc49A24C6efd9E702cD66B9A80251";
process.env.ACF_TOKEN_ADDRESS ??= "0x7AEB95CaE1e5442Fe1170555ae81280B763D3BF1";
process.env.ACF_BOND_ADDRESS ??= "0x3a97D05a088aDBB79936914F245c2E0bf7F511f2";
process.env.ACF_DAO_ADDRESS ??= "0x9cf32271E052Cbbc1D6C564B6fE6a86B6ED08E45";
process.env.MOCK_USDT_ADDRESS ??= "0x21ff9e803fc496e4db1c1a6c354690636b9fc330";
process.env.SWAP_CONFIRMATIONS ??= "1";
process.env.REWARD_ENGINE_ACTIVATION_EPOCH ??= "41000";

export function assertDisposable(uri: string): string {
  const name = new URL(uri).pathname.replace(/^\//, "");
  if (!name || !/test/i.test(name)) {
    throw new Error(`MONGODB_TEST_URI must name a test database (got "${name}").`);
  }
  return uri;
}
