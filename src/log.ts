import { EVENTS, type EventName, type Level } from './log-events';

/**
 * Structured logging (PLAN-v1.md §11.3). One record is one object, handed to
 * the `console` method for its level so Workers Logs files it at that level.
 * The rules live here rather than at call sites: secrets are scrubbed, strings
 * trimmed, errors reduced to name and message.
 */

export type Fields = Record<string, unknown>;

export interface LogRecord {
  event: EventName;
  level: Level;
  alert?: true;
  [field: string]: unknown;
}

export type Sink = (record: LogRecord) => void;

export interface Logger {
  emit(event: EventName, fields?: Fields): void;
  /** A logger that adds `fields` to every record. */
  with(fields: Fields): Logger;
}

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_STRING = 200;
const MAX_STACK = 2000;
const SCRUBBED = '[secret]';

/** `LOG_LEVEL` as configured; anything unrecognised means `info`. */
export function parseLevel(value: string | undefined): Level {
  return value !== undefined && Object.hasOwn(RANK, value) ? (value as Level) : 'info';
}

export const consoleSink: Sink = (record) => console[record.level](record);

export interface LoggerOptions {
  level: Level;
  sink?: Sink;
  /** Values that must never appear in a record, such as the API key. */
  secrets?: string[];
}

export function createLogger({ level, sink = consoleSink, secrets = [] }: LoggerOptions): Logger {
  const hidden = secrets.filter((s) => s.length > 0);

  const text = (s: string, max = MAX_STRING) => {
    const scrubbed = hidden.reduce((acc, secret) => acc.split(secret).join(SCRUBBED), s);
    return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
  };

  const clean = (value: unknown, withStack: boolean): unknown => {
    if (typeof value === 'string') return text(value);
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) {
      const out: Fields = { name: value.name, message: text(value.message) };
      if (withStack && value.stack) out.stack = text(value.stack, MAX_STACK);
      return out;
    }
    try {
      return text(JSON.stringify(value) ?? String(value));
    } catch {
      return text(String(value));
    }
  };

  const make = (context: Fields): Logger => ({
    emit(event, fields = {}) {
      const spec = EVENTS[event];
      if (RANK[spec.level] < RANK[level]) return;
      const record: LogRecord = { event, level: spec.level };
      if ('alert' in spec) record.alert = true;
      const withStack = event === 'app.unhandled';
      for (const [key, value] of Object.entries({ ...context, ...fields })) {
        if (value === undefined || key === 'event' || key === 'level' || key === 'alert') continue;
        record[key] = clean(value, withStack);
      }
      sink(record);
    },
    with(fields) {
      return make({ ...context, ...fields });
    },
  });

  return make({});
}
