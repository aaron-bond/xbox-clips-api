import type { Achievement, CareerGame, CareerStats, ClipPage, Game, GameClipInfo, PlayerGame, Reputation, Screenshot, XboxUserProfile } from '../domain';

/**
 * Raw OpenXBL payload shapes, as observed in live responses on 2026-10-16
 * (PLAN-v1.md §2). The OpenAPI spec documents none of them, so every field is
 * optional and read defensively. Enum fields arrive as integers and are not
 * relied on.
 */

export interface RawSearchPerson {
  xuid?: string;
  gamertag?: string;
  modernGamertag?: string;
  uniqueModernGamertag?: string;
}
export interface RawSearch {
  people?: RawSearchPerson[];
}

export interface RawAccount {
  profileUsers?: { id?: string; settings?: { id?: string; value?: string }[] }[];
}

export interface RawClipUri {
  uri?: string;
  uriType?: number;
  expiration?: string;
}
export interface RawThumbnail {
  uri?: string;
  thumbnailType?: number;
}
export interface RawClip {
  gameClipId?: string;
  xuid?: string;
  titleName?: string;
  titleId?: number;
  userCaption?: string;
  clipName?: string;
  durationInSeconds?: number;
  dateRecorded?: string;
  datePublished?: string;
  views?: number;
  thumbnails?: RawThumbnail[];
  gameClipUris?: RawClipUri[];
}
export interface RawClipList {
  gameClips?: RawClip[];
  pagingInfo?: { continuationToken?: string | null };
}

/** Xbox deletes uploaded clips about 90 days after upload. */
export const CLIP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Picks the XUID whose gamertag matches exactly (case-insensitive). Search is
 * fuzzy and returns near matches for gamertags that do not exist, so taking the
 * first result would silently show the wrong player.
 */
export function pickSearchMatch(raw: RawSearch, gamertag: string): string | null {
  const wanted = gamertag.toLowerCase();
  const match = raw.people?.find((p) =>
    [p.gamertag, p.modernGamertag, p.uniqueModernGamertag].some((g) => g?.toLowerCase() === wanted),
  );
  return match?.xuid ?? null;
}

const REPUTATIONS: Record<string, Reputation> = { GoodPlayer: 'good', NeedsWork: 'needs-work', AvoidMe: 'avoid' };

export function toProfile(raw: RawAccount): XboxUserProfile | null {
  const user = raw.profileUsers?.[0];
  if (!user?.id) return null;
  const settings = new Map((user.settings ?? []).map((s) => [s.id, s.value]));
  const gamertag = settings.get('Gamertag') ?? settings.get('ModernGamertag');
  if (!gamertag) return null;
  const gamerscore = Number(settings.get('Gamerscore'));
  const tenure = Number(settings.get('TenureLevel'));
  return {
    xuid: user.id,
    gamertag,
    gamerscore: Number.isFinite(gamerscore) ? gamerscore : 0,
    gamerpicUrl: settings.get('GameDisplayPicRaw') || null,
    bio: settings.get('Bio')?.trim() || null,
    location: settings.get('Location')?.trim() || null,
    tenureYears: settings.has('TenureLevel') && Number.isInteger(tenure) && tenure >= 0 ? tenure : null,
    reputation: REPUTATIONS[settings.get('XboxOneRep') ?? ''] ?? null,
  };
}

export function toClip(raw: RawClip): GameClipInfo | null {
  if (!raw.gameClipId || !raw.xuid) return null;
  const publishedAt = raw.datePublished ?? raw.dateRecorded;
  if (!publishedAt) return null;

  // Prefer the progressive MP4, which a <video> element plays directly. uriType is
  // an undocumented integer, so match on the file extension instead.
  const uris = (raw.gameClipUris ?? []).filter((u) => u.uri);
  const media = uris.find((u) => /\.mp4$/i.test(u.uri!.split('?')[0]!)) ?? uris[0];

  // The two thumbnail entries observed share one URI; take the higher type if they ever differ.
  const thumbnail = [...(raw.thumbnails ?? [])]
    .filter((t) => t.uri)
    .sort((a, b) => (b.thumbnailType ?? 0) - (a.thumbnailType ?? 0))[0];

  return {
    clipId: raw.gameClipId.toLowerCase(),
    xuid: raw.xuid,
    gameTitle: raw.titleName ?? '',
    titleId: raw.titleId ?? null,
    caption: raw.userCaption || raw.clipName || '',
    durationSeconds: raw.durationInSeconds ?? 0,
    recordedAt: raw.dateRecorded ?? publishedAt,
    publishedAt,
    thumbnailUrl: thumbnail?.uri ?? null,
    availableUntil: new Date(Date.parse(publishedAt) + CLIP_RETENTION_MS).toISOString(),
    views: raw.views ?? 0,
    media: media?.uri && media.expiration ? { url: media.uri, expiresAt: media.expiration } : null,
  };
}

