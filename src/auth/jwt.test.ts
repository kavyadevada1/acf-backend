import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.PORT ??= "3001";
process.env.DAO_REVENUE_DISTRIBUTOR_ADDRESS ??= "0xc152dF6448FB68702B661C4aE210E41f5E76931E";
process.env.WITHDRAWAL_ADDRESS ??= "0x882db912586869315C2720dE72224d79B9D99Ea1";
process.env.TREASURY_ADDRESS ??= "0x114fe8e3414bc49A24C6efd9E702cD66B9A80251";
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/acf_user_test";
process.env.JWT_SECRET ??= "test-secret-at-least-thirty-two-characters-long";
process.env.REGISTERED_EOA_DIRECT_RULE_START_EPOCH ??= "1";
process.env.JWT_EXPIRES_IN_SECONDS ??= "86400";
process.env.CHAIN_ID ??= "80002";
process.env.CHALLENGE_TTL_SECONDS ??= "300";
process.env.CORS_ORIGIN ??= "http://localhost:5173";

const { signSession, verifySession } = await import("./jwt.js");
const { HttpError } = await import("../lib/errors.js");

const PAYLOAD = { sub: "usr_abc123", eoa: "0xd0b78357bf0c537ecb5b5ce7814b5a1689ee81a8" };

describe("session jwt", () => {
  it("round-trips the payload", () => {
    const decoded = verifySession(signSession(PAYLOAD));
    assert.equal(decoded.sub, PAYLOAD.sub);
    assert.equal(decoded.eoa, PAYLOAD.eoa);
  });

  it("carries only sub and eoa", () => {
    assert.deepEqual(Object.keys(verifySession(signSession(PAYLOAD))).sort(), ["eoa", "sub"]);
  });

  it("rejects a tampered token", () => {
    const token = signSession(PAYLOAD);
    const tampered = `${token.slice(0, -4)}AAAA`;
    assert.throws(
      () => verifySession(tampered),
      (error: unknown) => error instanceof HttpError && error.status === 401,
    );
  });

  it("rejects garbage", () => {
    for (const bad of ["", "not.a.token", "a.b.c"]) {
      assert.throws(() => verifySession(bad), (error: unknown) => error instanceof HttpError);
    }
  });
});
