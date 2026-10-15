import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { listSwaps, recordSwap } from "./service.js";

export const swapRouter = Router();

/** Records a swap. The body carries a transaction hash and nothing else. */
swapRouter.post("/swap/record", requireAuth, async (req, res, next) => {
  try {
    res.json(await recordSwap(req.session!.sub, req.body?.txHash));
  } catch (error) {
    next(error);
  }
});

swapRouter.get("/swap/history", requireAuth, async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 25);
    res.json(await listSwaps(req.session!.sub, Number.isFinite(limit) ? limit : 25));
  } catch (error) {
    next(error);
  }
});
