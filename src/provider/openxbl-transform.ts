import type { ClipPage, GameClipInfo, XboxUserProfile } from '../domain';

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

export function toProfile(raw: RawAccount): XboxUserProfile | null {
  const user = raw.profileUsers?.[0];
  if (!user?.id) return null;
  const settings = new Map((user.settings ?? []).map((s) => [s.id, s.value]));
  const gamertag = settings.get('Gamertag') ?? settings.get('ModernGamertag');
  if (!gamertag) return null;
  const gamerscore = Number(settings.get('Gamerscore'));
  return {
    xuid: user.id,
    gamertag,
    gamerscore: Number.isFinite(gamerscore) ? gamerscore : 0,
    gamerpicUrl: settings.get('GameDisplayPicRaw') || null,
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
