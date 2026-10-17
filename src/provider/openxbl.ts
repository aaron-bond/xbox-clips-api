import type { CareerStats, ClipPage, Game, XboxUserProfile } from '../domain';
import { AppError } from '../errors';
import {
  pickSearchMatch,
  toClipPage,
  toCareerStats,
  toMostPlayed,
  toProfile,
  type RawAccount,
  type RawClipList,
  type RawMostPlayed,
  type RawTitleHistory,
  type RawSearch,
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

  /**
   * Reads the player's title history (up to about 1 MB) and keeps only the
   * derived facts. A hidden history (403/404) is not an error: the facts are
   * simply unavailable.
   */
  async getCareerStats(apiKey: string, xuid: string): Promise<CareerStats | null> {
    const res = await this.get(apiKey, `/titles/${xuid}`);
    if (res.status === 403 || res.status === 404) return null;
    this.expectOk(res, 'titles');
    return toCareerStats(res.content as RawTitleHistory);
  }

  private async get(apiKey: string, path: string): Promise<UpstreamResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(BASE_URL + path, {
        headers: { 'X-Authorization': apiKey, Accept: 'application/json' },
      });
    } catch (err) {
      console.error(`upstream unreachable: GET ${path}`, err);
      throw new AppError('UPSTREAM_ERROR');
    }

    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    if (res.headers.has('x-ratelimit-remaining') && remaining < LOW_BUDGET_WARNING) {
      console.warn(`upstream budget low: ${remaining} requests left this hour`);
    }

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON bodies are handled by status below.
    }

    // OpenXBL wraps proxied responses as { content, code }; the inner code is the
    // upstream status, and wins when present.
    let status = res.status;
    let content = body;
    if (body && typeof body === 'object' && 'content' in body && 'code' in body) {
      content = (body as { content: unknown }).content;
      const code = (body as { code: unknown }).code;
      if (typeof code === 'number') status = code;
    }

    if (status === 429) {
      console.warn(`upstream rate limit: GET ${path}`);
      throw new AppError('UPSTREAM_RATE_LIMIT', res.headers.get('retry-after') ?? undefined);
    }
    if (status >= 500) {
      console.error(`upstream ${status}: GET ${path}: ${text.slice(0, 500)}`);
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
