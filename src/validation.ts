import { AppError } from './errors';

export type PlayerIdentifier = { kind: 'xuid'; xuid: string } | { kind: 'gamertag'; gamertag: string };

// XUIDs are 64-bit integers rendered in decimal, so at most 20 digits.
const XUID = /^\d{1,20}$/;
// Letters (any script), digits and inner spaces, up to 15 characters, optionally
// followed by a modern-gamertag suffix such as "#1234".
const GAMERTAG = /^[\p{L}\p{N}](?:[\p{L}\p{N} ]{0,13}[\p{L}\p{N}])?(?:#\d{1,5})?$/u;
const CLIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identifiers are interpolated into cache keys and upstream URLs, so they are
 * validated before use (PLAN-v1.md §3). An all-digit identifier is an XUID.
 */
export function parsePlayerIdentifier(raw: string): PlayerIdentifier {
  if (XUID.test(raw)) return { kind: 'xuid', xuid: raw };
  if (GAMERTAG.test(raw)) return { kind: 'gamertag', gamertag: raw };
  throw new AppError('INVALID_IDENTIFIER');
}

export function parseXuid(raw: string): string {
  if (!XUID.test(raw)) throw new AppError('INVALID_IDENTIFIER');
  return raw;
}

export function parseClipId(raw: string): string {
  if (!CLIP_ID.test(raw)) throw new AppError('INVALID_IDENTIFIER');
  return raw.toLowerCase();
}

export const DEFAULT_CLIP_LIMIT = 20;
export const MAX_CLIP_LIMIT = 100;

/** `?limit=` is a presentation choice, so bad values fall back rather than fail. */
export function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) return DEFAULT_CLIP_LIMIT;
  return Math.min(n, MAX_CLIP_LIMIT);
}
