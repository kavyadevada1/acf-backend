import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { config } from "./config.js";
import { connectDatabase } from "./db.js";
import { authRouter } from "./auth/routes.js";
import { swapRouter } from "./swap/routes.js";
import { stakingRouter } from "./staking/routes.js";
import { bondRouter } from "./bond/routes.js";
import { daoRouter } from "./dao/routes.js";
import { referralRouter } from "./referral/routes.js";
import { settlementRouter } from "./settlement/routes.js";
import { daoRevenueRouter } from "./daoRevenue/routes.js";
import { rankRouter } from "./rewards/rank/routes.js";
import { ledgerRouter } from "./ledger/routes.js";
import { assertNoStaleIndexes, assertReferralRoot, referralRootStatus } from "./lib/bootstrap.js";
import { assertChainId, assertStakingToken, assertBondDependencies, assertDAODependencies } from "./lib/chain.js";
import { HttpError, toErrorBody } from "./lib/errors.js";
import { logger, requestLogger } from "./lib/logger.js";

export function createApp() {
  const app = express();
  // An explicit allow-list. A request with no Origin (curl, server-to-server, same-origin) is
  // permitted: CORS is a browser protection and rejecting those would break health checks and
  // the operator CLIs without protecting anything.
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      callback(new HttpError(403, "ORIGIN_NOT_ALLOWED", `Origin ${origin} is not allowed.`));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: "16kb" }));
  app.use(requestLogger);
  app.use(authRouter);
  app.use(swapRouter);
  app.use(stakingRouter);
  app.use(bondRouter);
  app.use(daoRouter);
  app.use(referralRouter);
  app.use(settlementRouter);
  app.use(daoRevenueRouter);
  app.use(rankRouter);
  app.use(ledgerRouter);

  // Single error boundary: every route forwards failures here so one envelope is used.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, body } = toErrorBody(error);
    // Only unexpected failures carry a stack worth keeping; handled errors are already
    // described by their code and the request log line.
    if (status >= 500) {
      logger.error("unhandled request failure", {
        code: body.error.code,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
    res.status(status).json(body);
  });

  return app;
}

async function main(): Promise<void> {
  // Connect first: with bufferCommands disabled a dead database must fail startup rather
  // than accepting requests that cannot be served.
  await connectDatabase();
  // Refuse to serve against the wrong network: every on-chain read would describe a different
  // deployment, and the service would record positions against contracts nobody holds.
  await assertChainId();
  await assertStakingToken();
  await assertBondDependencies();
  await assertDAODependencies();
  await assertNoStaleIndexes();
  await assertReferralRoot();
  const rootStatus = await referralRootStatus();
  createApp().listen(config.port, () => {
    logger.info("user-backend listening", {
      referralRoot: rootStatus,
      port: config.port,
      env: config.nodeEnv,
      chainId: config.chainId,
    });
  });
}

main().catch((error) => {
  // Startup failures must be visible even at LOG_LEVEL=error.
  logger.error("startup failed", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exit(1);
});
