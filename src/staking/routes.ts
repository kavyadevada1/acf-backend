import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { listStakes, recordStake } from "./service.js";

export const stakingRouter = Router();

/** Records a direct stake. The body carries a transaction hash and nothing else. */
stakingRouter.post("/staking/sync", requireAuth, async (req, res, next) => {
  try {
    res.json(await recordStake(req.session!.sub, req.body?.txHash));
  } catch (error) {
    next(error);
  }
});

stakingRouter.get("/staking/stakes", requireAuth, async (req, res, next) => {
  try {
    res.json(await listStakes(req.session!.sub));
  } catch (error) {
    next(error);
  }
});
