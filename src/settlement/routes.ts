import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { HttpError } from "../lib/errors.js";
import { buildClaimProof } from "./proof.js";
import { recordClaimReceipt } from "./receipt.js";
import { getRewardSummary } from "./summary.js";
import { getClaimQuote } from "./quote.js";
import { getTeamRewards } from "../rewards/team/readModel.js";

export const settlementRouter = Router();

/**
 * Earned versus published, for the authenticated user.
 *
 * A user with nothing published yet still sees their earned Level Income in full: the reward is
 * deferred until a checkpoint publishes it, never forfeited.
 */
settlementRouter.get("/rewards/summary", requireAuth, async (req, res, next) => {
  try {
    res.json(await getRewardSummary(req.session!.sub));
  } catch (error) {
    next(error);
  }
});

/**
 * Everything needed before the approve/claim flow: available amount, live fee band, estimated
 * USDT fee, and the wallet's USDT balance and allowance.
 *
 * The fee is explicitly an estimate — `claim()` re-reads the Swap price and fee band at
 * execution — so the UI can say so rather than promising a fixed figure.
 */
settlementRouter.get("/rewards/claim-quote", requireAuth, async (req, res, next) => {
  try {
    res.json(await getClaimQuote(req.session!.sub));
  } catch (error) {
    next(error);
  }
});

/**
 * The EARNED Team breakdown — Level, Rank, Global — with the audit figures Phase 2 actually
 * used for the latest epoch.
 *
 * Published and claimable Team state belongs to /rewards/summary; this answers how the earned
 * amount was worked out. It reports earned reward even before anything is published, because
 * Level Income is deferred rather than forfeited.
 */
settlementRouter.get("/rewards/team", requireAuth, async (req, res, next) => {
  try {
    res.json(await getTeamRewards(req.session!.sub));
  } catch (error) {
    next(error);
  }
});

/**
 * A proof against the CURRENT finalized root.
 *
 * Generated on demand and never stored: the contract holds one root, so the next finalization
 * invalidates every earlier proof. The live root is returned too, so a client can confirm the
 * proof is current before spending gas.
 */
settlementRouter.get("/rewards/claim-proof", requireAuth, async (req, res, next) => {
  try {
    res.json(await buildClaimProof(req.session!.sub));
  } catch (error) {
    next(error);
  }
});

/**
 * Reports a confirmed claim for audit enrichment.
 *
 * Optional by design: the claim watermark that drives compounding is read from
 * Withdrawal.alreadyClaimed, so a user who claims directly and never calls this loses only
 * metadata, not correctness.
 */
settlementRouter.post("/rewards/claim-receipt", requireAuth, async (req, res, next) => {
  try {
    const txHash = (req.body as { txHash?: unknown })?.txHash;
    if (typeof txHash !== "string") {
      throw new HttpError(400, "TX_HASH_REQUIRED", "Provide the claim transaction hash.");
    }
    // The user identity comes from the session, never from the request body.
    res.json(await recordClaimReceipt(req.session!.sub, txHash));
  } catch (error) {
    next(error);
  }
});
