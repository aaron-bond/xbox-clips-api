/**
 * Domain types. Everything outside src/provider/ works with these, never with
 * raw OpenXBL payloads (PLAN-v1.md §3, provider seam).
 */

/** Xbox's player reputation tiers: Good Player, Needs Work, Avoid Me. */
export type Reputation = 'good' | 'needs-work' | 'avoid';

export interface XboxUserProfile {
  xuid: string;
  gamertag: string;
  gamerscore: number;
  gamerpicUrl: string | null;
  /** Player-written; null when empty, which is common. */
  bio: string | null;
  location: string | null;
  /**
   * The profile's TenureLevel. Undocumented; read as years of Xbox network
   * membership, which real values support (PLAN-v1.md §2).
   */
  tenureYears: number | null;
  reputation: Reputation | null;
}

/**
 * The parts of a clip that never change for its lifetime, so they can be cached
 * until Xbox deletes it. Deliberately excludes the media URL (expires hourly)
 * and view counts (drift).
 */
export interface ClipMetadata {
  clipId: string;
  xuid: string;
  gameTitle: string;
  titleId: number | null;
  caption: string;
  durationSeconds: number;
  recordedAt: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  /** Estimate: Xbox deletes clips about 90 days after upload, and publishes no exact time. */
  availableUntil: string;
}

export interface ClipMedia {
  url: string;
  /** From the upstream `expiration` field. The URL must not be served past this. */
  expiresAt: string;
}

export interface GameClipInfo extends ClipMetadata {
  views: number;
  /** Null when no playable URL is currently held, e.g. a stale entry whose URL has expired. */
  media: ClipMedia | null;
}

/**
 * Whether the player's clips are visible to the service's key. 'restricted'
 * means capture privacy hides them, which is distinct from having no clips.
 */
export type ClipsAccess = 'public' | 'restricted';

export interface ClipPage {
  clips: GameClipInfo[];
  continuationToken: string | null;
  access: ClipsAccess;
}

/**
 * A game from the Xbox Store's most-played ranking. Image URLs are Microsoft
 * Store image URLs, which resize by query string (`?w=640`); the originals are
 * very large, so clients always request a size.
 */
export interface Game {
  productId: string;
  /** 1-based, after duplicate titles are merged. */
  rank: number;
  title: string;
  genres: string[];
  developer: string | null;
  publisher: string | null;
  releaseDate: string | null;
  /** 0-5 average and its number of ratings. Few ratings make the average unreliable. */
  rating: number | null;
  ratingCount: number;
  /** Store platform codes, e.g. XboxSeriesX, XboxOne, PC, XCloud, Handheld. */
  platforms: string[];
  description: string;
  heroImageUrl: string | null;
  boxArtUrl: string | null;
}

/**
 * A store screenshot of a game. `url` is a Microsoft Store image URL; the
 * originals are up to 4K, so clients always request a size (`?w=1280`).
 */
export interface Screenshot {
  url: string;
  /** The store's description of the image, when it has one. Good alt text. */
  caption: string | null;
  width: number;
  height: number;
}

/** One game in a player's career facts. */
export interface CareerGame {
  titleId: string;
  name: string;
  /** Store image URL; resizes by query string (`?w=`). */
  imageUrl: string | null;
  gamerscore: number;
  totalGamerscore: number;
  /** 0-100. */
  percent: number;
  lastPlayed: string | null;
}

/**
 * Facts derived from a player's most recent games (PLAN-v1.md §5). Only these
 * are cached; the raw history (up to about 1 MB) is read once and discarded.
 */
export interface CareerStats {
  /** The most recently played game. */
  nowPlaying: CareerGame | null;
  /** The game with the most gamerscore earned, among the recent games. */
  biggestHaul: CareerGame | null;
  /** The recent game nearest to 100% without being complete. */
  onTheBrink: CareerGame | null;
  /** Games the facts were computed from: at most CAREER_GAMES. */
  gamesCounted: number;
  /** True when the player has more games than were read, so the facts cover only the most recent. */
  limited: boolean;
}

/** Strips the fields that change, leaving what is safe to cache until deletion. */
export function toMetadata(clip: GameClipInfo): ClipMetadata {
  const { views: _views, media: _media, ...metadata } = clip;
  return metadata;
}
