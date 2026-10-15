import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { listBondPurchases, recordBondPurchase } from "./service.js";

export const bondRouter = Router();

/** Records a bond purchase. The body carries a transaction hash and nothing else. */
bondRouter.post("/bond/sync", requireAuth, async (req, res, next) => {
  try {
    res.json(await recordBondPurchase(req.session!.sub, req.body?.txHash));
  } catch (error) {
    next(error);
  }
});

bondRouter.get("/bond/history", requireAuth, async (req, res, next) => {
  try {
    res.json(await listBondPurchases(req.session!.sub));
  } catch (error) {
    next(error);
  }
});
