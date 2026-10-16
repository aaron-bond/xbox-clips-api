import type { ClipPage, GameClipInfo, XboxUserProfile } from '../src/domain';
import { AppError } from '../src/errors';
import type { IXboxDataProvider } from '../src/provider/types';

/**
 * In-memory provider. Keeps the suite off the network and off the shared
 * rate-limit budget, and counts calls so tests can assert on cache behaviour.
 */
export class FakeProvider implements IXboxDataProvider {
  gamertags = new Map<string, string>();
  profiles = new Map<string, XboxUserProfile>();
  /** Pages per XUID; page N is fetched with continuation token `page-N`. */
  clipPages = new Map<string, ClipPage[]>();
  /** When set, every call throws this. */
  failWith: AppError | null = null;
  calls = { resolveGamertag: 0, getProfile: 0, getClips: 0 };

  async resolveGamertag(_apiKey: string, gamertag: string): Promise<string | null> {
    this.calls.resolveGamertag++;
    this.maybeFail();
    return this.gamertags.get(gamertag.toLowerCase()) ?? null;
  }

  async getProfile(_apiKey: string, xuid: string): Promise<XboxUserProfile | null> {
    this.calls.getProfile++;
    this.maybeFail();
    return this.profiles.get(xuid) ?? null;
  }

  async getClips(_apiKey: string, xuid: string, continuationToken?: string): Promise<ClipPage> {
    this.calls.getClips++;
    this.maybeFail();
    const pages = this.clipPages.get(xuid) ?? [{ clips: [], continuationToken: null, access: 'public' as const }];
    const index = continuationToken ? Number(continuationToken.replace('page-', '')) : 0;
    return structuredClone(pages[index]!);
  }

  private maybeFail() {
    if (this.failWith) throw this.failWith;
  }
}

export function makeClip(overrides: Partial<GameClipInfo> & Pick<GameClipInfo, 'clipId' | 'xuid'>): GameClipInfo {
  return {
    gameTitle: 'Test Game',
    titleId: 1,
    caption: '',
    durationSeconds: 30,
    recordedAt: '2026-10-10T10:00:00.000Z',
    publishedAt: '2026-10-10T10:00:00.000Z',
    thumbnailUrl: `https://example.test/${overrides.clipId}.png`,
    availableUntil: '2027-01-08T10:00:00.000Z',
    views: 0,
    media: { url: `https://example.test/${overrides.clipId}.mp4`, expiresAt: '2026-10-16T13:00:00.000Z' },
    ...overrides,
  };
}
