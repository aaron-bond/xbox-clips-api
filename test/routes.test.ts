import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { ClipPage } from '../src/domain';
import type { AppEnv } from '../src/env';
import { AppError } from '../src/errors';
import { keys } from '../src/service';
import { FakeProvider, makeClip } from './fake-provider';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const XUID = '2533274900000001';
const CLIP_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLIP_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const UI = 'https://xbox-clips-ui.pages.dev';

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
    provider.profiles.set(XUID, { xuid: XUID, gamertag: 'TestPlayer', gamerscore: 10, gamerpicUrl: null });

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
    provider.profiles.set(XUID, { xuid: XUID, gamertag: 'TestPlayer', gamerscore: 10, gamerpicUrl: null });
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

describe('share', () => {
  it('renders Open Graph tags and redirects to the UI', async () => {
    const { get, provider } = setup();
    withClips(provider, page([makeClip({ clipId: CLIP_A, xuid: XUID, caption: 'Big <win> & "more"' })]));
    const res = await get(`/share/${XUID}/${CLIP_A}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Big &#60;win&#62; &#38; &#34;more&#34;">');
    expect(html).toContain(`<meta property="og:image" content="https://example.test/${CLIP_A}.png">`);
    expect(html).toContain(`url=${UI}/clip/${XUID}/${CLIP_A}`);
    expect(html).not.toContain('.mp4');
  });

  it('serves repeat previews from cached metadata without calling upstream', async () => {
    const { get, provider, advance } = setup();
    withClips(provider, page([makeClip({ clipId: CLIP_A, xuid: XUID })]));
    await get(`/share/${XUID}/${CLIP_A}`);

    advance(24 * 60 * 60 * 1000); // list and URLs long expired; metadata still valid
    await get(`/share/${XUID}/${CLIP_A}`);
    expect(provider.calls.getClips).toBe(1);
  });

  it('renders an HTML fallback for expired and unknown clips', async () => {
    const { get, provider, advance } = setup();
    withClips(provider, page([makeClip({ clipId: CLIP_A, xuid: XUID, availableUntil: '2026-10-20T00:00:00.000Z' })]));
    await get(`/share/${XUID}/${CLIP_A}`);
    advance(5 * 24 * 60 * 60 * 1000);

    const expired = await get(`/share/${XUID}/${CLIP_A}`);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain('This clip has expired on Xbox');

    const unknown = await get(`/share/${XUID}/${CLIP_B}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('Clip unavailable');

    const malformed = await get(`/share/${XUID}/not-a-clip`);
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('content-type')).toContain('text/html');
  });
});