export function toClipPage(raw: RawClipList): ClipPage {
  return {
    clips: (raw.gameClips ?? []).map(toClip).filter((c): c is GameClipInfo => c !== null),
    continuationToken: raw.pagingInfo?.continuationToken || null,
    access: 'public',
  };
}

export interface RawStoreImage {
  url?: string;
}
export interface RawProductSummary {
  productId?: string;
  title?: string;
  categories?: string[];
  developerName?: string;
  publisherName?: string;
  releaseDate?: string;
  averageRating?: number;
  ratingCount?: number;
  availableOn?: string[];
  shortDescription?: string;
  description?: string;
  images?: { superHeroArt?: RawStoreImage; boxArt?: RawStoreImage; poster?: RawStoreImage };
}
export interface RawMostPlayed {
  channels?: Record<string, { products?: { productId?: string }[] }>;
  productSummaries?: RawProductSummary[];
}

/** Below this length a short description is a tagline, not a description. */
const MIN_SHORT_DESCRIPTION = 80;
const MAX_DESCRIPTION = 600;

/**
 * The store's short description when it says something, else the opening of
 * the full description, cut at a sentence end.
 */
export function pickDescription(short: string | undefined, full: string | undefined): string {
  const s = (short ?? '').trim();
  if (s.length >= MIN_SHORT_DESCRIPTION || !full) return s;
  const f = full.trim();
  if (f.length <= MAX_DESCRIPTION) return f;
  const cut = f.slice(0, MAX_DESCRIPTION);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return (end > MAX_DESCRIPTION / 2 ? cut.slice(0, end + 1) : cut.trimEnd() + '…').trim();
}

/**
 * The ranking, in channel order. Editions and platform versions are separate
 * store products; identical titles are merged, keeping the best rank. The Xbox
 * title ID cannot do this: most products lack one, and unrelated games that
 * share a launcher share one (PLAN-v1.md §2).
 */
export function toMostPlayed(raw: RawMostPlayed): Game[] {
  const channel = Object.values(raw.channels ?? {})[0];
  const byId = new Map((raw.productSummaries ?? []).map((p) => [p.productId, p]));
  const order = channel?.products?.map((p) => p.productId) ?? (raw.productSummaries ?? []).map((p) => p.productId);

  const seen = new Set<string>();
  const games: Game[] = [];
  for (const id of order) {
    const p = id ? byId.get(id) : undefined;
    if (!p?.productId || !p.title) continue;
    const key = p.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    games.push({
      productId: p.productId,
      rank: games.length + 1,
      title: p.title.trim(),
      genres: p.categories ?? [],
      developer: p.developerName || null,
      publisher: p.publisherName || null,
      releaseDate: p.releaseDate || null,
      rating: typeof p.averageRating === 'number' && (p.ratingCount ?? 0) > 0 ? p.averageRating : null,
      ratingCount: p.ratingCount ?? 0,
      platforms: p.availableOn ?? [],
      description: pickDescription(p.shortDescription, p.description),
      heroImageUrl: p.images?.superHeroArt?.url ?? null,
      boxArtUrl: p.images?.boxArt?.url ?? p.images?.poster?.url ?? null,
    });
  }
  return games;
}

export interface RawTitle {
  titleId?: string;
  name?: string;
  type?: string;
  displayImage?: string;
  /** e.g. ["XboxSeries"], ["XboxOne", "XboxSeries"], ["Xbox360"], ["PC"]. */
  devices?: string[];
  achievement?: { currentAchievements?: number; currentGamerscore?: number; totalGamerscore?: number; progressPercentage?: number };
  titleHistory?: { lastTimePlayed?: string };
}

