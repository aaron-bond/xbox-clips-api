import type { Achievement, ClipPage, Game, NearestCompletion, Screenshot, TitleHistory, XboxUserProfile } from '../domain';
import { AppError } from '../errors';
import {
  pickSearchMatch,
  toClipPage,
  CAREER_GAMES,
  TitlesScanner,
  mythicsFromTail,
  toAchievements,
  toCareerStats,
  toMinutesPlayed,
  toPlayerGames,
  toMostPlayed,
  toNearestCompletion,
  toProfile,
  toScreenshots,
  type RawAccount,
  type RawAchievementList,
  type RawClipList,
  type RawMostPlayed,
  type RawPlayerStats,
  type RawSearch,
  type RawStoreDetails,
  type RawTitle,
} from './openxbl-transform';
import type { IXboxDataProvider, UpstreamCall } from './types';

const BASE_URL = 'https://api.xbl.io/v2';

/** Xbox's GameMedia error for a player whose captures aren't visible to us. */
const GAMEMEDIA_PRIVATE = 10209;

const isClipsPrivate = (content: unknown) =>
  !!content && typeof content === 'object' && (content as { errorCode?: unknown }).errorCode === GAMEMEDIA_PRIVATE;

/** Enough of a title history's end to hold `achievementSummary` and the envelope's code. */
const TITLES_TAIL_BYTES = 512;

/** Below this many remaining requests in the hourly plan budget, every call logs `upstream.budget_low`. */
const LOW_BUDGET_WARNING = 20;

interface UpstreamResult {
  status: number;
  content: unknown;
  /** The endpoint's name for logs: never carries a gamertag or XUID. */
  endpoint: string;
}

/**
 * Which limit an upstream 429 hit (PLAN-v1.md §11.5). OpenXBL's hourly budget
 * leaves none remaining; with budget left, it was Microsoft's per-user limit,
 * which clears in seconds.
 */
function limitHit(remaining: number | null): 'budget' | 'per-user' | 'unknown' {
  if (remaining === null) return 'unknown';
  return remaining > 0 ? 'per-user' : 'budget';
}

function budgetRemaining(res: Response): number | null {
  const header = res.headers.get('x-ratelimit-remaining');
  const value = header === null ? NaN : Number(header);
  return Number.isFinite(value) ? value : null;
}

export class OpenXblProvider implements IXboxDataProvider {
  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  async resolveGamertag(call: UpstreamCall, gamertag: string): Promise<string | null> {
    const res = await this.get(call, 'search', `/search/${encodeURIComponent(gamertag)}`);
    if (res.status === 404) return null;
    this.expectOk(call, res);
    return pickSearchMatch(res.content as RawSearch, gamertag);
  }

  async getProfile(call: UpstreamCall, xuid: string): Promise<XboxUserProfile | null> {
    const res = await this.get(call, 'account', `/account/${xuid}`);
    if (res.status === 404) return null;
    this.expectOk(call, res);
    return toProfile(res.content as RawAccount);
  }

  async getClips(call: UpstreamCall, xuid: string, continuationToken?: string): Promise<ClipPage> {
    const query = continuationToken ? `?continuationToken=${encodeURIComponent(continuationToken)}` : '';
    const res = await this.get(call, 'gameclips', `/dvr/gameclips/${xuid}${query}`);
    // Privacy has its own answer (O3, PLAN-v1.md §10): an inner 403 whose content is
    // Xbox's GameMedia error 10209. Any other 403 or 404 has been seen to be
    // intermittent for players whose clips are public (2026-10-19, a 200 again
    // within two minutes), so it is a transient failure: never cached, a stale list
    // served instead (PLAN-v1.md §6).
    if (res.status === 403 && isClipsPrivate(res.content)) {
      return { clips: [], continuationToken: null, access: 'restricted' };
    }
    if (res.status === 403 || res.status === 404) {
      call.log.emit('upstream.clips_transient', { status: res.status, xuid });
      call.log.emit('upstream.error_body', { endpoint: res.endpoint, status: res.status, body: res.content });
      throw new AppError('UPSTREAM_ERROR');
    }
    this.expectOk(call, res);
    return toClipPage(res.content as RawClipList);
  }

  async getMostPlayedGames(call: UpstreamCall): Promise<Game[]> {
    const res = await this.get(call, 'marketplace/most-played', '/marketplace/most-played');
    this.expectOk(call, res);
    return toMostPlayed(res.content as RawMostPlayed);
  }

