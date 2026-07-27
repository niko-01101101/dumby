# Dumby

An AI program intended to run in the background operating social media accounts. Core entities (`Manager`, `ContentCreator`, `Editor`, `Video`, `Media`) are persisted in MySQL, with a `blessed` terminal UI for browsing and driving them. `ContentCreator` and `Editor` each run their own LLM-backed `think()` loop that dispatches `INVOKE:`-formatted commands to real methods — research, video creation, and media assembly are all wired up and working end to end.

## Status

The "brain" is partially built. What exists today:

- A shared `Entity<T>` base class (`src/core/db.ts`) for MySQL-backed models, with an identity cache and change events.
- `Manager`, `ContentCreator`, and `Editor` entities with lifecycle state (`online`, `starting`, `offline`, `shuttingDown`, `stuck`).
- `Video` and `Media` entities wired into a working media pipeline.
- An LLM chat layer (`src/core/llm.ts`) — Gemini by default, falling back to local Ollama — that both `ContentCreator` and `Editor` use to drive an `INVOKE:`-command loop against their own scoped command dictionaries.
- `ContentCreator` research commands (`SEARCH NEWS`, `SEARCH HACKER NEWS`, `HACKER NEWS TRENDS`, `GOOGLE TRENDS`, `YOUTUBE TRENDING`) for finding stories/trends worth turning into content, plus `CREATE VIDEO`/`CREATE EDITOR`/`SET PERSONALITY`/`SET TYPEOFCONTENT`.
- `Editor.createVideo()` runs its own `think()` loop that assembles a video via `PEXELS CLIP`, `PIXABAY CLIP`, `GAMEPLAY CLIP` (real Twitch gameplay clips), `VOICEOVER` (local TTS via Piper), `MUSIC` (Freesound), and `COMPILE` (ffmpeg).
- A terminal UI (`cli/`) for listing and driving managers/content creators/editors/videos, including a live "Brain" view of each entity's INVOKE chat transcript.

What doesn't exist yet: scheduling or actually posting to social media platforms (no `Account` entity yet, despite `db/init/005_accounts.sql`); `src/core/generate.ts` is a stub unrelated to the pipeline above.

## Requirements

- Node.js with native TypeScript execution support (scripts are run directly via `node --env-file=.env ...`, no build step)
- Docker (for MySQL)
- `ffmpeg` and `piper` binaries on `PATH` (plus a Piper voice model) if you want the media pipeline (`Editor.compile`/`addVoiceover`) to actually run
- Ollama running locally with the `gemma4:latest` model pulled — required as the fallback LLM backend even if you're using Gemini, since it's used whenever Gemini's key is unset or its free-tier quota is hit

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

   # Optional — research commands
   YOUTUBE_API_KEY=
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

4. Apply migrations (tracked in a `schema_migrations` table, separate from the `db/init` seed data — see below):

   ```
   npm run migrate
   ```

## Running

Start the terminal UI:

```
node --env-file=.env cli/index.ts
```

Requires the database to be up and `.env` populated. Arrow/vi keys and mouse navigate the manager/content-creator/editor/video list; Enter opens a detail view, drilling down through the entity hierarchy. `q`/`Escape` back out of a display or quit; `Ctrl-C` always quits.

## Type-checking

```
npx tsc
```

`noEmit` is set, so this only checks types — it won't produce `.js`/`.d.ts` output despite `outDir` being configured.

## Notes

- `db/init/*.sql` (fresh-container seed) and `db/migrations/*.sql` (applied via `npm run migrate`) are separate, currently-diverged schema sources — `db/migrations` is badly stale relative to `db/init` (missing tables/columns, different naming and enum values). Don't assume either is authoritative.
- Reddit was tried as a research source and dropped — see the top comment in `src/core/researchSources.ts` for why.
- There's no test suite yet (`npm test` intentionally errors) and no lint/format tooling configured.
- See `CLAUDE.md` for a fuller architecture writeup (entity caching/lifecycle details, the INVOKE command flow, media pipeline internals, CLI internals, import aliasing, TypeScript config notes).
