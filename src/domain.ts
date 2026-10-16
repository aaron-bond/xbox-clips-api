/**
 * Domain types. Everything outside src/provider/ works with these, never with
 * raw OpenXBL payloads (PLAN-v1.md §3, provider seam).
 */

export interface XboxUserProfile {
  xuid: string;
  gamertag: string;
  gamerscore: number;
  gamerpicUrl: string | null;
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

/** Strips the fields that change, leaving what is safe to cache until deletion. */
export function toMetadata(clip: GameClipInfo): ClipMetadata {
  const { views: _views, media: _media, ...metadata } = clip;
  return metadata;
}
