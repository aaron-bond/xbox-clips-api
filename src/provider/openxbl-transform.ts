import type { CareerGame, CareerStats, ClipPage, Game, GameClipInfo, Reputation, XboxUserProfile } from '../domain';

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
  devices?: string[];
  displayImage?: string;
  achievement?: { currentGamerscore?: number; totalGamerscore?: number; progressPercentage?: number };
  titleHistory?: { lastTimePlayed?: string };
}
export interface RawTitleHistory {
  titles?: RawTitle[];
}

/** Xbox returns at most this many titles; a full list means older ones are cut off. */
export const TITLE_HISTORY_LIMIT = 1000;

/** Store platform codes to names, oldest generation first. Other devices are not counted. */
const PLATFORMS: [string, string[]][] = [
  ['Xbox 360', ['Xbox360']],
  ['Xbox One', ['XboxOne']],
  ['Xbox Series X|S', ['XboxSeries']],
  ['PC', ['PC', 'Win32']],
];

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
 * The four history-based career facts (PLAN-v1.md §5). Games only; apps are
 * left out. "On the brink" ignores completed games and games with no
 * gamerscore earned, and breaks ties toward the bigger game.
 */
export function toCareerStats(raw: RawTitleHistory): CareerStats {
  const all = raw.titles ?? [];
  const games = all.filter((t) => t.name && (t.type ?? 'Game') === 'Game');
  const time = (t: RawTitle) => Date.parse(t.titleHistory?.lastTimePlayed ?? '') || 0;
  const earned = (t: RawTitle) => t.achievement?.currentGamerscore ?? 0;
  const total = (t: RawTitle) => t.achievement?.totalGamerscore ?? 0;

  const recent = best(games.filter((t) => time(t) > 0), time);
  const haul = best(games.filter((t) => earned(t) > 0), earned);
  const brink = best(
    games.filter((t) => total(t) > 0 && earned(t) > 0 && earned(t) < total(t)),
    (t) => (t.achievement?.progressPercentage ?? 0) * 100_000 + total(t),
  );

  const platforms = PLATFORMS.map(([platform, codes]) => ({
    platform,
    games: games.filter((t) => (t.devices ?? []).some((d) => codes.includes(d))).length,
  })).filter((p) => p.games > 0);

  return {
    nowPlaying: recent ? toCareerGame(recent) : null,
    biggestHaul: haul ? toCareerGame(haul) : null,
    onTheBrink: brink ? toCareerGame(brink) : null,
    platforms,
    gamesCounted: games.length,
    capped: all.length >= TITLE_HISTORY_LIMIT,
  };
}