/**
 * How many of a player's most recent games the career facts read. Title
 * history arrives newest first and can be about 1 MB; parsing all of it
 * exceeded the Workers free plan's 10 ms CPU for heavy players, while the
 * first 100 games parse in a fraction of that (PLAN-v1.md §5).
 */
export const CAREER_GAMES = 100;

/**
 * Reads the start of a title-history response as it arrives, and stops at the
 * end of its `limit`-th title. The history is newest first and can be about
 * 1 MB, so stopping early saves both CPU (only the first part is ever decoded
 * and parsed) and waiting time (PLAN-v1.md §5).
 *
 * Feed it text with push(); once `done` is true, stop reading. If the body ends
 * first, call end(). It finds where each entry ends by counting braces,
 * tracking strings and escapes so braces inside names don't count.
 */
export class TitlesScanner {
  /** Everything received so far: kept so the finished slice can be parsed. */
  text = '';
  private open = -1;
  private pos = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private count = 0;
  private end = -1;
  private hasMore: boolean | null = null;

  constructor(private readonly limit: number) {}

  /** True once enough has been read: stop reading the body. */
  get done(): boolean {
    return this.hasMore !== null;
  }

  push(chunk: string): void {
    if (this.done) return;
    this.text += chunk;
    if (this.open < 0) {
      const key = this.text.indexOf('"titles"');
      const bracket = key < 0 ? -1 : this.text.indexOf('[', key);
      if (bracket < 0) return;
      this.open = bracket;
      this.pos = bracket + 1;
    }
    this.scan();
  }

  /** The body has ended without `done`: settle on what was read. */
  finish(): void {
    if (this.end >= 0 && this.hasMore === null) this.hasMore = false;
  }

  /** The titles read, and whether the history has more after them. */
  result(): { titles: RawTitle[]; more: boolean } {
    if (this.open < 0 || this.end < 0) return { titles: [], more: false };
    const titles = JSON.parse(`[${this.text.slice(this.open + 1, this.end + 1)}]`) as RawTitle[];
    return { titles, more: this.hasMore === true };
  }

  private scan(): void {
    const t = this.text;
    let i = this.pos;
    // After the last wanted entry, look for the next significant character.
    if (this.end >= 0) {
      while (i < t.length && /\s/.test(t[i]!)) i++;
      if (i < t.length) this.hasMore = t[i] === ',';
      this.pos = i;
      return;
    }
    for (; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === 92 /* \\ */) this.escaped = true;
        else if (c === 34 /* " */) this.inString = false;
        continue;
      }
      if (c === 34) this.inString = true;
      else if (c === 123 /* { */) this.depth++;
      else if (c === 125 /* } */) {
        this.depth--;
        if (this.depth === 0 && ++this.count === this.limit) {
          this.end = i;
          this.pos = i + 1;
          this.scan();
          return;
        }
      } else if (c === 93 /* ] */ && this.depth === 0) {
        // The array closed before the limit: the whole history has been read.
        // The slice runs to just before the bracket; whitespace there is harmless.
        this.end = this.count > 0 ? i - 1 : -1;
        this.hasMore = false;
        this.pos = i + 1;
        return;
      }
    }
    this.pos = i;
  }
}

/** The first `limit` titles of a complete raw title-history response. */
export function firstTitles(raw: string, limit: number): { titles: RawTitle[]; more: boolean } {
  const scanner = new TitlesScanner(limit);
  scanner.push(raw);
  if (!scanner.done) scanner.finish();
  return scanner.result();
}

function toCareerGame(t: RawTitle): CareerGame {
  const a = t.achievement ?? {};
  return {
    titleId: t.titleId ?? '',
    name: t.name ?? '',
    // Image URLs arrive as http://; the same host serves https.
    imageUrl: t.displayImage ? t.displayImage.replace(/^http:/, 'https:') : null,
    gamerscore: a.currentGamerscore ?? 0,
    totalGamerscore: a.totalGamerscore ?? 0,
    percent: a.progressPercentage ?? 0,
    lastPlayed: t.titleHistory?.lastTimePlayed ?? null,
  };
}

