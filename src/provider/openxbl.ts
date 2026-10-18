import type { CareerStats, ClipPage, Game, Screenshot, XboxUserProfile } from '../domain';
import { AppError } from '../errors';
import {
  pickSearchMatch,
  toClipPage,
  CAREER_GAMES,
  TitlesScanner,
  toCareerStats,
  toMostPlayed,
  toProfile,
  toScreenshots,
  type RawAccount,
  type RawClipList,
  type RawMostPlayed,
  type RawSearch,
  type RawStoreDetails,
} from './openxbl-transform';
import type { IXboxDataProvider } from './types';

const BASE_URL = 'https://api.xbl.io/v2';

/** Below this many remaining requests in the hourly plan budget, every call logs a warning. */
const LOW_BUDGET_WARNING = 20;

interface UpstreamResult {
  status: number;
  content: unknown;
}

export class OpenXblProvider implements IXboxDataProvider {
  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  async resolveGamertag(apiKey: string, gamertag: string): Promise<string | null> {
    const res = await this.get(apiKey, `/search/${encodeURIComponent(gamertag)}`);
    if (res.status === 404) return null;
    this.expectOk(res, 'search');
    return pickSearchMatch(res.content as RawSearch, gamertag);
  }

  async getProfile(apiKey: string, xuid: string): Promise<XboxUserProfile | null> {
    const res = await this.get(apiKey, `/account/${xuid}`);
    if (res.status === 404) return null;
    this.expectOk(res, 'account');
    return toProfile(res.content as RawAccount);
  }

  async getClips(apiKey: string, xuid: string, continuationToken?: string): Promise<ClipPage> {
    const query = continuationToken ? `?continuationToken=${encodeURIComponent(continuationToken)}` : '';
    const res = await this.get(apiKey, `/dvr/gameclips/${xuid}${query}`);
    // TODO(O3): unconfirmed which of 403, 404 or an empty 200 a privacy-restricted
    // player produces. 403 and 404 are both treated as restricted until tested; an
    // empty 200 is reported as public with no clips.
    if (res.status === 403 || res.status === 404) {
      return { clips: [], continuationToken: null, access: 'restricted' };
    }
    this.expectOk(res, 'gameclips');
    return toClipPage(res.content as RawClipList);
  }

  async getMostPlayedGames(apiKey: string): Promise<Game[]> {
    const res = await this.get(apiKey, '/marketplace/most-played');
    this.expectOk(res, 'marketplace/most-played');
    return toMostPlayed(res.content as RawMostPlayed);
  }

  /** Store screenshots for one product. One product per call: a detail response is about 100 KB. */
  async getScreenshots(apiKey: string, productId: string): Promise<Screenshot[]> {
    const res = await this.get(apiKey, '/marketplace/details', { products: productId });
    this.expectOk(res, 'marketplace/details');
    return toScreenshots(res.content as RawStoreDetails, productId);
  }

  /**
   * Career facts from the player's most recent games. The title history can be
   * about 1 MB and arrives newest first, so the body is read as it streams in
   * and the download is cancelled once the first CAREER_GAMES titles have
   * arrived (PLAN-v1.md §5). A hidden history (403/404) is not an error: the
   * facts are simply unavailable.
   */
  async getCareerStats(apiKey: string, xuid: string): Promise<CareerStats | null> {
    const path = `/titles/${xuid}`;
    let res: Response;
    try {
      res = await this.fetchImpl(BASE_URL + path, {
        headers: { 'X-Authorization': apiKey, Accept: 'application/json' },
      });
    } catch (err) {
      console.error(`upstream unreachable: GET ${path}`, err);
      throw new AppError('UPSTREAM_ERROR');
    }

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
      const inner = /"code"\s*:\s*(\d{3})\s*\}\s*$/.exec(scanner.text);
      const status = inner ? Number(inner[1]) : res.status;
      if (status === 403 || status === 404) return null;
      if (status === 429) {
        console.warn(`upstream rate limit: GET ${path}`);
        throw new AppError('UPSTREAM_RATE_LIMIT', res.headers.get('retry-after') ?? undefined);
      }
      if (status < 200 || status >= 300) {
        console.error(`upstream ${status}: GET ${path}: ${scanner.text.slice(0, 500)}`);
        throw new AppError('UPSTREAM_ERROR');
      }
    }

    const { titles, more } = scanner.result();
    return toCareerStats(titles, more);
  }

  /** GET, or POST with a JSON body when `body` is given. */
  private async get(apiKey: string, path: string, body?: unknown): Promise<UpstreamResult> {
    const method = body === undefined ? 'GET' : 'POST';
    let res: Response;
    try {
      res = await this.fetchImpl(BASE_URL + path, {
        method,
        headers: {
          'X-Authorization': apiKey,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      console.error(`upstream unreachable: ${method} ${path}`, err);
      throw new AppError('UPSTREAM_ERROR');
    }

    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    if (res.headers.has('x-ratelimit-remaining') && remaining < LOW_BUDGET_WARNING) {
      console.warn(`upstream budget low: ${remaining} requests left this hour`);
    }

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

    if (status === 429) {
      console.warn(`upstream rate limit: ${method} ${path}`);
      throw new AppError('UPSTREAM_RATE_LIMIT', res.headers.get('retry-after') ?? undefined);
    }
    if (status >= 500) {
      console.error(`upstream ${status}: ${method} ${path}: ${text.slice(0, 500)}`);
      throw new AppError('UPSTREAM_ERROR');
    }
    return { status, content };
  }

  private expectOk(res: UpstreamResult, what: string): void {
    if (res.status < 200 || res.status >= 300) {
      // e.g. 401 from a revoked key. A server-side fault, not the client's.
      console.error(`upstream ${what} returned ${res.status}: ${JSON.stringify(res.content)?.slice(0, 500)}`);
      throw new AppError('UPSTREAM_ERROR');
    }
  }
}
