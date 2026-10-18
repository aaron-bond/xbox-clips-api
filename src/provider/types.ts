import type { CareerStats, ClipPage, Game, Screenshot, XboxUserProfile } from '../domain';

/**
 * The single seam between the service and upstream (PLAN-v1.md §3). Routing and
 * caching depend only on this interface; tests substitute a fake.
 *
 * The API key is a call-time argument rather than constructor state, so per-user
 * keys (App Key SSO, §9) can be added without restructuring.
 *
 * Implementations throw AppError('UPSTREAM_RATE_LIMIT') on throttling and
 * AppError('UPSTREAM_ERROR') when upstream fails or is unreachable.
 */
export interface IXboxDataProvider {
  /** Exact gamertag match only. Null when no player has that gamertag. */
  resolveGamertag(apiKey: string, gamertag: string): Promise<string | null>;

  /** Null when no player has that XUID. */
  getProfile(apiKey: string, xuid: string): Promise<XboxUserProfile | null>;

  /** One page of the player's clips, newest first. */
  getClips(apiKey: string, xuid: string, continuationToken?: string): Promise<ClipPage>;

  /** The Xbox Store's most-played games, first page, ranked, duplicates merged. */
  getMostPlayedGames(apiKey: string): Promise<Game[]>;

  /** Career facts from the player's title history. Null when the history is not visible. */
  getCareerStats(apiKey: string, xuid: string): Promise<CareerStats | null>;

  /** A store product's screenshots, in store order. Empty when it has none. */
  getScreenshots(apiKey: string, productId: string): Promise<Screenshot[]>;
}
