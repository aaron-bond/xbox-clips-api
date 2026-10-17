import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { Cache } from './cache';
import type { AppEnv } from './env';
import { AppError } from './errors';
import type { IXboxDataProvider } from './provider/types';
import { isAllowedOrigin, parseAllowedOrigins } from './origins';
import { ClipService } from './service';
import { parseClipId, parseLimit, parsePlayerIdentifier, parseProductId, parseXuid } from './validation';

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
      origin: (origin, c: AppContext) => (isAllowedOrigin(origin, parseAllowedOrigins(c.env.ALLOWED_ORIGINS)) ? origin : null),
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

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/api/v1/players/:identifier', async (c) => {
    const id = parsePlayerIdentifier(c.req.param('identifier'));
    return c.json(await service(c).getProfile(id));
  });

  app.get('/api/v1/players/:identifier/clips', async (c) => {
    const id = parsePlayerIdentifier(c.req.param('identifier'));
    return c.json(await service(c).getClips(id, parseLimit(c.req.query('limit'))));
  });

  // Career facts from the title history: one upstream call per player per day.
  app.get('/api/v1/players/:identifier/career', async (c) => {
    const id = parsePlayerIdentifier(c.req.param('identifier'));
    return c.json(await service(c).getCareer(id));
  });

  app.get('/api/v1/clips/:xuid/:clipId', async (c) => {
    const xuid = parseXuid(c.req.param('xuid'));
    const clipId = parseClipId(c.req.param('clipId'));
    return c.json(await service(c).getClip(xuid, clipId));
  });

  // Metadata only, never a media URL: backs the UI's link previews, which must not
  // spend upstream calls each time a link is unfurled (PLAN-v1.md §5).
  app.get('/api/v1/clips/:xuid/:clipId/preview', async (c) => {
    const xuid = parseXuid(c.req.param('xuid'));
    const clipId = parseClipId(c.req.param('clipId'));
    return c.json(await service(c).getClipMetadata(xuid, clipId));
  });

  // The front page's most-played games, and one of them for the game page. Both come
  // from one cached upstream call shared by every visitor (PLAN-v1.md §5).
  app.get('/api/v1/games/most-played', async (c) => c.json({ games: await service(c).getMostPlayed() }));

  app.get('/api/v1/games/:productId', async (c) => {
    const productId = parseProductId(c.req.param('productId'));
    return c.json(await service(c).getGame(productId));
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
