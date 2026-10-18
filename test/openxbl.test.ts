import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors';
import { OpenXblProvider } from '../src/provider/openxbl';
import { accountResponse, clipsResponse, searchResponse, XUID } from './fixtures/openxbl';
import { mostPlayedResponse } from './fixtures/most-played';
import { titlesResponse } from './fixtures/titles';
import { storeDetailsResponse } from './fixtures/store-details';
import { currentAchievementsResponse, x360AchievementsResponse } from './fixtures/achievements';
import { minutesPlayedResponse } from './fixtures/player-stats';

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
    const xuid = await new OpenXblProvider(fetch).resolveGamertag('key-1', 'TestPlayer');
    expect(xuid).toBe(XUID);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.xbl.io/v2/search/TestPlayer');
    expect(new Headers(init?.headers).get('X-Authorization')).toBe('key-1');
  });

  it('encodes gamertags with spaces', async () => {
    const fetch = fakeFetch(200, { content: { people: [] }, code: 200 });
    await new OpenXblProvider(fetch).resolveGamertag('k', 'Major Nelson');
    expect(fetch.mock.calls[0]![0]).toBe('https://api.xbl.io/v2/search/Major%20Nelson');
  });

  it('maps profiles and clips', async () => {
    expect((await new OpenXblProvider(fakeFetch(200, accountResponse)).getProfile('k', XUID))?.gamertag).toBe('TestPlayer');
    expect((await new OpenXblProvider(fakeFetch(200, clipsResponse)).getClips('k', XUID)).clips).toHaveLength(1);
  });

  it('fetches and maps most-played games', async () => {
    const fetch = fakeFetch(200, mostPlayedResponse);
    const games = await new OpenXblProvider(fetch).getMostPlayedGames('k');
    expect(fetch.mock.calls[0]![0]).toBe('https://api.xbl.io/v2/marketplace/most-played');
    expect(games).toHaveLength(4);
  });

  it('posts one product id for store screenshots', async () => {
    const fetch = fakeFetch(200, storeDetailsResponse);
    const shots = await new OpenXblProvider(fetch).getScreenshots('k', '9N4PT8HGCDHQ');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.xbl.io/v2/marketplace/details');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ products: '9N4PT8HGCDHQ' });
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(shots).toHaveLength(2);
  });

  it('fetches title history and keeps only the career facts', async () => {
    const fetch = fakeFetch(200, titlesResponse);
    const stats = (await new OpenXblProvider(fetch).getTitleHistory('k', XUID))?.stats;
    expect(fetch.mock.calls[0]![0]).toBe(`https://api.xbl.io/v2/titles/${XUID}`);
    expect(stats?.biggestHaul?.name).toBe('Titanfall');
  });

  it('returns the recent games alongside the career facts', async () => {
    const history = await new OpenXblProvider(fakeFetch(200, titlesResponse)).getTitleHistory('k', XUID);
    expect(history?.games[0]?.name).toBe("Assassin's Creed Black Flag Resynced");
    expect(history?.games.some((g) => g.xbox360)).toBe(true);
  });

  it('asks the right endpoint for current and Xbox 360 achievements', async () => {
    const current = fakeFetch(200, currentAchievementsResponse);
    expect((await new OpenXblProvider(current).getAchievements('k', XUID, '1661962317', false))?.achievements).toHaveLength(3);
    expect(current.mock.calls[0]![0]).toBe(`https://api.xbl.io/v2/achievements/player/${XUID}/1661962317`);
    const x360 = fakeFetch(200, x360AchievementsResponse);
    expect((await new OpenXblProvider(x360).getAchievements('k', XUID, '1297287449', true))?.achievements).toHaveLength(2);
    expect(x360.mock.calls[0]![0]).toBe(`https://api.xbl.io/v2/achievements/x360/${XUID}/title/1297287449`);
  });

  it('posts the players and game for minutes played', async () => {
    const fetch = fakeFetch(200, minutesPlayedResponse);
    const minutes = await new OpenXblProvider(fetch).getMinutesPlayed('k', ['2584878536129841'], '1661962317');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.xbl.io/v2/player/stats');
    expect(JSON.parse(String(init?.body))).toEqual({ xuids: ['2584878536129841'], stats: [{ name: 'MinutesPlayed', titleId: '1661962317' }] });
    expect(minutes).toEqual({ '2584878536129841': 2019 });
  });

  it('treats hidden achievements as unavailable', async () => {
    expect(await new OpenXblProvider(fakeFetch(200, { content: {}, code: 403 })).getAchievements('k', XUID, '1', false)).toBeNull();
  });

  it('reads only the most recent 100 games of a long history', async () => {
    const titles = Array.from({ length: 150 }, (_, i) => ({
      titleId: String(i), name: `Game ${i}`, type: 'Game',
      achievement: { currentGamerscore: i === 120 ? 5000 : 10, totalGamerscore: 6000, progressPercentage: 1 },
      titleHistory: { lastTimePlayed: new Date(Date.UTC(2026, 0, 1) - i * 86_400_000).toISOString() },
    }));
    const stats = (await new OpenXblProvider(fakeFetch(200, { content: { xuid: XUID, titles }, code: 200 })).getTitleHistory('k', XUID))?.stats;
    expect(stats).toMatchObject({ gamesCounted: 100, limited: true });
    // Game 120 has the biggest haul overall, but is older than the 100 read.
    expect(stats?.biggestHaul?.name).not.toBe('Game 120');
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
    const stats = (await new OpenXblProvider(vi.fn(async () => new Response(body))).getTitleHistory('k', XUID))?.stats;
    expect(stats).toMatchObject({ gamesCounted: 100, limited: true });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(text.length / 2);
  });

  it('reads a short history to its end', async () => {
    const titles = [{ titleId: '1', name: 'Only', type: 'Game', achievement: { currentGamerscore: 5, totalGamerscore: 10, progressPercentage: 50 } }];
    const stats = (await new OpenXblProvider(fakeFetch(200, { content: { xuid: XUID, titles }, code: 200 })).getTitleHistory('k', XUID))?.stats;
    expect(stats).toMatchObject({ gamesCounted: 1, limited: false });
  });

  it('treats an inner 404 in the envelope as a hidden history', async () => {
    expect(await new OpenXblProvider(fakeFetch(200, { content: {}, code: 404 })).getTitleHistory('k', XUID)).toBeNull();
  });

  it('honours a rate limit carried in the envelope of a title history', async () => {
    const provider = new OpenXblProvider(fakeFetch(200, { content: {}, code: 429 }));
    await expect(provider.getTitleHistory('k', XUID)).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMIT' });
  });

  it.each([403, 404])('treats a %i title history as unavailable', async (status) => {
    expect(await new OpenXblProvider(fakeFetch(status, '')).getTitleHistory('k', XUID)).toBeNull();
  });

  it('passes the continuation token through', async () => {
    const fetch = fakeFetch(200, clipsResponse);
    await new OpenXblProvider(fetch).getClips('k', XUID, 'tok/en=');
    expect(fetch.mock.calls[0]![0]).toBe(`https://api.xbl.io/v2/dvr/gameclips/${XUID}?continuationToken=tok%2Fen%3D`);
  });

  it('maps 429 to UPSTREAM_RATE_LIMIT with Retry-After', async () => {
    const provider = new OpenXblProvider(fakeFetch(429, 'slow down', { 'retry-after': '12' }));
    await expectAppError(provider.getClips('k', XUID), 'UPSTREAM_RATE_LIMIT', '12');
  });

  it('honours a 429 carried inside a 200 envelope', async () => {
    const provider = new OpenXblProvider(fakeFetch(200, { content: {}, code: 429 }));
    await expectAppError(provider.getClips('k', XUID), 'UPSTREAM_RATE_LIMIT');
  });

  it('maps 5xx and network failure to UPSTREAM_ERROR without leaking upstream text', async () => {
    const err = await expectAppError(
      new OpenXblProvider(fakeFetch(503, 'internal secret detail')).getProfile('k', XUID),
      'UPSTREAM_ERROR',
    );
    expect(err.message).not.toContain('secret');
    const offline = new OpenXblProvider(vi.fn(async () => Promise.reject(new TypeError('network down'))));
    await expectAppError(offline.getProfile('k', XUID), 'UPSTREAM_ERROR');
  });

  it('maps an unexpected 4xx such as a revoked key to UPSTREAM_ERROR', async () => {
    await expectAppError(new OpenXblProvider(fakeFetch(401, { error: 'bad key' })).getProfile('k', XUID), 'UPSTREAM_ERROR');
  });

  it('returns null for unknown players', async () => {
    expect(await new OpenXblProvider(fakeFetch(404, '')).resolveGamertag('k', 'Nobody')).toBeNull();
    expect(await new OpenXblProvider(fakeFetch(404, '')).getProfile('k', XUID)).toBeNull();
  });

  // TODO(O3): confirm which response a privacy-restricted player actually produces.
  it.each([403, 404])('treats a %i on clips as restricted access', async (status) => {
    const page = await new OpenXblProvider(fakeFetch(status, '')).getClips('k', XUID);
    expect(page).toEqual({ clips: [], continuationToken: null, access: 'restricted' });
  });
});
