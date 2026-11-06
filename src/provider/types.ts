import type { Achievement, ClipPage, Game, NearestCompletion, Screenshot, TitleHistory, XboxUserProfile } from '../domain';
import type { Logger } from '../log';

/** What every upstream call carries: the request's API key and its logger. */
export interface UpstreamCall {
  apiKey: string;
  log: Logger;
}

/**
 * The single seam between the service and upstream (PLAN-v1.md §3). Routing and
 * caching depend only on this interface; tests substitute a fake.
 *
 * The API key is a call-time argument (in `call`) rather than constructor state,
 * so per-user keys (App Key SSO, §9) can be added without restructuring.
 *
 * Implementations throw AppError('UPSTREAM_RATE_LIMIT') on throttling and
 * AppError('UPSTREAM_ERROR') when upstream fails or is unreachable.
 */
export interface IXboxDataProvider {
  /** Exact gamertag match only. Null when no player has that gamertag. */
  resolveGamertag(call: UpstreamCall, gamertag: string): Promise<string | null>;

  /** Null when no player has that XUID. */
  getProfile(call: UpstreamCall, xuid: string): Promise<XboxUserProfile | null>;

  /** One page of the player's clips, newest first. */
  getClips(call: UpstreamCall, xuid: string, continuationToken?: string): Promise<ClipPage>;

  /** The Xbox Store's most-played games, first page, ranked, duplicates merged. */
  getMostPlayedGames(call: UpstreamCall): Promise<Game[]>;

  /** Career facts and recent games from the player's title history. Null when the history is not visible. */
  getTitleHistory(call: UpstreamCall, xuid: string): Promise<TitleHistory | null>;

  /** The player's Mythic total. Null when the history is not visible. */
  getMythics(call: UpstreamCall, xuid: string): Promise<number | null>;

  /** The games the player is closest to finishing, from their whole history. Null when the history is not visible. */
  getNearestCompletion(call: UpstreamCall, xuid: string): Promise<NearestCompletion | null>;

  /** Minutes played in one game per XUID; players with no figure are left out. */
  getMinutesPlayed(call: UpstreamCall, xuids: string[], titleId: string): Promise<Record<string, number>>;

  /** A player's achievements in one game. Null when they are not visible. */
  getAchievements(
    call: UpstreamCall,
    xuid: string,
    titleId: string,
    xbox360: boolean,
  ): Promise<{ titleName: string | null; achievements: Achievement[] } | null>;

  /** A store product's screenshots, in store order. Empty when it has none. */
  getScreenshots(call: UpstreamCall, productId: string): Promise<Screenshot[]>;
}
