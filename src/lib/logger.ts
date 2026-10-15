import { config, isProduction } from "../config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = SEVERITY[config.logLevel];

/**
 * Minimal structured logger. No dependency, no transport, no rotation — stdout only, which is
 * what a process manager or container runtime expects to collect.
 *
 * Nothing here ever receives a request body, an Authorization header, a signature or a token:
 * call sites pass explicit fields, so a secret cannot be logged by accident.
 */
function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (SEVERITY[level] < threshold) return;

  const time = new Date().toISOString();

  if (isProduction) {
    // One JSON object per line: greppable, and parseable by any log collector.
    process.stdout.write(`${JSON.stringify({ time, level, message, ...fields })}\n`);
    return;
  }

  // Development: readable, with the fields trailing the message.
  const extra = fields && Object.keys(fields).length
    ? " " + Object.entries(fields).map(([k, v]) => `${k}=${format(v)}`).join(" ")
    : "";
  process.stdout.write(`${time} ${level.toUpperCase().padEnd(5)} ${message}${extra}\n`);
}

function format(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};

/**
 * Logs one line per completed request: method, path, status, duration.
 *
 * Deliberately records no body, query string or header. Bodies here carry signatures and the
 * challenge message, and headers carry the bearer token.
 */
export function requestLogger(
  req: { method: string; path: string },
  res: { statusCode: number; on: (event: string, handler: () => void) => void },
  next: () => void,
): void {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level: LogLevel = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    emit(level, `${req.method} ${req.path}`, {
      status: res.statusCode,
      ms: Math.round(ms),
    });
  });

  next();
}
