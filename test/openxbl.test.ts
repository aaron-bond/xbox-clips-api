import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors';
import { OpenXblProvider } from '../src/provider/openxbl';
import { accountResponse, clipsResponse, searchResponse, XUID } from './fixtures/openxbl';
import { mostPlayedResponse } from './fixtures/most-played';
import { titlesResponse } from './fixtures/titles';

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

  it('fetches title history and keeps only the career facts', async () => {
    const fetch = fakeFetch(200, titlesResponse);
    const stats = await new OpenXblProvider(fetch).getCareerStats('k', XUID);
    expect(fetch.mock.calls[0]![0]).toBe(`https://api.xbl.io/v2/titles/${XUID}`);
    expect(stats?.biggestHaul?.name).toBe('Titanfall');
  });

  it.each([403, 404])('treats a %i title history as unavailable', async (status) => {
    expect(await new OpenXblProvider(fakeFetch(status, '')).getCareerStats('k', XUID)).toBeNull();
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