  /** Store screenshots for one product. One product per call: a detail response is about 100 KB. */
  async getScreenshots(call: UpstreamCall, productId: string): Promise<Screenshot[]> {
    const res = await this.get(call, 'marketplace/details', '/marketplace/details', { products: productId });
    this.expectOk(call, res);
    return toScreenshots(res.content as RawStoreDetails, productId);
  }

  /**
   * A player's achievements in one game; null when they aren't visible. Xbox 360
   * games use their own endpoint, which lists only unlocked achievements.
   */
  async getAchievements(
    call: UpstreamCall,
    xuid: string,
    titleId: string,
    xbox360: boolean,
  ): Promise<{ titleName: string | null; achievements: Achievement[] } | null> {
    const path = xbox360 ? `/achievements/x360/${xuid}/title/${titleId}` : `/achievements/player/${xuid}/${titleId}`;
    const res = await this.get(call, xbox360 ? 'achievements/x360' : 'achievements', path);
    if (res.status === 403 || res.status === 404) return null;
    this.expectOk(call, res);
    return toAchievements(res.content as RawAchievementList, xbox360);
  }

  /** Minutes played in one game, for one or more players at once. */
  async getMinutesPlayed(call: UpstreamCall, xuids: string[], titleId: string): Promise<Record<string, number>> {
    const res = await this.get(call, 'player/stats', '/player/stats', { xuids, stats: [{ name: 'MinutesPlayed', titleId }] });
    this.expectOk(call, res);
    return toMinutesPlayed(res.content as RawPlayerStats);
  }

  /**
   * Career facts and recent games from the player's most recent games. The
   * title history can be about 1 MB and arrives newest first, so the body is read as it streams in
   * and the download is cancelled once the first CAREER_GAMES titles have
   * arrived (PLAN-v1.md §5). A hidden history (403/404) is not an error: the
   * facts are simply unavailable.
   */
  async getTitleHistory(call: UpstreamCall, xuid: string): Promise<TitleHistory | null> {
    const path = `/titles/${xuid}`;
    const res = await this.fetchTitles(call, path);

    const scanner = new TitlesScanner(CAREER_GAMES);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        scanner.push(decoder.decode(value, { stream: true }));
        if (scanner.done) {
          // Enough titles: stop the download rather than wait for the rest.
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }

    if (!scanner.done) {
      // The whole body arrived: it may be an error envelope rather than a history.
      scanner.push(decoder.decode());
      scanner.finish();
      if (!this.titlesVisible(call, res, scanner.text)) return null;
    }

    const { titles, more } = scanner.result();
    return { stats: toCareerStats(titles, more), games: toPlayerGames(titles) };
  }

  /**
   * The player's Mythic total, which sits at the very end of the title history
   * (PLAN-v1.md §5). The whole body has to arrive, but only its last bytes are
   * kept and decoded, so the titles are never parsed.
   */
  async getMythics(call: UpstreamCall, xuid: string): Promise<number | null> {
    const path = `/titles/${xuid}`;
    const res = await this.fetchTitles(call, path);
    let tail: ArrayBuffer;
    try {
      // Buffered by the runtime: looping over the chunks here took 26 ms of CPU.
      tail = (await res.arrayBuffer()).slice(-TITLES_TAIL_BYTES);
    } catch (err) {
      call.log.emit('upstream.unreachable', { method: 'GET', endpoint: 'titles', stage: 'body', error: err });
      throw new AppError('UPSTREAM_ERROR');
    }
    const text = new TextDecoder().decode(tail);
    if (!this.titlesVisible(call, res, text)) return null;
    return mythicsFromTail(text);
  }

