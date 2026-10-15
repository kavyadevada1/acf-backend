import { randomBytes } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { normalizeEOA } from "../lib/address.js";
import { generateReferralCode } from "../lib/referralCode.js";
import { AuthChallenge } from "../models/AuthChallenge.js";
import { User, type UserDocument } from "../models/User.js";
import { signSession } from "./jwt.js";
import { findRootUser } from "../lib/bootstrap.js";
import { syncLogicalRootEOAFromChain } from "../lib/rootSync.js";
import { settlementChainReader, type SettlementChainReader } from "../settlement/chain.js";

/** Shape returned for a user by every endpoint. `externalEOA` is the whole identity. */
export interface UserResponse {
  userId: string;
  externalEOA: string;
  referralCode: string;
  referredByUserId: string | null;
}

export function toUserResponse(user: UserDocument): UserResponse {
  return {
    userId: user.userId,
    externalEOA: user.externalEOA,
    referralCode: user.referralCode,
    referredByUserId: user.referredByUserId ?? null,
  };
}

function buildMessage(externalEOA: string, nonce: string, issuedAt: Date): string {
  // Chain ID is included so a signature cannot be replayed against another network.
  return [
    "ACF Finance wants you to sign in.",
    "",
    `Address: ${externalEOA}`,
    `Chain ID: ${config.chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    "",
    "Signing this message costs no gas and does not authorise any transaction.",
  ].join("\n");
}

export async function createChallenge(rawEOA: unknown): Promise<{ message: string; expiresAt: string }> {
  const externalEOA = normalizeEOA(rawEOA);
  const nonce = randomBytes(32).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + config.challengeTtlSeconds * 1000);
  const message = buildMessage(externalEOA, nonce, issuedAt);

  // One pending challenge per address: requesting again replaces the previous one.
  await AuthChallenge.findOneAndUpdate(
    { externalEOA },
    { externalEOA, nonce, message, expiresAt },
    { upsert: true },
  );

  return { message, expiresAt: expiresAt.toISOString() };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

const newUserId = () => `usr_${randomBytes(12).toString("hex")}`;

/**
 * Decides the parent for a FIRST registration.
 *
 * Until the logical root exists, the ONLY wallet that may register is the one
 * `ACFWithdrawal.currentRootEOA()` names, and it becomes the root with a null parent. Everyone
 * else is refused for exactly as long as that is true, whether or not they present a referral
 * code — a user created then could only have a null parent, which would fork the tree
 * permanently.
 *
 * The chain is read rather than trusted from configuration, and an unreadable RPC refuses the
 * registration instead of guessing. Creating the referral root against the wrong wallet is
 * unrecoverable; a caller who has to retry has lost nothing.
 *
 * The check happens BEFORE any write, so a rejected caller never leaves a record behind. A
 * referral code supplied alongside the root wallet is ignored rather than honoured: the root
 * cannot have a sponsor.
 */
async function resolveParentForNewUser(
  referralCode: unknown,
  externalEOA: string,
  reader: SettlementChainReader,
): Promise<string | null> {
  const root = await findRootUser();

  if (!root) {
    let chainRootEOA: string;
    try {
      chainRootEOA = normalizeEOA(await reader.currentRootEOA());
    } catch {
      throw new HttpError(
        503,
        "REFERRAL_ROOT_UNAVAILABLE",
        "Registration is not open yet. The platform cannot confirm its root account right now.",
      );
    }
    if (chainRootEOA === externalEOA) return null;   // this IS the root being created
    throw new HttpError(
      503,
      "REFERRAL_ROOT_UNAVAILABLE",
      "Registration is not open yet. The platform is still being set up.",
    );
  }

  // The root returning is handled by the existing-user path long before here, so reaching this
  // point with the root wallet would mean a duplicate; the normal rules apply regardless.
  return resolveReferrer(referralCode, externalEOA);
}

/**
 * Resolves the parent for a FIRST registration only. Never called for an existing user:
 * a returning login must be able to succeed while carrying any referral code, valid or not.
 *
 * Always returns a parent. A registration without a code attaches to the configured ROOT, so
 * ROOT stays the only user in the graph with no parent. It never returns null — a second
 * parentless normal user would be indistinguishable from ROOT and would silently fork the tree.
 */
async function resolveReferrer(referralCode: unknown, externalEOA: string): Promise<string> {
  if (referralCode === undefined || referralCode === null || referralCode === "") {
    const root = await findRootUser();
    if (!root) {
      throw new HttpError(
        503,
        "REFERRAL_ROOT_UNAVAILABLE",
        "Registration is not open yet. The platform is still being set up.",
      );
    }
    return root.userId;
  }
  if (typeof referralCode !== "string") {
    throw new HttpError(400, "UNKNOWN_REFERRAL_CODE", "Referral code is not valid.");
  }

  const referrer = await User.findOne({ referralCode: referralCode.trim() });
  if (!referrer) {
    throw new HttpError(400, "UNKNOWN_REFERRAL_CODE", "Referral code is not valid.");
  }

  // Defensive only: unreachable in this flow, because a code resolving to this EOA would mean
  // the user already exists and the caller would have taken the existing-user path. Kept so
  // any future path (administrative repair, data import) cannot create a self-referral.
  if (referrer.externalEOA === externalEOA) {
    throw new HttpError(400, "SELF_REFERRAL", "A user cannot refer themselves.");
  }

  return referrer.userId;
}

export interface VerifyInput {
  externalEOA: unknown;
  signature: unknown;
  referralCode?: unknown;
}

export interface VerifyResult {
  token: string;
  expiresIn: number;
  isNewUser: boolean;
  user: UserResponse;
}

export async function verifyAndAuthenticate(
  input: VerifyInput,
  reader: SettlementChainReader = settlementChainReader,
): Promise<VerifyResult> {
  const externalEOA = normalizeEOA(input.externalEOA);

  if (typeof input.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(input.signature)) {
    throw new HttpError(401, "SIGNATURE_MISMATCH", "Signature is missing or malformed.");
  }

  const challenge = await AuthChallenge.findOne({ externalEOA });
  if (!challenge) {
    throw new HttpError(410, "NO_CHALLENGE", "No pending challenge for this address.");
  }
  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(410, "CHALLENGE_EXPIRED", "Challenge has expired. Request a new one.");
  }

  // Verify BEFORE consuming, so an invalid signature does not burn a legitimate challenge.
  let recovered: string;
  try {
    recovered = (
      await recoverMessageAddress({
        message: challenge.message,
        signature: input.signature as `0x${string}`,
      })
    ).toLowerCase();
  } catch {
    throw new HttpError(401, "SIGNATURE_MISMATCH", "Signature could not be verified.");
  }
  if (recovered !== externalEOA) {
    throw new HttpError(401, "SIGNATURE_MISMATCH", "Signature does not match the address.");
  }

  // Signature is valid: consume atomically. Matching on the exact nonce means only one of
  // several concurrent valid requests succeeds; the others see null and are rejected.
  const consumed = await AuthChallenge.findOneAndDelete({ externalEOA, nonce: challenge.nonce });
  if (!consumed) {
    throw new HttpError(410, "CHALLENGE_ALREADY_USED", "Challenge has already been used.");
  }

  let existing = await User.findOne({ externalEOA });

  /**
   * A wallet with no account is one of three things, and only the contract can say which.
   *
   * CURRENT ROOT — it has proven control of the address `currentRootEOA()` now names, after a
   * rotation the database has not seen yet. Treating it as a newcomer would create a SECOND user
   * and hang it under the logical root as an ordinary child: a new userId, a new referral code,
   * and a root node still answering to a wallet nobody holds. Instead the existing logical root is
   * rebound to it and it signs in as that same permanent user.
   *
   * HISTORICAL ROOT — it was ROOT once and `isRootRewardAccount` remembers that forever, because
   * a proof issued to it before the rotation must still route through the partner splitter. It is
   * therefore reserved and can never become an ordinary account: the backend would treat its
   * rewards as its own while the contract paid every one of them out to the ROOT partners.
   *
   * NEWCOMER — anything else, registered normally.
   *
   * Only the chain decides. No request field, header or referral code influences which branch is
   * taken, and the ordinary path costs ONE eth_call: `isRootRewardAccount` is false for almost
   * everybody, and `currentRootEOA()` is only consulted once it is not.
   *
   * Both reads FAIL CLOSED. An unreadable RPC cannot be allowed to read as "not a ROOT", because
   * a historical ROOT that slips through registers an ordinary account that can never be undone,
   * whereas a newcomer who has to retry has lost nothing — the same trade the bootstrap gate makes.
   */
  if (!existing) {
    let rootRouted: boolean;
    try {
      rootRouted = await reader.isRootRewardAccount(externalEOA);
    } catch {
      throw new HttpError(
        503,
        "REFERRAL_ROOT_UNAVAILABLE",
        "Registration cannot be completed right now. The platform could not verify this " +
          "address against its contracts. Please try again shortly.",
      );
    }

    if (rootRouted) {
      let chainRootEOA: string;
      try {
        chainRootEOA = normalizeEOA(await reader.currentRootEOA());
      } catch {
        throw new HttpError(
          503,
          "REFERRAL_ROOT_UNAVAILABLE",
          "Registration cannot be completed right now. The platform could not verify this " +
            "address against its contracts. Please try again shortly.",
        );
      }

      if (chainRootEOA === externalEOA) {
        // The current ROOT. Before the logical root exists this is the bootstrap wallet, and the
        // sync reports AWAITING_BOOTSTRAP and writes nothing — registration proceeds below and
        // creates the root. Afterwards it is a rotation, and the existing root is rebound.
        const synced = await syncLogicalRootEOAFromChain(reader);
        if (synced.root && synced.root.externalEOA === externalEOA) {
          existing = await User.findOne({ userId: synced.root.userId });
        }
      } else {
        // ROOT-routed but not the current ROOT: a historical ROOT, reserved permanently.
        throw new HttpError(
          409,
          "HISTORICAL_ROOT_EOA_RESERVED",
          "This wallet was previously the platform's root account and is permanently reserved. " +
            "It cannot be used to create a normal account. Please sign in with a different wallet.",
        );
      }
    }
  }

  // EXISTING USER: any referralCode received is ignored outright — never resolved, never
  // validated, never written. An established referrer is permanent, and arriving through
  // someone else's link must not prevent logging in.
  if (existing) {
    return {
      token: signSession({ sub: existing.userId, eoa: existing.externalEOA }),
      expiresIn: config.jwtExpiresInSeconds,
      isNewUser: false,
      user: toUserResponse(existing),
    };
  }

  // FIRST REGISTRATION: this is the only point at which a referral code is honoured.
  const referredByUserId = await resolveParentForNewUser(input.referralCode, externalEOA, reader);

  let created: UserDocument | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    try {
      created = await User.findOneAndUpdate(
        { externalEOA },
        {
          // $setOnInsert ONLY. A concurrent request that created the user first leaves these
          // untouched, which is what makes referredByUserId permanent.
          $setOnInsert: {
            userId: newUserId(),
            externalEOA,
            referralCode: generateReferralCode(),
            referredByUserId,
            // The ROOT is the only parentless user, so this is the one registration that can
            // ever carry the grant. Written at creation rather than looked up per epoch from
            // config, so the grant is a fact on the document an operator can see and change —
            // and so a later config edit cannot silently reprice settled epochs.
            ...(referredByUserId === null && config.rootRankFloor > 0
              ? { rankFloor: config.rootRankFloor }
              : {}),
          },
        },
        { upsert: true, new: true },
      );
    } catch (error) {
      // A referralCode collision is the only expected duplicate here; retry with a new code.
      if (isDuplicateKeyError(error) && attempt < 2) continue;
      throw error;
    }
  }

  if (!created) {
    throw new HttpError(500, "INTERNAL_ERROR", "Could not create user.");
  }

  return {
    token: signSession({ sub: created.userId, eoa: created.externalEOA }),
    expiresIn: config.jwtExpiresInSeconds,
    isNewUser: true,
    user: toUserResponse(created),
  };
}

export async function getUserById(userId: string): Promise<UserResponse> {
  const user = await User.findOne({ userId });
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "User no longer exists.");
  return toUserResponse(user);
}
