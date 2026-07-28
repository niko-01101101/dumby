# Dumby

An AI program intended to run in the background operating social media accounts. Core entities (`Manager`, `ContentCreator`, `Editor`, `Account`, `Video`, `Media`, `Reminder`) are persisted in MySQL, with a `blessed` terminal UI for browsing and driving them. `ContentCreator` and `Editor` each run their own LLM-backed `think()` loop that dispatches `INVOKE:`-formatted commands to real methods — research, account/video creation, media assembly, and YouTube publishing are all wired up and working end to end. A `Reminder`/scheduler layer lets `ContentCreator`s and the `Manager` sleep and wake themselves back up unattended, so a session doesn't need a human (or a `setInterval`) babysitting it.

## Status

The "brain" is well underway. What exists today:

- A shared `Entity<T>` base class (`src/core/db.ts`) for MySQL-backed models, with an identity cache, change events, and soft delete/restore (archive views in the CLI).
- `Manager`, `ContentCreator`, and `Editor` entities with lifecycle state (`online`, `starting`, `offline`, `shuttingDown`, `stuck`, and — new — `sleeping`, distinct from `offline`). A session winds down into `sleeping` and schedules a `Reminder` to wake itself back up, rather than just going `online` → `offline` forever.
- `Account` (child of `ContentCreator`, holds a platform + content description) and `Video`/`Media` wired into a working media pipeline. `Editor`s are a flat pool owned directly by the `Manager` — not per-`ContentCreator` — allocated by the `Manager`'s periodic system review as needed.
- `Manager.reviewSystem()`, woken via `Reminder` every 15 minutes: restarts anything stuck/unexpectedly offline, and provisions another `ContentCreator`/`Editor` if there's no idle capacity and room under the configured max.
- An LLM chat layer (`src/core/llm.ts`) — Gemini by default, degrading through two Gemini tiers before falling back to local Ollama — that both `ContentCreator` and `Editor` use to drive an `INVOKE:`-command loop against their own scoped command dictionaries.
- `ContentCreator` research commands (`SEARCH NEWS`, `SEARCH HACKER NEWS`, `HACKER NEWS TRENDS`, `GOOGLE TRENDS`, `YOUTUBE TRENDING`) for finding stories/trends worth turning into content, plus `SET GOAL`/`SET PERSONALITY`/`SET TYPEOFCONTENT`, `CREATE ACCOUNT`, `CREATE VIDEO`, `POST VIDEO`, and `LIST EDITORS`/`LIST VIDEOS`/`LIST ACCOUNTS`.
- `Editor.createVideo()` runs its own `think()` loop that assembles a video via `PEXELS CLIP`, `PIXABAY CLIP`, `GAMEPLAY CLIP` (real Twitch gameplay clips), `VOICEOVER` (Google Cloud TTS by default, local Piper fallback), `MUSIC` (Freesound), and `COMPILE` (ffmpeg) — resuming a previously-abandoned attempt at the same task instead of re-fetching media from scratch when possible.
- Real YouTube publishing: `Account.connectYouTube()` runs an OAuth2 loopback flow from the CLI, and `POST VIDEO` uploads directly to that channel (goes public immediately — no review gate). `tiktok`/`instagram_reels` are stubbed, not implemented.
- A terminal UI (`cli/`) for listing and driving managers/content creators/editors/accounts/videos, including a live "Brain" view of each entity's INVOKE chat transcript — plus a headless daemon and a read-only dashboard viewer for running unattended on a server (see "Running" below).

What doesn't exist yet: `src/core/generate.ts` is a stub unrelated to the pipeline above.

## Requirements

- Node.js with native TypeScript execution support (scripts are run directly via `node --env-file=.env ...`, no build step)
- Docker (for MySQL)
- `ffmpeg` and `piper` binaries on `PATH` (plus a Piper voice model) if you want the media pipeline (`Editor.compile`/`addVoiceover`) to actually run — Piper is required even if you're using Google Cloud TTS, since it's the fallback engine, not optional infrastructure
- Ollama running locally with the `gemma4:latest` model pulled — required as the fallback LLM backend even if you're using Gemini, since it's used once Gemini's key is unset or its free-tier quota is hit across all fallback tiers