  /**
   * The games the player is closest to finishing. This is the one read that
   * parses the whole title history, about 1 MB, so it runs only when a visitor
   * asks for it (PLAN-v1.md §5).
   */
  async getNearestCompletion(call: UpstreamCall, xuid: string): Promise<NearestCompletion | null> {
    const path = `/titles/${xuid}`;
    const res = await this.fetchTitles(call, path);
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      call.log.emit('upstream.unreachable', { method: 'GET', endpoint: 'titles', stage: 'body', error: err });
      throw new AppError('UPSTREAM_ERROR');
    }
    if (!this.titlesVisible(call, res, text.slice(-TITLES_TAIL_BYTES))) return null;
    try {
      const raw = JSON.parse(text) as { content?: { titles?: RawTitle[] } };
      return toNearestCompletion(raw.content?.titles ?? []);
    } catch (err) {
      call.log.emit('upstream.unexpected_shape', { endpoint: 'titles', error: err });
      throw new AppError('UPSTREAM_ERROR');
    }
  }

  private async fetchTitles(call: UpstreamCall, path: string): Promise<Response> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(BASE_URL + path, {
        headers: { 'X-Authorization': call.apiKey, Accept: 'application/json' },
      });
    } catch (err) {
      call.log.emit('upstream.unreachable', { method: 'GET', endpoint: 'titles', error: err });
      throw new AppError('UPSTREAM_ERROR');
    }
    // The status here is the outer one; an error envelope's inner code is settled
    // once the body is read (titlesVisible).
    this.recordCall(call, 'GET', 'titles', res, started);
    return res;
  }

  /** One `upstream.call` per call, and `upstream.budget_low` while the hourly budget is nearly spent. */
  private recordCall(call: UpstreamCall, method: string, endpoint: string, res: Response, started: number): void {
    const remaining = budgetRemaining(res);
    call.log.emit('upstream.call', { method, endpoint, status: res.status, remaining, ms: Date.now() - started });
    if (remaining !== null && remaining < LOW_BUDGET_WARNING) call.log.emit('upstream.budget_low', { remaining });
  }

  private rateLimited(call: UpstreamCall, method: string, endpoint: string, res: Response): AppError {
    const remaining = budgetRemaining(res);
    const retryAfter = res.headers.get('retry-after') ?? undefined;
    call.log.emit('upstream.rate_limited', { method, endpoint, limit: limitHit(remaining), remaining, retryAfter });
    return new AppError('UPSTREAM_RATE_LIMIT', retryAfter);
  }

  /** A failed status: its own event, the body as a separate `info` record (PLAN-v1.md §11.3). */
  private failed(call: UpstreamCall, endpoint: string, status: number, body: unknown): AppError {
    // A rejected key takes the whole site down until it is fixed, so it is told apart.
    call.log.emit(status === 401 || status === 403 ? 'upstream.auth_failed' : 'upstream.error', { endpoint, status });
    call.log.emit('upstream.error_body', { endpoint, status, body });
    return new AppError('UPSTREAM_ERROR');
  }

  /**
   * Settles a title-history response read to its end, from the end of its text:
   * it may be an error envelope rather than a history. False when the history is
   * hidden (403/404), which is not an error.
   */
  private titlesVisible(call: UpstreamCall, res: Response, text: string): boolean {
    const inner = /"code"\s*:\s*(\d{3})\s*\}\s*$/.exec(text);
    const status = inner ? Number(inner[1]) : res.status;
    if (status === 403 || status === 404) return false;
    if (status === 429) throw this.rateLimited(call, 'GET', 'titles', res);
    if (status < 200 || status >= 300) throw this.failed(call, 'titles', status, text);
    return true;
  }

  /** GET, or POST with a JSON body when `body` is given. */
  private async get(call: UpstreamCall, endpoint: string, path: string, body?: unknown): Promise<UpstreamResult> {
    const method = body === undefined ? 'GET' : 'POST';
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(BASE_URL + path, {
        method,
        headers: {
          'X-Authorization': call.apiKey,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      call.log.emit('upstream.unreachable', { method, endpoint, error: err });
      throw new AppError('UPSTREAM_ERROR');
    }
    this.recordCall(call, method, endpoint, res, started);

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON bodies are handled by status below.
    }

    // OpenXBL wraps proxied responses as { content, code }; the inner code is the
    // upstream status, and wins when present.
    let status = res.status;
    let content = parsed;
    if (parsed && typeof parsed === 'object' && 'content' in parsed && 'code' in parsed) {
      content = (parsed as { content: unknown }).content;
      const code = (parsed as { code: unknown }).code;
      if (typeof code === 'number') status = code;
    }

    if (status === 429) throw this.rateLimited(call, method, endpoint, res);
    if (status >= 500) throw this.failed(call, endpoint, status, text);
    return { status, content, endpoint };
  }

  /** Any status the endpoint's own handling didn't expect, e.g. 401 from a revoked key. A server-side fault, not the client's. */
  private expectOk(call: UpstreamCall, res: UpstreamResult): void {
    if (res.status < 200 || res.status >= 300) throw this.failed(call, res.endpoint, res.status, res.content);
  }
}
