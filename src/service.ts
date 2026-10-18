import { Cache } from './cache';
import { toMetadata, type CareerStats, type ClipMetadata, type ClipPage, type Game, type GameClipInfo, type Screenshot, type XboxUserProfile } from './domain';
import { AppError } from './errors';
import type { IXboxDataProvider } from './provider/types';
import type { PlayerIdentifier } from './validation';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Cache policy (PLAN-v1.md §5). Each entry has a freshness window and a longer
 * KV retention, so stale data can be served when upstream is under pressure.
 */
export const POLICY = {
  /** Gamertag → XUID never changes. */
  xuid: { fresh: 30 * DAY, retain: 30 * DAY },
  /** Long-lived: Microsoft throttles profile calls hardest, and a throttled refresh
   *  falls back to the stale copy while one is retained. */
  profile: { fresh: 12 * HOUR, retain: 48 * HOUR },
  clips: {
    /** Fresh until this long before the earliest media URL in the list expires. */
    expiryMargin: 5 * MINUTE,
    /** Used when a list holds no media URLs at all (e.g. a player with no clips). */
    freshWithoutMedia: 55 * MINUTE,
    retain: 6 * HOUR,
  },
  /** Metadata is kept past deletion so an expired share link can answer 410, not 404. */
  clipMetadata: { retainPastDeletion: 30 * DAY },
  /** Career facts change slowly; the source can be about 1 MB, so fetch it at most daily. */
  career: { fresh: 24 * HOUR, retain: 7 * DAY },
  /** The same for every visitor, so one upstream call per window serves all traffic. */
  mostPlayed: { fresh: 6 * HOUR, retain: 7 * DAY },
  /** Store screenshots barely change; only the parsed list (a few KB) is stored. */
  screenshots: { fresh: 7 * DAY, retain: 30 * DAY },
  /** Upper bound on upstream pages walked to find one clip, to protect the shared budget. */
  maxPagesPerClipLookup: 5,
} as const;

export const keys = {
  xuid: (gamertag: string) => `xuid:${gamertag.toLowerCase()}`,
  // v2: profiles gained bio, location, tenure and reputation. Entries cached in
  // the old shape are ignored rather than served without them.
  profile: (xuid: string) => `profile:v2:${xuid}`,
  clips: (xuid: string) => `clips:${xuid}`,
  clip: (xuid: string, clipId: string) => `clip:${xuid}:${clipId}`,
  mostPlayed: () => 'games:most-played',
  // v2: facts from the most recent 100 games, without platforms.
  career: (xuid: string) => `career:v2:${xuid}`,
  screenshots: (productId: string) => `screenshots:${productId}`,
};

export interface PlayerClips {
  xuid: string;
  access: ClipPage['access'];
  total: number;
  clips: GameClipInfo[];
}

/**
 * Orchestrates provider calls and caching. One instance per request: it carries
 * the request's API key and clock.
 */
export class ClipService {
  constructor(
    private readonly provider: IXboxDataProvider,
    private readonly cache: Cache,
    private readonly apiKey: string,
    private readonly now: () => number,
  ) {}

  async resolveXuid(id: PlayerIdentifier): Promise<string> {
    if (id.kind === 'xuid') return id.xuid;
    const xuid = await this.cache.readThrough(keys.xuid(id.gamertag), async () => {
      const found = await this.provider.resolveGamertag(this.apiKey, id.gamertag);
      if (!found) return null;
      const now = this.now();
      return { value: found, freshUntil: now + POLICY.xuid.fresh, retainUntil: now + POLICY.xuid.retain };
    });
    if (!xuid) throw new AppError('PLAYER_NOT_FOUND');
    return xuid;
  }

  async getProfile(id: PlayerIdentifier): Promise<XboxUserProfile> {
    const xuid = await this.resolveXuid(id);
    const profile = await this.cache.readThrough(keys.profile(xuid), async () => {
      const found = await this.provider.getProfile(this.apiKey, xuid);
      if (!found) return null;
      const now = this.now();
      return { value: found, freshUntil: now + POLICY.profile.fresh, retainUntil: now + POLICY.profile.retain };
    });
    if (!profile) throw new AppError('PLAYER_NOT_FOUND');
    return profile;
  }

  /** The cached list is never limited; `limit` slices on the way out (PLAN-v1.md §3). */
  async getClips(id: PlayerIdentifier, limit: number): Promise<PlayerClips> {
    const xuid = await this.resolveXuid(id);
    const page = await this.firstPage(xuid);
    return { xuid, access: page.access, total: page.clips.length, clips: page.clips.slice(0, limit) };
  }

  /**
   * One clip with a playable URL (PLAN-v1.md §5, "Resolving a clip for playback").
   * Records the clip's metadata on first sight, for link previews and 410s.
   */
  async getClip(xuid: string, clipId: string): Promise<GameClipInfo> {
    const clip = await this.findClip(xuid, clipId);
    if (!clip) throw await this.missingClipError(xuid, clipId);
    if (!(await this.cache.read(keys.clip(xuid, clipId)))) await this.storeMetadata(clip);
    return clip;
  }

