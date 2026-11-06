import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { Cache } from './cache';
import type { AppEnv } from './env';
import { AppError } from './errors';
import { createLogger, parseLevel, type Logger, type Sink } from './log';
import type { IXboxDataProvider } from './provider/types';
import { isAllowedOrigin, parseAllowedOrigins } from './origins';
import { ClipService } from './service';
import { parseClipId, parseLimit, parsePlayerIdentifier, parseProductId, parseTitleId, parseXuid } from './validation';

export interface AppDeps {
  provider: IXboxDataProvider;
  /** Injectable clock, so tests can move past expiry times. */
  now?: () => number;
  /** Where log records go; the console by default. Tests read records here. */
  sink?: Sink;
}

type AppVars = { Bindings: AppEnv; Variables: { log: Logger } };
type AppContext = Context<AppVars>;

export function createApp({ provider, now = Date.now, sink }: AppDeps) {
  const app = new Hono<AppVars>();
  const logger = (c: AppContext) => createLogger({ level: parseLevel(c.env.LOG_LEVEL), sink, secrets: [c.env.XBL_API_KEY] });

  // First, so every later handler, the error handler included, has a logger.
  app.use('*', async (c, next) => {
    c.set('log', logger(c));
    await next();
  });
  const service = (c: AppContext) =>
    new ClipService(provider, new Cache(c.env.CACHE, now, c.var.log), { apiKey: c.env.XBL_API_KEY, log: c.var.log }, now);

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
    if (!success) {
      // No client identifier: counting distinct clients would need a salted hash (PLAN-v1.md §11.3).
      c.var.log.emit('inbound.rate_limited', { method: c.req.method, path: c.req.path });
      throw new AppError('RATE_LIMITED', '60');
    }
    await next();
  };
  app.use('/api/*', rateLimit);

  // While the UI's API proxy only reports, it marks the requests it would refuse
  // (PLAN-v1.md §6, "Locking the API to the site"). Logged here: Pages keeps no logs.
  app.use('/api/*', async (c, next) => {
    const guard = c.req.header('x-site-guard');
    if (guard) c.var.log.emit('inbound.site_guard_would_refuse', { reason: guard.slice(0, 40), method: c.req.method, path: c.req.path });
    await next();
  });

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

  // The player's recent games, from the same cached title history as career facts.
  app.get('/api/v1/players/:identifier/games', async (c) => {
    const id = parsePlayerIdentifier(c.req.param('identifier'));
    return c.json(await service(c).getGames(id));
  });

  // The player's Mythic total: a full read of the title history, one per player per day.
  app.get('/api/v1/players/:identifier/mythics', async (c) => {
    const id = parsePlayerIdentifier(c.req.param('identifier'));
    return c.json(await service(c).getMythics(id));
  });

  // The games a player is closest to finishing, and their Mythics: a full read of the title history on every call.
  app.get('/api/v1/players/:identifier/nearest-completion', async (c) => {
    const id = parsePlayerIdentifier(c.req.param('identifier'));
    return c.json(await service(c).getNearestCompletion(id));
  });

  // A player's achievements in one game: one upstream call per player and game per hour.
  app.get('/api/v1/players/:identifier/achievements/:titleId', async (c) => {
    const id = parsePlayerIdentifier(c.req.param('identifier'));
    const titleId = parseTitleId(c.req.param('titleId'));
    return c.json(await service(c).getAchievements(id, titleId));
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

  // Store screenshots for a ranked game: one upstream call per game per week.
  app.get('/api/v1/games/:productId/screenshots', async (c) => {
    const productId = parseProductId(c.req.param('productId'));
    return c.json({ screenshots: await service(c).getScreenshots(productId) });
  });

  app.notFound((c) => {
    const err = new AppError('NOT_FOUND');
    return c.json(err.toBody(), err.status);
  });

  app.onError((err, c) => {
    const appErr = err instanceof AppError ? err : new AppError('INTERNAL_ERROR');
    const log = c.get('log') ?? logger(c);
    if (!(err instanceof AppError)) log.emit('app.unhandled', { error: err, method: c.req.method, path: c.req.path });
    if (appErr.code === 'INVALID_IDENTIFIER') log.emit('request.invalid', { path: c.req.path });
    if (appErr.status >= 500) log.emit('request.failed', { code: appErr.code, status: appErr.status, method: c.req.method, path: c.req.path });
    if (appErr.retryAfter) c.header('Retry-After', appErr.retryAfter);
    return c.json(appErr.toBody(), appErr.status);
  });

  return app;
}