function best<T>(items: T[], score: (x: T) => number): T | null {
  let top: T | null = null;
  let topScore = -Infinity;
  for (const x of items) {
    const s = score(x);
    if (s > topScore) {
      top = x;
      topScore = s;
    }
  }
  return top;
}

/**
 * The career facts from a player's most recent games (PLAN-v1.md §5). Games
 * only; apps are left out. "On the brink" ignores completed games and games
 * with no gamerscore earned, and breaks ties toward the bigger game.
 */
const isGame = (t: RawTitle) => !!t.name && (t.type ?? 'Game') === 'Game';

/** The recent games themselves, newest first, for the player's achievements page. */
export function toPlayerGames(titles: RawTitle[]): PlayerGame[] {
  return titles.filter(isGame).map((t) => ({
    ...toCareerGame(t),
    unlocked: t.achievement?.currentAchievements ?? 0,
    xbox360: (t.devices ?? []).includes('Xbox360'),
  }));
}

export function toCareerStats(titles: RawTitle[], limited: boolean): CareerStats {
  const games = titles.filter(isGame);
  const time = (t: RawTitle) => Date.parse(t.titleHistory?.lastTimePlayed ?? '') || 0;
  const earned = (t: RawTitle) => t.achievement?.currentGamerscore ?? 0;
  const total = (t: RawTitle) => t.achievement?.totalGamerscore ?? 0;

  const recent = best(games.filter((t) => time(t) > 0), time);
  const haul = best(games.filter((t) => earned(t) > 0), earned);
  const brink = best(
    games.filter((t) => total(t) > 0 && earned(t) > 0 && earned(t) < total(t)),
    (t) => (t.achievement?.progressPercentage ?? 0) * 100_000 + total(t),
  );

  return {
    nowPlaying: recent ? toCareerGame(recent) : null,
    biggestHaul: haul ? toCareerGame(haul) : null,
    onTheBrink: brink ? toCareerGame(brink) : null,
    gamesCounted: games.length,
    limited,
  };
}

/**
 * `POST /v2/marketplace/details` with body `{ "products": "<productId>" }`,
 * observed 2026-10-18. About 100 KB per product. Images sit at
 * `Products[].LocalizedProperties[0].Images[]`; screenshots have
 * `ImagePurpose: "Screenshot"`. Each is usually listed twice, once per
 * `ImagePositionInfo` (`Desktop/1`, `Xbox/1`, …) with the same `Uri`. `Uri` is
 * protocol-relative (`//store-images…`). `Caption` may be null or empty.
 */
export interface RawStoreDetailImage {
  ImagePurpose?: string;
  Uri?: string;
  Width?: number;
  Height?: number;
  Caption?: string | null;
}
export interface RawStoreDetails {
  Products?: { ProductId?: string; LocalizedProperties?: { Images?: RawStoreDetailImage[] }[] }[];
}

/** Upper bound on stored screenshots per game; the store has listed 23 for one game. */
export const MAX_SCREENSHOTS = 30;

/** The product's store screenshots, in store order, each once. */
export function toScreenshots(raw: RawStoreDetails, productId: string): Screenshot[] {
  const product = raw.Products?.find((p) => p.ProductId?.toUpperCase() === productId) ?? raw.Products?.[0];
  const seen = new Set<string>();
  const shots: Screenshot[] = [];
  for (const img of product?.LocalizedProperties?.[0]?.Images ?? []) {
    if (img.ImagePurpose !== 'Screenshot' || !img.Uri) continue;
    const url = img.Uri.startsWith('//') ? `https:${img.Uri}` : img.Uri;
    if (!url.startsWith('https://') || seen.has(url)) continue;
    seen.add(url);
    shots.push({ url, caption: img.Caption?.trim() || null, width: img.Width ?? 0, height: img.Height ?? 0 });
    if (shots.length === MAX_SCREENSHOTS) break;
  }
  return shots;
}

