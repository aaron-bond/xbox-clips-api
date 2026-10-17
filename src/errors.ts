import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** The public error codes (PLAN-v1.md §6). Every failure response carries exactly one. */
export type ErrorCode =
  | 'INVALID_IDENTIFIER'
  | 'NOT_FOUND'
  | 'PLAYER_NOT_FOUND'
  | 'CLIP_NOT_FOUND'
  | 'CLIP_EXPIRED'
  | 'GAME_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UPSTREAM_RATE_LIMIT'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL_ERROR';

const DEFINITIONS: Record<ErrorCode, { status: ContentfulStatusCode; message: string }> = {
  INVALID_IDENTIFIER: { status: 400, message: 'The gamertag, XUID or clip id is not valid.' },
  NOT_FOUND: { status: 404, message: 'No such route.' },
  PLAYER_NOT_FOUND: { status: 404, message: 'No player with that gamertag or XUID was found.' },
  CLIP_NOT_FOUND: { status: 404, message: 'That clip was not found for this player.' },
  CLIP_EXPIRED: { status: 410, message: 'This clip has expired on Xbox and is no longer available.' },
  GAME_NOT_FOUND: { status: 404, message: "That game isn't in the current most-played list." },
  RATE_LIMITED: { status: 429, message: 'Too many requests. Please slow down.' },
  UPSTREAM_RATE_LIMIT: { status: 429, message: 'Xbox data is temporarily rate-limited. Please try again shortly.' },
  UPSTREAM_ERROR: { status: 502, message: 'Xbox data is temporarily unavailable.' },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong.' },
};

/**
 * An error with a public code. Its message is always the fixed text for that
 * code: upstream error text is logged where it occurs and never carried here
 * (PLAN-v1.md §3).
 */
export class AppError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(
    readonly code: ErrorCode,
    /** Passed through to the client as `Retry-After` on rate-limit errors. */
    readonly retryAfter?: string,
  ) {
    super(DEFINITIONS[code].message);
    this.name = 'AppError';
    this.status = DEFINITIONS[code].status;
  }

  toBody() {
    return { error: { code: this.code, message: this.message, status: this.status } };
  }
}

/** Errors that mean "upstream is struggling", for which stale cached data may be served. */
export function isUpstreamPressure(err: unknown): boolean {
  return err instanceof AppError && (err.code === 'UPSTREAM_RATE_LIMIT' || err.code === 'UPSTREAM_ERROR');
}
