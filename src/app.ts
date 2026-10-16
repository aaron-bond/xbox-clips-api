import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { Cache } from './cache';
import type { AppEnv } from './env';
import { AppError } from './errors';
import type { IXboxDataProvider } from './provider/types';
import { ClipService } from './service';
import { renderShareFallback, renderSharePage, uiClipUrl } from './share';
import { parseClipId, parseLimit, parsePlayerIdentifier, parseXuid } from './validation';

export interface AppDeps {
  provider: IXboxDataProvider;
  /** Injectable clock, so tests can move past expiry times. */
  now?: () => number;
}

type AppContext = Context<{ Bindings: AppEnv }>;

export function createApp({ provider, now = Date.now }: AppDeps) {
  const app = new Hono<{ Bindings: AppEnv }>();
  const service = (c: AppContext) => new ClipService(provider, new Cache(c.env.CACHE, now), c.env.XBL_API_KEY, now);

  app.use(
    '*',
    cors({
      origin: (origin, c: AppContext) => (allowedOrigins(c.env).includes(origin) ? origin : null),
      allowMethods: ['GET', 'OPTIONS'],
      maxAge: 86400,
    }),
  );

  // Per-IP inbound limit protecting the shared upstream budget (PLAN-v1.md §6).
  const rateLimit = async (c: AppContext, next: () => Promise<void>) => {
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const { success } = await c.env.RATE_LIMITER.limit({ key: ip });
    if (!success) throw new AppError('RATE_LIMITED', '60');
    await next();
  };
  app.use('/api/*', rateLimit);
  app.use('/share/*', rateLimit);

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/api/v1/players/:identifier', async (c) => {
    const id = parsePlayerIdentifier(c.req.param('identifier'));
    return c.json(await service(c).getProfile(id));
  });

  app.get('/api/v1/players/:identifier/clips', async (c) => {
    const id = parsePlayerIdentifier(c.req.param('identifier'));
    return c.json(await service(c).getClips(id, parseLimit(c.req.query('limit'))));
  });

  app.get('/api/v1/clips/:xuid/:clipId', async (c) => {
    const xuid = parseXuid(c.req.param('xuid'));
    const clipId = parseClipId(c.req.param('clipId'));
    return c.json(await service(c).getClip(xuid, clipId));
  });

  // HTML, not JSON: failures render a page that still sends people on to the UI.
  app.get('/share/:xuid/:clipId', async (c) => {
    const rawXuid = c.req.param('xuid');
    const rawClipId = c.req.param('clipId');
    const target = uiClipUrl(c.env.UI_ORIGIN, encodeURIComponent(rawXuid), encodeURIComponent(rawClipId));
    try {
      const clip = await service(c).getClipMetadata(parseXuid(rawXuid), parseClipId(rawClipId));
      return c.html(renderSharePage(clip, target));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      if (err.code === 'RATE_LIMITED') throw err;
      const heading = err.code === 'CLIP_EXPIRED' ? 'This clip has expired on Xbox' : 'Clip unavailable';
      if (err.retryAfter) c.header('Retry-After', err.retryAfter);
      return c.html(renderShareFallback(heading, target), err.status);
    }
  });

  app.notFound((c) => {
    const err = new AppError('NOT_FOUND');
    return c.json(err.toBody(), err.status);
  });

  app.onError((err, c) => {
    const appErr = err instanceof AppError ? err : new AppError('INTERNAL_ERROR');
    if (!(err instanceof AppError)) console.error('unhandled error', err);
    if (appErr.retryAfter) c.header('Retry-After', appErr.retryAfter);
    return c.json(appErr.toBody(), appErr.status);
  });

  return app;
}

function allowedOrigins(env: AppEnv): string[] {
  return env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
}
