/**
 * AniList API client of this app (Implicit Grant).
 * The client id is public by design: the Implicit Grant has no client secret.
 * Register the client at https://anilist.co/settings/developer with the redirect URL below.
 */
export const ANILIST = {
  /** Public client id from the AniList developer settings (client "Anime Planner for AniList", 2026-11-24). */
  clientId: '57948',
  authorizeUrl: 'https://anilist.co/api/v2/oauth/authorize',
  graphqlUrl: 'https://graphql.anilist.co',
  /** Must match the redirect URL registered for the client, and the URL scheme registered on iOS and Android. */
  redirectUri: 'com.john.animewatchplanner://auth',
} as const;
