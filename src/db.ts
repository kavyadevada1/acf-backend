import mongoose from "mongoose";
import { config, isProduction } from "./config.js";
import { User } from "./models/User.js";
import { AuthChallenge } from "./models/AuthChallenge.js";
import { Swap } from "./models/Swap.js";
import { Stake } from "./models/Stake.js";
import { BondPurchase } from "./models/BondPurchase.js";

/**
 * Connects to MongoDB and, outside production, waits for this milestone's declared indexes.
 *
 * `syncIndexes()` is deliberately NOT used: it DROPS indexes absent from the schema, which
 * makes it a destructive migration mechanism. `Model.init()` only waits for the declared
 * indexes to be built and never removes anything.
 *
 * In production `autoIndex` is false and no index call is made at all — index management
 * there is an explicit operational decision, out of scope for this milestone.
 */
export async function connectDatabase(): Promise<void> {
  mongoose.set("strictQuery", true); // an unknown filter field must not silently match everything

  await mongoose.connect(config.mongodbUri, {
    autoIndex: !isProduction,
    // Surface a dead database as a startup failure instead of buffering requests forever.
    bufferCommands: false,
    serverSelectionTimeoutMS: 10_000,
  });

  if (!isProduction) {
    await Promise.all([User.init(), AuthChallenge.init(), Swap.init(), Stake.init(), BondPurchase.init()]);
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
