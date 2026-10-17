import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { ClipPage } from '../src/domain';
import type { AppEnv } from '../src/env';
import { AppError } from '../src/errors';
import { keys } from '../src/service';
import { FakeProvider, makeClip } from './fake-provider';
import type { Game } from '../src/domain';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const XUID = '2533274900000001';
const CLIP_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLIP_B = 'bbbbbbbb-0000-4000-8000-000000000002';

// KV persists across tests in this pool, so each test starts from an empty namespace.
beforeEach(async () => {
  const listed = await env.CACHE.list();
  await Promise.all(listed.keys.map((k) => env.CACHE.delete(k.name)));
});

const allowAll = { limit: async () => ({ success: true }) } as unknown as RateLimit;

function setup() {
  const provider = new FakeProvider();
  let now = NOW;
  const app = createApp({ provider, now: () => now });
  const testEnv = { ...env, XBL_API_KEY: 'test-key', RATE_LIMITER: allowAll } as AppEnv;
  const get = (path: string, headers: Record<string, string> = {}, override: Partial<AppEnv> = {}) =>
    app.request(path, { headers }, { ...testEnv, ...override });
  return {
    provider,
    get,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function withClips(provider: FakeProvider, ...pages: ClipPage[]) {
  provider.clipPages.set(XUID, pages);
}

const page = (clips: ReturnType<typeof makeClip>[], continuationToken: string | null = null): ClipPage => ({
  clips,
  continuationToken,
  access: 'public',
});

async function errorCode(res: Response) {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('basics', () => {
  it('reports health', async () => {
    const res = await setup().get('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers unknown routes with the error envelope', async () => {
    const res = await setup().get('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No such route.', status: 404 } });
  });

  it('allows CORS only for configured origins', async () => {
    const { get } = setup();
    const allowed = await get('/health', { Origin: 'http://localhost:5173' });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const denied = await get('/health', { Origin: 'https://evil.example' });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows the UI domain and its preview deployments', async () => {
    const { get } = setup();
    for (const origin of ['https://xboxclips.io', 'https://feature-x.xbox-clips-ui.pages.dev', 'https://3f2a1b9c.xbox-clips-ui.pages.dev']) {
      const res = await get('/health', { Origin: origin });
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });

  it('rejects malformed identifiers without calling upstream', async () => {
    const { get, provider } = setup();
    const res = await get('/api/v1/players/bad;tag');
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('INVALID_IDENTIFIER');
    expect(provider.calls.resolveGamertag).toBe(0);
  });

  it('applies the inbound rate limit', async () => {
    const deny = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const res = await setup().get('/api/v1/players/TestPlayer', {}, { RATE_LIMITER: deny });
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('RATE_LIMITED');
    expect(res.headers.get('retry-after')).toBe('60');
  });
});

describe('players', () => {
  it('resolves a gamertag, then serves both lookups from cache', async () => {
    const { get, provider } = setup();
    provider.gamertags.set('testplayer', XUID);
    provider.profiles.set(XUID, { xuid: XUID, gamertag: 'TestPlayer', gamerscore: 10, gamerpicUrl: null, bio: null, location: null, tenureYears: null, reputation: null });

    const first = await get('/api/v1/players/TestPlayer');
    expect(first.status).toBe(200);
    expect(((await first.json()) as { gamertag: string }).gamertag).toBe('TestPlayer');

    await get('/api/v1/players/testplayer');
    expect(provider.calls).toMatchObject({ resolveGamertag: 1, getProfile: 1 });
  });

  it('returns PLAYER_NOT_FOUND for an unknown gamertag', async () => {
    const res = await setup().get('/api/v1/players/Nobody');
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('PLAYER_NOT_FOUND');
  });

  it('serves a stale profile when upstream is rate-limited', async () => {
    const { get, provider, advance } = setup();
    provider.profiles.set(XUID, { xuid: XUID, gamertag: 'TestPlayer', gamerscore: 10, gamerpicUrl: null, bio: null, location: null, tenureYears: null, reputation: null });
    await get(`/api/v1/players/${XUID}`);

    advance(3 * 60 * 60 * 1000); // past the 2-hour freshness window
    provider.failWith = new AppError('UPSTREAM_RATE_LIMIT', '30');
    const res = await get(`/api/v1/players/${XUID}`);
    expect(res.status).toBe(200);
  });

  it('passes upstream rate limits through when nothing is cached', async () => {
    const { get, provider } = setup();
    provider.failWith = new AppError('UPSTREAM_RATE_LIMIT', '30');
    const res = await get(`/api/v1/players/${XUID}`);
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('UPSTREAM_RATE_LIMIT');
    expect(res.headers.get('retry-after')).toBe('30');
  });
});

describe('clips', () => {
  const clips = Array.from({ length: 5 }, (_, i) =>
    makeClip({ clipId: `cccccccc-0000-4000-8000-00000000000${i}`, xuid: XUID }),
  );

  it('caches the full list and slices per request, so limit never freezes in', async () => {
    const { get, provider } = setup();
    withClips(provider, page(clips));

    const small = (await (await get(`/api/v1/players/${XUID}/clips?limit=2`)).json()) as { clips: unknown[]; total: number };
    expect(small.clips).toHaveLength(2);
    expect(small.total).toBe(5);

    const large = (await (await get(`/api/v1/players/${XUID}/clips?limit=50`)).json()) as { clips: unknown[] };
    expect(large.clips).toHaveLength(5);
    expect(provider.calls.getClips).toBe(1);
  });

  it('refetches once the cached URLs are within 5 minutes of expiry', async () => {
    const { get, provider, advance } = setup();
    withClips(provider, page(clips)); // URLs expire 13:00
    await get(`/api/v1/players/${XUID}/clips`);

    advance(54 * 60 * 1000); // 12:54, still fresh
    await get(`/api/v1/players/${XUID}/clips`);
    expect(provider.calls.getClips).toBe(1);

    advance(2 * 60 * 1000); // 12:56, inside the margin
    await get(`/api/v1/players/${XUID}/clips`);
    expect(provider.calls.getClips).toBe(2);
  });

  it('never serves an expired media URL from a stale list', async () => {
    const { get, provider, advance } = setup();
    withClips(provider, page(clips));
    await get(`/api/v1/players/${XUID}/clips`);

    advance(2 * 60 * 60 * 1000); // URLs long dead
    provider.failWith = new AppError('UPSTREAM_ERROR');
    const res = await get(`/api/v1/players/${XUID}/clips`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clips: { media: unknown; thumbnailUrl: string }[] };
    expect(body.clips).toHaveLength(5);
    expect(body.clips.every((c) => c.media === null)).toBe(true);
    expect(body.clips[0]!.thumbnailUrl).toBeTruthy();
  });

  it('reports restricted access distinctly from an empty list', async () => {
    const { get, provider } = setup();
    provider.clipPages.set(XUID, [{ clips: [], continuationToken: null, access: 'restricted' }]);
    const body = (await (await get(`/api/v1/players/${XUID}/clips`)).json()) as { access: string; clips: unknown[] };
    expect(body).toMatchObject({ access: 'restricted', clips: [] });
  });
});

describe('single clip', () => {
  it('resolves a clip from the cached list and records its metadata', async () => {
    const { get, provider } = setup();
    withClips(provider, page([makeClip({ clipId: CLIP_A, xuid: XUID })]));
    await get(`/api/v1/players/${XUID}/clips`);

    const res = await get(`/api/v1/clips/${XUID}/${CLIP_A}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { media: { url: string } }).media.url).toContain(CLIP_A);
    expect(provider.calls.getClips).toBe(1);
    expect(await env.CACHE.get(keys.clip(XUID, CLIP_A))).not.toBeNull();
  });

  it('walks later pages to find an older clip', async () => {
    const { get, provider } = setup();
    withClips(
      provider,
      page([makeClip({ clipId: CLIP_A, xuid: XUID })], 'page-1'),
      page([makeClip({ clipId: CLIP_B, xuid: XUID })]),
    );
    const res = await get(`/api/v1/clips/${XUID}/${CLIP_B}`);
    expect(res.status).toBe(200);
    expect(provider.calls.getClips).toBe(2);
  });

  it('returns CLIP_NOT_FOUND for a clip that was never seen', async () => {
    const { get, provider } = setup();
    withClips(provider, page([makeClip({ clipId: CLIP_A, xuid: XUID })]));
    const res = await get(`/api/v1/clips/${XUID}/${CLIP_B}`);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('CLIP_NOT_FOUND');
  });

  it('returns CLIP_EXPIRED once a known clip has aged out', async () => {
    const { get, provider, advance } = setup();
    withClips(provider, page([makeClip({ clipId: CLIP_A, xuid: XUID, availableUntil: '2026-10-20T00:00:00.000Z' })]));
    await get(`/api/v1/clips/${XUID}/${CLIP_A}`);

    advance(5 * 24 * 60 * 60 * 1000); // past availableUntil
    withClips(provider, page([]));
    const res = await get(`/api/v1/clips/${XUID}/${CLIP_A}`);
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('CLIP_EXPIRED');
  });
});

describe('preview', () => {
  it('returns metadata without a media URL or view count', async () => {
    const { get, provider } = setup();
    withClips(provider, page([makeClip({ clipId: CLIP_A, xuid: XUID, caption: 'Big win' })]));
    const res = await get(`/api/v1/clips/${XUID}/${CLIP_A}/preview`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ clipId: CLIP_A, xuid: XUID, caption: 'Big win', thumbnailUrl: `https://example.test/${CLIP_A}.png` });
    expect(body).not.toHaveProperty('media');
    expect(body).not.toHaveProperty('views');
  });

  it('serves repeat previews from cached metadata without calling upstream', async () => {
    const { get, provider, advance } = setup();
    withClips(provider, page([makeClip({ clipId: CLIP_A, xuid: XUID })]));
    await get(`/api/v1/clips/${XUID}/${CLIP_A}/preview`);

    advance(24 * 60 * 60 * 1000); // list and URLs long expired; metadata still valid
    const res = await get(`/api/v1/clips/${XUID}/${CLIP_A}/preview`);
    expect(res.status).toBe(200);
    expect(provider.calls.getClips).toBe(1);
  });

  it('answers 410 for an expired clip, 404 for an unknown one and 400 for a malformed id', async () => {
    const { get, provider, advance } = setup();
    withClips(provider, page([makeClip({ clipId: CLIP_A, xuid: XUID, availableUntil: '2026-10-20T00:00:00.000Z' })]));
    await get(`/api/v1/clips/${XUID}/${CLIP_A}/preview`);
    advance(5 * 24 * 60 * 60 * 1000);

    const expired = await get(`/api/v1/clips/${XUID}/${CLIP_A}/preview`);
    expect(expired.status).toBe(410);
    expect(await errorCode(expired)).toBe('CLIP_EXPIRED');

    const unknown = await get(`/api/v1/clips/${XUID}/${CLIP_B}/preview`);
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe('CLIP_NOT_FOUND');

    const malformed = await get(`/api/v1/clips/${XUID}/not-a-clip/preview`);
    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe('INVALID_IDENTIFIER');
  });

  it('no longer serves the old /share route', async () => {
    const res = await setup().get(`/share/${XUID}/${CLIP_A}`);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('NOT_FOUND');
  });
});

describe('games', () => {
  const game = (rank: number, productId: string): Game => ({
    productId, rank, title: `Game ${rank}`, genres: ['Shooter'], developer: 'Dev', publisher: 'Pub',
    releaseDate: '2026-10-06T15:00:00Z', rating: 4.5, ratingCount: 100, platforms: ['XboxSeriesX'],
    description: 'A game.', heroImageUrl: 'https://img.test/hero', boxArtUrl: 'https://img.test/box',
  });

  it('serves most-played from one cached upstream call', async () => {
    const { get, provider } = setup();
    provider.mostPlayed = [game(1, '9N4PT8HGCDHQ'), game(2, 'BT5P2X999VH2')];
    const first = (await (await get('/api/v1/games/most-played')).json()) as { games: Game[] };
    expect(first.games.map((g) => g.productId)).toEqual(['9N4PT8HGCDHQ', 'BT5P2X999VH2']);
    await get('/api/v1/games/most-played');
    expect(provider.calls.getMostPlayedGames).toBe(1);
  });

  it('serves one game from the cached list without another upstream call', async () => {
    const { get, provider } = setup();
    provider.mostPlayed = [game(1, '9N4PT8HGCDHQ'), game(2, 'BT5P2X999VH2')];
    await get('/api/v1/games/most-played');
    const res = await get('/api/v1/games/bt5p2x999vh2');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Game).rank).toBe(2);
    expect(provider.calls.getMostPlayedGames).toBe(1);
  });

  it('answers 404 for a game not in the list and 400 for a malformed id', async () => {
    const { get, provider } = setup();
    provider.mostPlayed = [game(1, '9N4PT8HGCDHQ')];
    const missing = await get('/api/v1/games/9NBLGGH512WG');
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('GAME_NOT_FOUND');
    const bad = await get('/api/v1/games/not-a-product');
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('INVALID_IDENTIFIER');
  });

  it('serves a stale list when upstream is rate-limited', async () => {
    const { get, provider, advance } = setup();
    provider.mostPlayed = [game(1, '9N4PT8HGCDHQ')];
    await get('/api/v1/games/most-played');
    advance(7 * 60 * 60 * 1000); // past the 6-hour freshness window
    provider.failWith = new AppError('UPSTREAM_RATE_LIMIT', '30');
    const res = await get('/api/v1/games/most-played');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { games: Game[] }).games).toHaveLength(1);
  });
});

describe('career', () => {
  const stats = {
    nowPlaying: { titleId: '1', name: 'Recent', imageUrl: null, gamerscore: 10, totalGamerscore: 100, percent: 10, lastPlayed: '2026-10-11T00:00:00Z' },
    biggestHaul: null, onTheBrink: null, gamesCounted: 3, limited: false,
  };

  it('serves career facts, cached for a day', async () => {
    const { get, provider, advance } = setup();
    provider.careers.set(XUID, stats);
    const res = await get(`/api/v1/players/${XUID}/career`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ xuid: XUID, stats });
    advance(23 * 60 * 60 * 1000);
    await get(`/api/v1/players/${XUID}/career`);
    expect(provider.calls.getCareerStats).toBe(1);
    advance(2 * 60 * 60 * 1000);
    await get(`/api/v1/players/${XUID}/career`);
    expect(provider.calls.getCareerStats).toBe(2);
  });

  it('caches a hidden history as null instead of refetching it', async () => {
    const { get, provider } = setup();
    const first = (await (await get(`/api/v1/players/${XUID}/career`)).json()) as { stats: unknown };
    expect(first.stats).toBeNull();
    await get(`/api/v1/players/${XUID}/career`);
    expect(provider.calls.getCareerStats).toBe(1);
  });

  it('resolves a gamertag first', async () => {
    const { get, provider } = setup();
    provider.gamertags.set('testplayer', XUID);
    provider.careers.set(XUID, stats);
    const body = (await (await get('/api/v1/players/TestPlayer/career')).json()) as { xuid: string };
    expect(body.xuid).toBe(XUID);
  });
});
