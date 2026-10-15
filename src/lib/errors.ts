/** Error carrying the HTTP status and the machine-readable code the API contract specifies. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** The single response envelope every failure uses. */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }
  // Anything unexpected is reported generically: internal details must not reach a client.
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "Unexpected server error." } } };
}
