import { Cache } from './cache';
import { toMetadata, type CareerStats, type ClipMetadata, type ClipPage, type Game, type GameAchievements, type GameClipInfo, type PlayerGame, type Screenshot, type TitleHistory, type XboxUserProfile } from './domain';
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
  /** Gamerscore should keep up with achievements. Microsoft throttles profile calls
   *  hardest, so a throttled refresh falls back to the stale copy, kept 48 hours. */
  profile: { fresh: 2 * HOUR, retain: 48 * HOUR },
  clips: {
    /** A new clip shows within this long... */
    fresh: 15 * MINUTE,
    /** ...or sooner: never fresh past this long before the earliest media URL expires. */
    expiryMargin: 5 * MINUTE,
    retain: 6 * HOUR,
  },
  /** Metadata is kept past deletion so an expired share link can answer 410, not 404. */
  clipMetadata: { retainPastDeletion: 30 * DAY },
  /** The title history behind career facts and recent games: about 1 MB to read, so two hours. */
  career: { fresh: 2 * HOUR, retain: 7 * DAY },
  /** A player's achievements and playtime in a game change as they play. */
  achievements: { fresh: 15 * MINUTE, retain: 7 * DAY },
  playtime: { fresh: 15 * MINUTE, retain: 7 * DAY },
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
  // v3: the career facts and the recent games they came from, from one read of the
  // title history. v2 held the facts only.
  career: (xuid: string) => `career:v3:${xuid}`,
  achievements: (xuid: string, titleId: string) => `achievements:${xuid}:${titleId}`,
  playtime: (xuid: string, titleId: string) => `playtime:${xuid}:${titleId}`,
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
    return { xuid, stats: (await this.titleHistory(xuid))?.stats ?? null };
  }

  /** The player's recent games, from the same cached read of the title history as the career facts. */
  async getGames(id: PlayerIdentifier): Promise<{ xuid: string; games: PlayerGame[]; limited: boolean }> {
    const xuid = await this.resolveXuid(id);
    const history = await this.titleHistory(xuid);
    return { xuid, games: history?.games ?? [], limited: history?.stats.limited ?? false };
  }

  /**
   * A player's achievements in one game. The recent games say whether it is an
   * Xbox 360 game, which takes a different upstream endpoint; a game outside
   * them is treated as current.
   */
  async getAchievements(id: PlayerIdentifier, titleId: string): Promise<GameAchievements> {
    const xuid = await this.resolveXuid(id);
    const game = (await this.titleHistory(xuid))?.games.find((g) => g.titleId === titleId) ?? null;
    const xbox360 = game?.xbox360 ?? false;
    const entry = await this.cache.readThrough(keys.achievements(xuid, titleId), async () => {
      const fetched = await this.provider.getAchievements(this.apiKey, xuid, titleId, xbox360);
      const now = this.now();
      return { value: fetched, freshUntil: now + POLICY.achievements.fresh, retainUntil: now + POLICY.achievements.retain };
    });
    // Null: the player's achievements aren't visible. Shown as none, like a private reel.
    const found = entry ?? { titleName: null, achievements: [] };
    if (found.achievements.length === 0 && !game) throw new AppError('NOT_FOUND');
    // Secondary: if playtime can't be had, the achievements still are.
    const minutesPlayed = await this.minutesPlayed(xuid, titleId).catch(() => null);
    return { xuid, titleId, game, titleName: found.titleName, lockedListed: !xbox360, minutesPlayed, achievements: found.achievements };
  }

  private async minutesPlayed(xuid: string, titleId: string): Promise<number | null> {
    const entry = await this.cache.readThrough(keys.playtime(xuid, titleId), async () => {
      const fetched = await this.provider.getMinutesPlayed(this.apiKey, [xuid], titleId);
      const now = this.now();
      return { value: { minutes: fetched[xuid] ?? null }, freshUntil: now + POLICY.playtime.fresh, retainUntil: now + POLICY.playtime.retain };
    });
    return entry!.minutes;
  }

  /** One upstream read per player per day serves the career facts, the games list and the 360 lookup. */
  private async titleHistory(xuid: string): Promise<TitleHistory | null> {
    const entry = await this.cache.readThrough(keys.career(xuid), async () => {
      const history = await this.provider.getTitleHistory(this.apiKey, xuid);
      const now = this.now();
      return { value: { history }, freshUntil: now + POLICY.career.fresh, retainUntil: now + POLICY.career.retain };
    });
    return entry!.history;
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
    const window = this.now() + POLICY.clips.fresh;
    if (expiries.length === 0) return window;
    return Math.min(window, Math.min(...expiries) - POLICY.clips.expiryMargin);
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
