import { describe, expect, it, vi } from 'vitest';
import { consoleSink, createLogger, parseLevel, type LogRecord } from '../src/log';
import { EVENTS } from '../src/log-events';

function capture(level: Parameters<typeof createLogger>[0]['level'], secrets: string[] = []) {
  const records: LogRecord[] = [];
  return { records, log: createLogger({ level, secrets, sink: (r) => records.push(r) }) };
}

describe('createLogger', () => {
  it("takes the level from the registry and marks alerting events", () => {
    const { records, log } = capture('debug');
    log.emit('upstream.budget_low', { remaining: 12 });
    log.emit('upstream.call', { endpoint: '/account/{xuid}', status: 200 });
    expect(records).toEqual([
      { event: 'upstream.budget_low', level: 'warn', alert: true, remaining: 12 },
      { event: 'upstream.call', level: 'info', endpoint: '/account/{xuid}', status: 200 },
    ]);
  });

  it('drops records below the configured level', () => {
    const { records, log } = capture('warn');
    log.emit('upstream.call');
    log.emit('cache.stale_served');
    log.emit('upstream.rate_limited');
    log.emit('app.unhandled');
    expect(records.map((r) => r.event)).toEqual(['upstream.rate_limited', 'app.unhandled']);
  });

  it('adds context from with(), letting a record override it, but never event, level or alert', () => {
    const { records, log } = capture('info');
    const child = log.with({ route: '/a', endpoint: 'x' });
    child.with({ method: 'GET' }).emit('upstream.call', { endpoint: 'y', event: 'forged', level: 'debug', alert: false });
    expect(records).toEqual([{ event: 'upstream.call', level: 'info', route: '/a', endpoint: 'y', method: 'GET' }]);
  });

  it('scrubs secrets from every string, nested values and errors included', () => {
    const { records, log } = capture('info', ['k3y', '']);
    log.emit('upstream.error_body', { body: 'bad key k3y here', nested: { url: '/x?key=k3y' }, error: new Error('k3y rejected') });
    const out = JSON.stringify(records);
    expect(out).not.toContain('k3y');
    expect(records[0]).toMatchObject({ body: 'bad key [secret] here', error: { name: 'Error', message: '[secret] rejected' } });
  });

  it('trims long strings to 200 characters', () => {
    const { records, log } = capture('info');
    log.emit('upstream.error_body', { body: 'x'.repeat(500) });
    expect(records[0]!.body).toBe(`${'x'.repeat(200)}…`);
  });

  it('keeps an error stack only for unhandled errors', () => {
    const { records, log } = capture('info');
    log.emit('upstream.unreachable', { error: new Error('down') });
    log.emit('app.unhandled', { error: new Error('bug') });
    expect(records[0]!.error).not.toHaveProperty('stack');
    expect(records[1]!.error).toHaveProperty('stack');
  });

  it('leaves numbers, booleans and null alone and drops undefined', () => {
    const { records, log } = capture('info');
    log.emit('upstream.call', { status: 429, cached: false, remaining: null, retryAfter: undefined });
    expect(records[0]).toEqual({ event: 'upstream.call', level: 'info', status: 429, cached: false, remaining: null });
  });
});

describe('consoleSink', () => {
  it('writes the record object through the console method for its level', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const record = { event: 'upstream.rate_limited', level: 'warn', alert: true } as const;
    consoleSink(record);
    expect(warn).toHaveBeenCalledWith(record);
    warn.mockRestore();
  });
});

describe('parseLevel', () => {
  it('accepts the four levels and falls back to info', () => {
    expect(['debug', 'info', 'warn', 'error'].map(parseLevel)).toEqual(['debug', 'info', 'warn', 'error']);
    expect(parseLevel(undefined)).toBe('info');
    expect(parseLevel('verbose')).toBe('info');
    expect(parseLevel('toString')).toBe('info');
  });
});

describe('EVENTS', () => {
  it('names events as area.what, in lower case', () => {
    for (const name of Object.keys(EVENTS)) expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
});
