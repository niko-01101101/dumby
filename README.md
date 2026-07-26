# Dumby

An AI program intended to run in the background operating social media accounts. Core entities (`Manager`, `ContentCreator`, `Video`) are persisted in MySQL, with a `blessed` terminal UI for browsing and driving them. The generation/decision logic (the "brain") is not yet built.

## Status

Early scaffolding. What exists today:

- A shared `Entity<T>` base class (`src/core/db.ts`) for MySQL-backed models, with an identity cache and change events.
- `Manager` and `ContentCreator` entities with basic lifecycle state (`online`, `starting`, `offline`, `shuttingDown`, `stuck`).
- A `Video` entity, not yet wired into anything.
- A terminal UI (`cli/`) for listing and inspecting managers/content creators.

What doesn't exist yet: any actual content generation, scheduling, or social media integration (`src/core/generate.ts` is a stub).

## Requirements

- Node.js with native TypeScript execution support (scripts are run directly via `node --env-file=.env ...`, no build step)
- Docker (for MySQL)

## Setup

1. Create a `.env` file in the project root with:

   ```
   MYSQL_ROOT_PASSWORD=
   MYSQL_DATABASE=
   MYSQL_USER=
   MYSQL_PASSWORD=
   MYSQL_HOST=
   MYSQL_PORT=
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

Requires the database to be up and `.env` populated. Arrow/vi keys and mouse navigate the manager/content-creator list; Enter opens a detail view. `q`/`Escape` back out of a display or quit; `Ctrl-C` always quits.

## Type-checking

```
npx tsc
```

`noEmit` is set, so this only checks types — it won't produce `.js`/`.d.ts` output despite `outDir` being configured.

## Notes

- `db/init/*.sql` (fresh-container seed) and `db/migrations/*.sql` (applied via `npm run migrate`) are separate, currently-diverged schema sources — they don't yet agree on the `contentCreators` schema. Don't assume one is authoritative.
- There's no test suite yet (`npm test` intentionally errors) and no lint/format tooling configured.
- See `CLAUDE.md` for a fuller architecture writeup (entity caching/lifecycle details, CLI internals, import aliasing, TypeScript config notes).
