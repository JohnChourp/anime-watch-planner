# anime-watch-planner

Keep your own anime list and get a suggestion for what to watch next.

> **Status: planning.** There is no application code yet. This repository is a placeholder while the
> project is designed in phases.

## What it will do

- Keep every anime in one of six states:
  - **Completed**: watched.
  - **Rewatching**: watching again.
  - **Watching**: watching now.
  - **Planning**: intend to watch.
  - **Dropped**: stopped and not coming back.
  - **Paused**: left for later.
- Track progress, score, rewatch count and start/finish dates.
- Group seasons, movies and OVAs by franchise, and show the right watch order.
- Suggest what to watch next, with rules such as waiting about two years before a new season, so the
  whole franchise can be rewatched first.

## Planned stack

- Ionic + Angular + Capacitor (Android first, Google Play later).
- Firebase Auth and Firestore: every user has only their own list.
- A shared anime catalog refreshed **once a month** by a scheduled job, never by every client, so that the
  source the data comes from is not overloaded.

## Data sources

The anime catalog source is not chosen yet. It will be chosen by its licence and terms of use, and it will
be credited here and inside the app.

This is an unofficial, independent project. It is not affiliated with AniList, MyAnimeList, Kitsu or any
other anime database.

## License

[MIT](LICENSE)