## Setup

1. Create a `.env` file in the project root with:

   ```
   MYSQL_ROOT_PASSWORD=
   MYSQL_DATABASE=
   MYSQL_USER=
   MYSQL_PASSWORD=
   MYSQL_HOST=
   MYSQL_PORT=

   # Optional — LLM brain (falls back to local Ollama if unset or quota-exhausted)
   GEMINI_API_KEY=
   GEMINI_MODEL=

   # Optional — media pipeline
   PEXELS_API_KEY=
   PIXABAY_API_KEY=
   FREESOUND_API_KEY=
   TWITCH_CLIENT_ID=
   TWITCH_CLIENT_SECRET=
   PIPER_VOICE_MODEL=
   PIPER_BIN=
   MEDIA_DIR=

   # Optional — voiceover (falls back to Piper if unset or quota-exhausted)
   GOOGLE_TTS_API_KEY=
   GOOGLE_TTS_VOICE=

   # Optional — research commands
   YOUTUBE_API_KEY=

   # Optional — YouTube publishing (OAuth2, Desktop app client type)
   YOUTUBE_OAUTH_CLIENT_ID=
   YOUTUBE_OAUTH_CLIENT_SECRET=
   ```

2. Start the database:

   ```
   docker compose up -d
   ```

   This boots MySQL 8.4 and seeds the schema from `db/init/*.sql` on first run. If tables are missing after a fresh start, check `docker compose logs mysql` — MySQL's entrypoint aborts remaining init scripts on the first SQL error, so a broken script can silently skip later ones. Init scripts only run against an empty data directory, so re-seeding after a fix requires `docker compose down -v && docker compose up -d`.

3. Install dependencies:

   ```
   npm install
   ```

4. Apply migrations (tracked in a `schema_migrations` table — reaches the same final schema as `db/init` incrementally, for databases that already exist):

   ```
   npm run migrate
   ```

## Running

All-in-one, for local/dev use — AI cascade, `Reminder` scheduler, and the terminal UI together in one process:

```
node --env-file=.env cli/index.ts
```

For running unattended on a server, split into a headless daemon plus a read-only dashboard you SSH in and view separately (so opening the dashboard never races a second `think()` loop against the daemon's):

```
node --env-file=.env cli/daemon.ts      # headless, drives the real Manager + scheduler
node --env-file=.env cli/dashboard.ts   # view-only UI, polls the daemon's DB state
```

Once the package is `npm link`ed, `bin/dumby.js` fronts all of the above (plus migrations) from anywhere:

```
dumby run         # cli/index.ts
dumby daemon      # cli/daemon.ts
dumby dashboard   # cli/dashboard.ts
dumby migrate     # db/migrate.ts
```

All entry points require the database to be up and `.env` populated. In the UI, arrow/vi keys and mouse navigate the manager/content-creator/editor/account/video list; Enter opens a detail view, drilling down through the entity hierarchy. `q`/`Escape` back out of a display or quit; `Ctrl-C` always quits.

## Type-checking

```
npx tsc
```

`noEmit` is set, so this only checks types — it won't produce `.js`/`.d.ts` output despite `outDir` being configured.

## Notes

- `db/init/*.sql` (fresh-container seed) and `db/migrations/*.sql` (applied via `npm run migrate`) are two schema sources that converge on the same final schema, reached by different paths — don't assume either is more authoritative, but a schema change needs to be added to both.
- Reddit was tried as a research source and dropped — see the top comment in `src/core/researchSources.ts` for why.
- There's no test suite yet (`npm test` intentionally errors) and no lint/format tooling configured.
- See `CLAUDE.md` for a fuller architecture writeup (entity caching/lifecycle details, the INVOKE command flow, sleep/Reminder/scheduler internals, media pipeline internals, YouTube OAuth/publish flow, CLI internals, import aliasing, TypeScript config notes).
