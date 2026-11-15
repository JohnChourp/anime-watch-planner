# Anime Planner for AniList

A companion app for your AniList anime list on iOS and Android. It helps you keep the list up to date and
suggests what to watch next.

> **Status: planning.** There is no application code yet. This repository is a placeholder while the
> project is designed in phases.

## What it will do

- Sign in with your AniList account. Your list **stays on AniList**: the app reads it and writes your
  changes back there.
- Keep every anime in one of AniList's six states:
  - **Completed**: watched.
  - **Rewatching**: watching again.
  - **Watching**: watching now.
  - **Planning**: intend to watch.
  - **Dropped**: stopped and not coming back.
  - **Paused**: left for later.
- Update progress, score, rewatch count and dates in one tap.
- Group seasons, movies and OVAs by franchise and show the right watch order.
- Suggest what to watch next, with rules such as waiting about two years before a new season, so the
  whole franchise can be rewatched first, and personal deferrals.

## How it works

- **One codebase for iOS and Android:** Ionic + Angular + Capacitor.
- **AniList is the source of data.** The app calls the
  [AniList API](https://docs.anilist.co) from your device with your own sign-in. It keeps a local cache of
  your own list, refreshed when it is about a month old or when you ask. It respects AniList's rate limits
  and never bulk-copies AniList's database.
- **Firebase** keeps only what AniList does not: your deferrals, suggestion rules and preferences. It never
  holds a copy of your list.
- **Built with care:** simplicity, good UI, good design and smooth animations.

## Credits

Anime data and cover images come from [AniList](https://anilist.co).

This is an unofficial, independent project. It is not affiliated with or endorsed by AniList.

## License

[MIT](LICENSE)