  /** Metadata for a link preview: from cache when possible, else via a full lookup. */
  async getClipMetadata(xuid: string, clipId: string): Promise<ClipMetadata> {
    const cached = await this.cache.read<ClipMetadata>(keys.clip(xuid, clipId));
    if (cached) {
      if (Date.parse(cached.value.availableUntil) <= this.now()) throw new AppError('CLIP_EXPIRED');
      return cached.value;
    }
    return toMetadata(await this.getClip(xuid, clipId));
  }

  /**
   * Career facts for the player page. Wrapped so a hidden history (null) is
   * cached too, rather than refetched on every visit.
   */
  async getCareer(id: PlayerIdentifier): Promise<{ xuid: string; stats: CareerStats | null }> {
    const xuid = await this.resolveXuid(id);
    const entry = await this.cache.readThrough(keys.career(xuid), async () => {
      const stats = await this.provider.getCareerStats(this.apiKey, xuid);
      const now = this.now();
      return { value: { stats }, freshUntil: now + POLICY.career.fresh, retainUntil: now + POLICY.career.retain };
    });
    return { xuid, stats: entry!.stats };
  }

  async getMostPlayed(): Promise<Game[]> {
    const games = await this.cache.readThrough(keys.mostPlayed(), async () => {
      const fetched = await this.provider.getMostPlayedGames(this.apiKey);
      const now = this.now();
      return { value: fetched, freshUntil: now + POLICY.mostPlayed.fresh, retainUntil: now + POLICY.mostPlayed.retain };
    });
    return games!;
  }

  /** One game from the cached ranking, for the game page. Costs no extra upstream call. */
  async getGame(productId: string): Promise<Game> {
    const game = (await this.getMostPlayed()).find((g) => g.productId === productId);
    if (!game) throw new AppError('GAME_NOT_FOUND');
    return game;
  }

  /**
   * Store screenshots for a game on the most-played ranking. Other products are
   * refused before any upstream call, so arbitrary ids can't spend the budget.
   */
  async getScreenshots(productId: string): Promise<Screenshot[]> {
    await this.getGame(productId);
    const shots = await this.cache.readThrough(keys.screenshots(productId), async () => {
      const fetched = await this.provider.getScreenshots(this.apiKey, productId);
      const now = this.now();
      return { value: fetched, freshUntil: now + POLICY.screenshots.fresh, retainUntil: now + POLICY.screenshots.retain };
    });
    return shots!;
  }

  private async firstPage(xuid: string): Promise<ClipPage> {
    const page = await this.cache.readThrough(
      keys.clips(xuid),
      async () => {
        const fetched = await this.provider.getClips(this.apiKey, xuid);
        return { value: fetched, freshUntil: this.clipsFreshUntil(fetched), retainUntil: this.now() + POLICY.clips.retain };
      },
      (stale) => this.withoutExpiredMedia(stale),
    );
    // The loader never returns null, so neither does readThrough here.
    return page!;
  }

  private async findClip(xuid: string, clipId: string): Promise<GameClipInfo | null> {
    const first = await this.firstPage(xuid);
    const hit = first.clips.find((c) => c.clipId === clipId);
    if (hit) return hit;

    // Older clips sit on later pages. These pages are not cached: only the first
    // page backs the player's shelf, and the walk is bounded.
    let token = first.continuationToken;
    for (let pages = 1; token && pages < POLICY.maxPagesPerClipLookup; pages++) {
      const page = await this.provider.getClips(this.apiKey, xuid, token);
      const found = page.clips.find((c) => c.clipId === clipId);
      if (found) return found;
      token = page.continuationToken;
    }
    return null;
  }

  private async missingClipError(xuid: string, clipId: string): Promise<AppError> {
    const known = await this.cache.read<ClipMetadata>(keys.clip(xuid, clipId));
    if (known && Date.parse(known.value.availableUntil) <= this.now()) return new AppError('CLIP_EXPIRED');
    return new AppError('CLIP_NOT_FOUND');
  }

  private async storeMetadata(clip: GameClipInfo): Promise<void> {
    const deletion = Date.parse(clip.availableUntil);
    const retainUntil = deletion + POLICY.clipMetadata.retainPastDeletion;
    if (retainUntil <= this.now()) return;
    await this.cache.write(keys.clip(clip.xuid, clip.clipId), toMetadata(clip), deletion, retainUntil);
  }

  /** Fresh until shortly before the earliest URL expires, so no cached URL is served dead. */
  private clipsFreshUntil(page: ClipPage): number {
    const expiries = page.clips.flatMap((c) => (c.media ? [Date.parse(c.media.expiresAt)] : []));
    if (expiries.length === 0) return this.now() + POLICY.clips.freshWithoutMedia;
    return Math.min(...expiries) - POLICY.clips.expiryMargin;
  }

  /** A stale list may be served for its metadata, but never with a dead media URL (PLAN-v1.md §3). */
  private withoutExpiredMedia(page: ClipPage): ClipPage {
    const now = this.now();
    return {
      ...page,
      clips: page.clips.map((c) => (c.media && Date.parse(c.media.expiresAt) <= now ? { ...c, media: null } : c)),
    };
  }
}
