import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors';
import { createLogger, type LogRecord } from '../src/log';
import { OpenXblProvider } from '../src/provider/openxbl';
import type { UpstreamCall } from '../src/provider/types';
import { accountResponse, clipsResponse, privateClipsResponse, searchResponse, XUID } from './fixtures/openxbl';
import { mostPlayedResponse } from './fixtures/most-played';
import { titlesResponse } from './fixtures/titles';
import { storeDetailsResponse } from './fixtures/store-details';
import { currentAchievementsResponse, x360AchievementsResponse } from './fixtures/achievements';
import { minutesPlayedResponse } from './fixtures/player-stats';

let records: LogRecord[] = [];
const call: UpstreamCall = { apiKey: 'k', log: createLogger({ level: 'debug', sink: (r) => records.push(r) }) };
beforeEach(() => {
  records = [];
});
const events = () => records.map((r) => r.event);

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }),
  );
}

async function expectAppError(promise: Promise<unknown>, code: string, retryAfter?: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (retryAfter) expect((err as AppError).retryAfter).toBe(retryAfter);
  return err as AppError;
}

describe('OpenXblProvider', () => {
  it('sends the key per call and unwraps the envelope', async () => {
    const fetch = fakeFetch(200, searchResponse);
    const xuid = await new OpenXblProvider(fetch).resolveGamertag({ ...call, apiKey: 'key-1' }, 'TestPlayer');
    expect(xuid).toBe(XUID);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.xbl.io/v2/search/TestPlayer');
    expect(new Headers(init?.headers).get('X-Authorization')).toBe('key-1');
  });

  it('encodes gamertags with spaces', async () => {
    const fetch = fakeFetch(200, { content: { people: [] }, code: 200 });
    await new OpenXblProvider(fetch).resolveGamertag(call, 'Test Player');
    expect(fetch.mock.calls[0]![0]).toBe('https://api.xbl.io/v2/search/Test%20Player');
  });

  it('maps profiles and clips', async () => {
    expect((await new OpenXblProvider(fakeFetch(200, accountResponse)).getProfile(call, XUID))?.gamertag).toBe('TestPlayer');
    expect((await new OpenXblProvider(fakeFetch(200, clipsResponse)).getClips(call, XUID)).clips).toHaveLength(1);
  });

  it('fetches and maps most-played games', async () => {
    const fetch = fakeFetch(200, mostPlayedResponse);
    const games = await new OpenXblProvider(fetch).getMostPlayedGames(call);
    expect(fetch.mock.calls[0]![0]).toBe('https://api.xbl.io/v2/marketplace/most-played');
    expect(games).toHaveLength(4);
  });

  it('posts one product id for store screenshots', async () => {
    const fetch = fakeFetch(200, storeDetailsResponse);
    const shots = await new OpenXblProvider(fetch).getScreenshots(call, '9N4PT8HGCDHQ');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.xbl.io/v2/marketplace/details');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ products: '9N4PT8HGCDHQ' });
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(shots).toHaveLength(2);
  });

  it('fetches title history and keeps only the career facts', async () => {
    const fetch = fakeFetch(200, titlesResponse);
    const stats = (await new OpenXblProvider(fetch).getTitleHistory(call, XUID))?.stats;
    expect(fetch.mock.calls[0]![0]).toBe(`https://api.xbl.io/v2/titles/${XUID}`);
    expect(stats?.biggestHaul?.name).toBe('Titanfall');
  });

  it('returns the recent games alongside the career facts', async () => {
    const history = await new OpenXblProvider(fakeFetch(200, titlesResponse)).getTitleHistory(call, XUID);
    expect(history?.games[0]?.name).toBe("Assassin's Creed Black Flag Resynced");
    expect(history?.games.some((g) => g.xbox360)).toBe(true);
  });

  it('asks the right endpoint for current and Xbox 360 achievements', async () => {
    const current = fakeFetch(200, currentAchievementsResponse);
    expect((await new OpenXblProvider(current).getAchievements(call, XUID, '1661962317', false))?.achievements).toHaveLength(3);
    expect(current.mock.calls[0]![0]).toBe(`https://api.xbl.io/v2/achievements/player/${XUID}/1661962317`);
    const x360 = fakeFetch(200, x360AchievementsResponse);
    expect((await new OpenXblProvider(x360).getAchievements(call, XUID, '1297287449', true))?.achievements).toHaveLength(2);
    expect(x360.mock.calls[0]![0]).toBe(`https://api.xbl.io/v2/achievements/x360/${XUID}/title/1297287449`);
  });

  it('posts the players and game for minutes played', async () => {
    const fetch = fakeFetch(200, minutesPlayedResponse);
    const minutes = await new OpenXblProvider(fetch).getMinutesPlayed(call, ['2584878536129841'], '1661962317');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.xbl.io/v2/player/stats');
    expect(JSON.parse(String(init?.body))).toEqual({ xuids: ['2584878536129841'], stats: [{ name: 'MinutesPlayed', titleId: '1661962317' }] });
    expect(minutes).toEqual({ '2584878536129841': 2019 });
  });

  it('treats hidden achievements as unavailable', async () => {
    expect(await new OpenXblProvider(fakeFetch(200, { content: {}, code: 403 })).getAchievements(call, XUID, '1', false)).toBeNull();
  });

  it('reads only the most recent 100 games of a long history', async () => {
    const titles = Array.from({ length: 150 }, (_, i) => ({
      titleId: String(i), name: `Game ${i}`, type: 'Game',
      achievement: { currentGamerscore: i === 120 ? 5000 : 10, totalGamerscore: 6000, progressPercentage: 1 },
      titleHistory: { lastTimePlayed: new Date(Date.UTC(2026, 0, 1) - i * 86_400_000).toISOString() },
    }));
    const stats = (await new OpenXblProvider(fakeFetch(200, { content: { xuid: XUID, titles }, code: 200 })).getTitleHistory(call, XUID))?.stats;
    expect(stats).toMatchObject({ gamesCounted: 100, limited: true });
    // Game 120 has the biggest haul overall, but is older than the 100 read.
    expect(stats?.biggestHaul?.name).not.toBe('Game 120');
  });

  it('reads the Mythic total from the end of the title history, split across chunks', async () => {
    const titles = Array.from({ length: 300 }, (_, i) => ({ titleId: String(i), name: `Gamé ${i}`, type: 'Game' }));
    const text = JSON.stringify({ content: { xuid: XUID, titles, achievementSummary: { mythicsUnlocked: 13 } }, code: 200 });
    for (const size of [1, 7, 997]) {
      const bytes = new TextEncoder().encode(text.slice(-5000));
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const piece = bytes.slice(sent, sent + size);
          sent += size;
          if (piece.length) controller.enqueue(piece);
          else controller.close();
        },
      });
      expect(await new OpenXblProvider(vi.fn(async () => new Response(body))).getMythics(call, XUID)).toBe(13);
    }
    expect(await new OpenXblProvider(fakeFetch(200, titlesResponse)).getMythics(call, XUID)).toBe(12);
  });

  it('gives no Mythic total for a hidden history or a body without one', async () => {
    expect(await new OpenXblProvider(fakeFetch(200, { content: {}, code: 403 })).getMythics(call, XUID)).toBeNull();
    expect(await new OpenXblProvider(fakeFetch(404, '')).getMythics(call, XUID)).toBeNull();
    expect(await new OpenXblProvider(fakeFetch(200, { content: { titles: [] }, code: 200 })).getMythics(call, XUID)).toBeNull();
  });

  it('turns a throttled or broken Mythic read into the usual errors', async () => {
    await expect(new OpenXblProvider(fakeFetch(200, { content: {}, code: 429 })).getMythics(call, XUID)).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMIT' });
    await expect(new OpenXblProvider(fakeFetch(500, 'oops')).getMythics(call, XUID)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    const body = new ReadableStream<Uint8Array>({ pull: (c) => c.error(new Error('cut off')) });
    await expect(new OpenXblProvider(vi.fn(async () => new Response(body))).getMythics(call, XUID)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('reads the nearest-completion list from the whole title history, past the first 100 games', async () => {
    const titles = Array.from({ length: 300 }, (_, i) => ({ titleId: String(i), name: `Game ${i}`, type: 'Game', achievement: { currentGamerscore: i + 1, totalGamerscore: 1000 } }));
    const found = await new OpenXblProvider(fakeFetch(200, { content: { xuid: XUID, titles }, code: 200 })).getNearestCompletion(call, XUID);
    expect(found?.games[0]).toMatchObject({ name: 'Game 299', gamerscore: 300 });
    expect(found?.capped).toBe(false);
  });

  it('gives no nearest-completion list for a hidden history, and the usual errors otherwise', async () => {
    expect(await new OpenXblProvider(fakeFetch(200, { content: {}, code: 403 })).getNearestCompletion(call, XUID)).toBeNull();
    await expect(new OpenXblProvider(fakeFetch(200, { content: {}, code: 429 })).getNearestCompletion(call, XUID)).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMIT' });
    await expect(new OpenXblProvider(vi.fn(async () => new Response('not json'))).getNearestCompletion(call, XUID)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('stops reading a title history once it has 100 games, even split across chunks', async () => {
    const titles = Array.from({ length: 300 }, (_, i) => ({ titleId: String(i), name: `Game ${i} {"}`, type: 'Game', achievement: { currentGamerscore: 1, totalGamerscore: 2, progressPercentage: 50 } }));
    const text = JSON.stringify({ content: { xuid: XUID, titles }, code: 200 });
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Odd-sized chunks, so entries and strings straddle chunk boundaries.
        const piece = text.slice(sent, sent + 997);
        sent += 997;
        if (piece) controller.enqueue(new TextEncoder().encode(piece));
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const stats = (await new OpenXblProvider(vi.fn(async () => new Response(body))).getTitleHistory(call, XUID))?.stats;
    expect(stats).toMatchObject({ gamesCounted: 100, limited: true });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(text.length / 2);
  });

  it('reads a short history to its end', async () => {
    const titles = [{ titleId: '1', name: 'Only', type: 'Game', achievement: { currentGamerscore: 5, totalGamerscore: 10, progressPercentage: 50 } }];
    const stats = (await new OpenXblProvider(fakeFetch(200, { content: { xuid: XUID, titles }, code: 200 })).getTitleHistory(call, XUID))?.stats;
    expect(stats).toMatchObject({ gamesCounted: 1, limited: false });
  });

  it('treats an inner 404 in the envelope as a hidden history', async () => {
    expect(await new OpenXblProvider(fakeFetch(200, { content: {}, code: 404 })).getTitleHistory(call, XUID)).toBeNull();
  });

  it('honours a rate limit carried in the envelope of a title history', async () => {
    const provider = new OpenXblProvider(fakeFetch(200, { content: {}, code: 429 }));
    await expect(provider.getTitleHistory(call, XUID)).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMIT' });
  });

  it.each([403, 404])('treats a %i title history as unavailable', async (status) => {
    expect(await new OpenXblProvider(fakeFetch(status, '')).getTitleHistory(call, XUID)).toBeNull();
  });

  it('passes the continuation token through', async () => {
    const fetch = fakeFetch(200, clipsResponse);
    await new OpenXblProvider(fetch).getClips(call, XUID, 'tok/en=');
    expect(fetch.mock.calls[0]![0]).toBe(`https://api.xbl.io/v2/dvr/gameclips/${XUID}?continuationToken=tok%2Fen%3D`);
  });

  it('maps 429 to UPSTREAM_RATE_LIMIT with Retry-After', async () => {
    const provider = new OpenXblProvider(fakeFetch(429, 'slow down', { 'retry-after': '12' }));
    await expectAppError(provider.getClips(call, XUID), 'UPSTREAM_RATE_LIMIT', '12');
  });

  it('honours a 429 carried inside a 200 envelope', async () => {
    const provider = new OpenXblProvider(fakeFetch(200, { content: {}, code: 429 }));
    await expectAppError(provider.getClips(call, XUID), 'UPSTREAM_RATE_LIMIT');
  });

  it('maps 5xx and network failure to UPSTREAM_ERROR without leaking upstream text', async () => {
    const err = await expectAppError(
      new OpenXblProvider(fakeFetch(503, 'internal secret detail')).getProfile(call, XUID),
      'UPSTREAM_ERROR',
    );
    expect(err.message).not.toContain('secret');
    const offline = new OpenXblProvider(vi.fn(async () => Promise.reject(new TypeError('network down'))));
    await expectAppError(offline.getProfile(call, XUID), 'UPSTREAM_ERROR');
  });

  it('maps an unexpected 4xx such as a revoked key to UPSTREAM_ERROR', async () => {
    await expectAppError(new OpenXblProvider(fakeFetch(401, { error: 'bad key' })).getProfile(call, XUID), 'UPSTREAM_ERROR');
  });

  it('returns null for unknown players', async () => {
    expect(await new OpenXblProvider(fakeFetch(404, '')).resolveGamertag(call, 'Nobody')).toBeNull();
    expect(await new OpenXblProvider(fakeFetch(404, '')).getProfile(call, XUID)).toBeNull();
  });

  it("reports clips as restricted when Xbox says they aren't public (GameMedia error 10209)", async () => {
    const page = await new OpenXblProvider(fakeFetch(200, privateClipsResponse)).getClips(call, XUID);
    expect(page).toEqual({ clips: [], continuationToken: null, access: 'restricted' });
  });

  // Any other 403 or 404 on clips has been an intermittent upstream failure, never
  // to be cached as a fact about the player.
  it.each([403, 404])('treats any other %i on clips as a transient upstream error', async (status) => {
    await expectAppError(new OpenXblProvider(fakeFetch(status, '')).getClips(call, XUID), 'UPSTREAM_ERROR');
    await expectAppError(
      new OpenXblProvider(fakeFetch(200, { content: { errorCode: 1, HttpStatusCode: status }, code: status })).getClips(call, XUID),
      'UPSTREAM_ERROR',
    );
  });
});

describe('OpenXblProvider logging', () => {
  it('logs every call by endpoint name, status, budget and time, never the identifier', async () => {
    await new OpenXblProvider(fakeFetch(200, accountResponse, { 'x-ratelimit-remaining': '140' })).getProfile(call, XUID);
    expect(records).toEqual([
      { event: 'upstream.call', level: 'info', method: 'GET', endpoint: 'account', status: 200, remaining: 140, ms: expect.any(Number) },
    ]);
    expect(JSON.stringify(records)).not.toContain(XUID);
  });

  it('logs title-history reads as titles', async () => {
    await new OpenXblProvider(fakeFetch(200, titlesResponse)).getTitleHistory(call, XUID);
    expect(records).toMatchObject([{ event: 'upstream.call', endpoint: 'titles', status: 200, remaining: null }]);
  });

  it('warns while the hourly budget is nearly spent', async () => {
    await new OpenXblProvider(fakeFetch(200, accountResponse, { 'x-ratelimit-remaining': '19' })).getProfile(call, XUID);
    expect(records[1]).toEqual({ event: 'upstream.budget_low', level: 'warn', alert: true, remaining: 19 });
  });

  it.each([
    ['50', 'per-user'],
    ['0', 'budget'],
  ])('tells which limit a 429 hit (remaining %s: %s)', async (remaining, limit) => {
    const provider = new OpenXblProvider(fakeFetch(429, '', { 'x-ratelimit-remaining': remaining, 'retry-after': '30' }));
    await expectAppError(provider.getClips(call, XUID), 'UPSTREAM_RATE_LIMIT', '30');
    expect(records.find((r) => r.event === 'upstream.rate_limited')).toMatchObject({ endpoint: 'gameclips', limit, remaining: Number(remaining), retryAfter: '30' });
  });

  it('tells a rejected key apart from other failures, with the body in its own record', async () => {
    await expectAppError(new OpenXblProvider(fakeFetch(401, { error: 'bad key' })).getProfile(call, XUID), 'UPSTREAM_ERROR');
    expect(events()).toEqual(['upstream.call', 'upstream.auth_failed', 'upstream.error_body']);
    expect(records[2]).toMatchObject({ endpoint: 'account', status: 401, body: '{"error":"bad key"}' });

    records = [];
    await expectAppError(new OpenXblProvider(fakeFetch(503, 'down')).getMythics(call, XUID), 'UPSTREAM_ERROR');
    expect(events()).toEqual(['upstream.call', 'upstream.error', 'upstream.error_body']);
  });

  it('logs an unreachable upstream', async () => {
    const offline = new OpenXblProvider(vi.fn(async () => Promise.reject(new TypeError('network down'))));
    await expectAppError(offline.getProfile(call, XUID), 'UPSTREAM_ERROR');
    expect(records).toMatchObject([{ event: 'upstream.unreachable', endpoint: 'account', error: { name: 'TypeError', message: 'network down' } }]);
  });

  it('logs a transient clips failure as its own event', async () => {
    await expectAppError(new OpenXblProvider(fakeFetch(404, '')).getClips(call, XUID), 'UPSTREAM_ERROR');
    expect(events()).toEqual(['upstream.call', 'upstream.clips_transient', 'upstream.error_body']);
  });
});
