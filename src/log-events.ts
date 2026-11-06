/**
 * Every event the code may log, with its level fixed here (PLAN-v1.md §11.3).
 * An event with `alert` is meant to raise an alert, matched by its message (the
 * event name); `alert` says on what. How alerts are raised is not decided yet
 * (§11.2). Once they are, renaming or removing an alerting event breaks its
 * alert, so change both together.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';

interface EventSpec {
  level: Level;
  alert?: string;
}

export const EVENTS = {
  // Platform
  'app.unhandled': { level: 'error', alert: 'any' },
  'request.failed': { level: 'warn', alert: 'over 20 in a day' },
  'cache.read_failed': { level: 'error', alert: 'any' },
  'cache.write_failed': { level: 'error', alert: 'any' },
  'cache.written': { level: 'info', alert: 'over 700 in a day (KV allows 1,000 writes a day)' },
  'cache.stale_served': { level: 'info' },

  // Upstream (OpenXBL)
  'upstream.call': { level: 'info' },
  'upstream.budget_low': { level: 'warn', alert: 'any' },
  'upstream.rate_limited': { level: 'warn', alert: 'any' },
  'upstream.auth_failed': { level: 'error', alert: 'any' },
  'upstream.error': { level: 'error', alert: 'over 5 in a day' },
  'upstream.error_body': { level: 'info' },
  'upstream.unreachable': { level: 'error', alert: 'over 5 in a day' },
  'upstream.unexpected_shape': { level: 'error', alert: 'any' },
  'upstream.clips_transient': { level: 'warn', alert: 'over 10 in a day' },

  // Inbound
  'inbound.rate_limited': { level: 'warn', alert: 'over 50 in a day' },
  'inbound.site_guard_would_refuse': { level: 'warn' },
  'player.not_found': { level: 'info', alert: 'over 100 in a day' },
  'request.invalid': { level: 'info' },
} as const satisfies Record<string, EventSpec>;

export type EventName = keyof typeof EVENTS;