/**
 * Achievements, from two upstream shapes (observed 2026-10-18):
 *
 * - `GET /v2/achievements/player/{xuid}/{titleId}` for current games: every
 *   achievement, with `progressState` (`Achieved`, `InProgress`, `NotStarted`),
 *   `progression.timeUnlocked`, `progression.requirements[0].current/target`
 *   (strings), a 16:9 image in `mediaAssets[type=Icon].url`, gamerscore in
 *   `rewards[type=Gamerscore].value` (a string), `rarity`, `isSecret` (the
 *   description is sent regardless) and the game name in
 *   `titleAssociations[0].name`. About 60 KB for 49 achievements.
 * - `GET /v2/achievements/x360/{xuid}/title/{titleId}` for Xbox 360 games:
 *   only the achievements the player has unlocked, each with `unlocked`,
 *   `timeUnlocked`, a numeric `gamerscore`, `rarity` and an `imageId` but no
 *   image URL.
 */
export interface RawAchievement {
  id?: string | number;
  name?: string;
  description?: string;
  lockedDescription?: string;
  isSecret?: boolean;
  progressState?: string;
  progression?: { requirements?: { current?: string; target?: string }[]; timeUnlocked?: string };
  mediaAssets?: { type?: string; url?: string }[];
  rewards?: { type?: string; value?: string }[];
  rarity?: { currentCategory?: string; currentPercentage?: number };
  titleAssociations?: { name?: string }[];
  unlocked?: boolean;
  timeUnlocked?: string;
  gamerscore?: number;
}
export interface RawAchievementList {
  achievements?: RawAchievement[];
}

const rarityOf = (r: RawAchievement) =>
  r.rarity?.currentCategory && typeof r.rarity.currentPercentage === 'number'
    ? { category: r.rarity.currentCategory, percent: r.rarity.currentPercentage }
    : null;

function toCurrentAchievement(r: RawAchievement): Achievement {
  const achieved = r.progressState === 'Achieved';
  const req = r.progression?.requirements?.[0];
  const current = Number(req?.current);
  const target = Number(req?.target);
  return {
    id: String(r.id ?? ''),
    name: r.name ?? '',
    description: (achieved ? r.description : r.lockedDescription || r.description) ?? '',
    gamerscore: Number(r.rewards?.find((x) => x.type === 'Gamerscore')?.value) || 0,
    imageUrl: r.mediaAssets?.find((m) => m.type === 'Icon')?.url ?? null,
    secret: r.isSecret === true,
    unlockedAt: achieved ? (r.progression?.timeUnlocked ?? null) : null,
    progress:
      r.progressState === 'InProgress' && Number.isFinite(current) && target > 1 ? { current: Math.min(current, target), target } : null,
    rarity: rarityOf(r),
  };
}

function toX360Achievement(r: RawAchievement): Achievement {
  return {
    id: String(r.id ?? ''),
    name: r.name ?? '',
    description: (r.unlocked ? r.description : r.lockedDescription || r.description) ?? '',
    gamerscore: r.gamerscore ?? 0,
    imageUrl: null,
    secret: r.isSecret === true,
    unlockedAt: r.unlocked ? (r.timeUnlocked ?? null) : null,
    progress: null,
    rarity: rarityOf(r),
  };
}

export function toAchievements(raw: RawAchievementList, xbox360: boolean): { titleName: string | null; achievements: Achievement[] } {
  const list = (raw.achievements ?? []).filter((r) => r.name);
  return {
    titleName: list[0]?.titleAssociations?.[0]?.name ?? null,
    achievements: list.map(xbox360 ? toX360Achievement : toCurrentAchievement),
  };
}

/**
 * `POST /v2/player/stats` with body `{ xuids, stats: [{ name, titleId }] }`,
 * observed 2026-10-18: `statlistscollection[].stats[]` holds one entry per
 * player and stat, e.g. `{ xuid, titleid, name: "MinutesPlayed", type:
 * "Integer", value: "2019" }` (the value is a string). Works for any player.
 * For an Xbox 360 game the collection is empty.
 */
export interface RawPlayerStats {
  statlistscollection?: { stats?: { xuid?: string; name?: string; value?: string }[] }[];
}

/** Minutes played per XUID; players Xbox reports nothing for are left out. */
export function toMinutesPlayed(raw: RawPlayerStats): Record<string, number> {
  const out: Record<string, number> = {};
  for (const list of raw.statlistscollection ?? []) {
    for (const stat of list.stats ?? []) {
      const minutes = Number(stat.value);
      if (stat.name === 'MinutesPlayed' && stat.xuid && Number.isFinite(minutes) && minutes >= 0) out[stat.xuid] = minutes;
    }
  }
  return out;
}
