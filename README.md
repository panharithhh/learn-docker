# LibraFlow API

Library management system: a NestJS API (`src/`) on Postgres and Redis/BullMQ. Every request is
traced (OpenTelemetry), logged (JSON lines with trace ids) and measured (Prometheus), and every
admin/librarian write lands in `activity_logs`.

## Quick start: clean clone with Docker

You need Git and Docker with Compose v2. Node is not required.

```bash
git clone https://github.com/panharithhh/learn-docker.git
cd learn-docker
cp .env.example .env
# Set JWT_ACCESS_SECRET in .env to a random value (the app refuses the placeholder):
#   openssl rand -base64 48
docker compose up -d --build   # db + redis + api, the API built from ./Dockerfile
docker compose run --rm seed   # migration/seed: schema + ~4 months of demo data
curl http://localhost:3000/health
```

`/health` answers `200` with `database`, `redis` and `memory_heap` all `"up"`.

- **API:** http://localhost:3000/api/v1. Swagger UI is at http://localhost:3000/api/docs.
- **Log in** with `POST /api/v1/auth/login` as `admin@libraflow.local`, password `libraflow-dev-password`.
- **Other seeded accounts:** `manager1@…`, `librarian1..4@…` and `member1..3@libraflow.local`, all with the same password.
- **Port 3000 or 5433 already taken?** Change `API_PORT` or `DB_HOST_PORT` in `.env` and run `docker compose up -d` again.
- **Stop:** `docker compose down`. The data survives in the `pgdata` volume; `down -v` deletes it.

### Migration and seed

| Database | Command | What it does |
|---|---|---|
| The Compose `db` (local) | `docker compose run --rm seed` | Builds the schema from the entities and loads demo data. It refuses any non-local database, so it can't wipe a shared one. |
| A shared/real database (Supabase) | `npm run migration:run`, then `npm run seed:admin` | Applies migrations, then creates the first admin from `SEED_ADMIN_*` |

Why the local schema comes from the seed rather than migrations: see [Database note](#database-note).

## Environment variables

Every variable is listed and explained in [`.env.example`](.env.example), with a safe placeholder value.

- **The only one you must change:** `JWT_ACCESS_SECRET`.
- **Compose-only settings:** `DB_HOST`, `API_PORT`, `DB_HOST_PORT` and `API_IMAGE_TAG` are read by `compose.yaml`, not by the app.
- **Inside Compose:** the API always uses the `db` and `redis` services, so `DATABASE_URL`, `REDIS_HOST` and `REDIS_PORT` in `.env` only matter when the API runs on your machine.

## Rollback

On every push to `main` that passes the tests, CI builds the image and pushes it to GitHub
Container Registry (public) with two tags:

```
ghcr.io/panharithhh/libraflow-api:<full commit SHA>   # exact build, for rollbacks
ghcr.io/panharithhh/libraflow-api:latest              # newest build
```

To roll back, run the image of the last good commit instead of the current one:

```bash
git log --format='%H %s' -5 origin/main      # 1. pick the previous good commit's full SHA

export API_IMAGE_TAG=<previous-commit-sha>   # 2. switch the api service to that image
docker compose pull api
docker compose up -d --no-build api

docker compose ps api                        # 3. confirm the image tag, then health
curl http://localhost:3000/health
```

For example, `API_IMAGE_TAG=dfa9bb054e5d12566841e60df8058f797d0f04cf` runs the build of commit
`dfa9bb0`. The tags are also listed on the repo's **Packages** page.

- **Go forward again:** `unset API_IMAGE_TAG`, then `docker compose up -d --build api`.
- **On Render:** set the service's image to `ghcr.io/panharithhh/libraflow-api:<previous-commit-sha>` and redeploy. It normally runs `:latest`.
- **The database is not rolled back with the image.** If the bad release changed the schema, run `npm run migration:revert` against that database as well.

## Run the API on your machine

For development with hot reload. Start only the databases in Docker (or use Homebrew Postgres
and Redis), then run Node locally:

```bash
cp .env.example .env              # DATABASE_URL already points at the Compose db on :5433
docker compose up -d db           # Postgres; Redis from Homebrew on :6379, or add your own
npm install
npm run seed:dev                  # schema + demo data in the LOCAL db
npm run start:dev                 # http://localhost:3000, Swagger at /api/docs
```

`seed:dev` and the E2E setup refuse to run against anything but a local or Docker database, so
a Supabase `DATABASE_URL` is never reset.

## Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` | API in watch mode |
| `npm run seed:dev` | Rebuild the local schema from the entities and seed demo data |
| `npm run seed:admin` | Create the first admin on a real database |
| `npm run migration:run` / `migration:revert` | Apply / undo migrations |
| `npm test` | Unit tests |
| `npm run test:e2e` | E2E tests against a local `libraflow_test` database ([below](#tests)) |

## Dashboard, activity logs and roles

| Endpoint | Who | Notes |
|---|---|---|
| `GET /api/v1/dashboard/stats` | admin, librarian | Stat cards, copies and loan items by status, 30-day loan trend, top books, category usage, recent activity |
| `GET /api/v1/activity-logs` | admin, librarian | `page`, `limit` (≤100), `action`, `entityType`, `userId`, `role`, `from`, `to`, `search` |
| `GET /api/v1/activity-logs/facets` | admin, librarian | Values and counts for the filter dropdowns |
| `GET /observability/{metrics,logs}` | admin | Recent metrics summary and logs as JSON |
| `GET /metrics`, `GET /health` | public | Prometheus scrape target and health check |

**Activity logs are automatic.** `ActivityLogInterceptor` records every successful
POST/PUT/PATCH/DELETE by an admin or librarian: action from the method (CREATE/UPDATE/DELETE),
entity from the controller path (`loans` → `Loan`), id from the result or `:id`, plus IP and a
readable description. Handlers can refine it:

```ts
@Patch(':id/approve')
@LogActivity({ action: 'APPROVE' })           // "librarian2 approved Loan #812 "LN-000812""
approve(...) {}

@Post('login')
@LogActivity({ skip: true })                   // then call activityLogsService.record(...) yourself
login(...) {}
```

**Roles.** Every route needs a JWT (`Authorization: Bearer <accessToken>`) unless it is marked
`@Public()`; `@Roles(RoleName.ADMIN, RoleName.LIBRARIAN)` then limits it by role.

## Observability

| Signal | Mechanism | Where it goes |
|---|---|---|
| Traces | OpenTelemetry: HTTP and Postgres spans | OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (e.g. Grafana Cloud Tempo) |
| Metrics | OpenTelemetry + Prometheus `/metrics` (RED per route, book copies, loan items, overdue items, activity logs written) | `/metrics`, and OTLP when the endpoint is set |
| Logs | JSON lines with `traceId`/`spanId` on stdout, plus `GET /observability/logs` | stdout (`docker compose logs api`), and OTLP when the endpoint is set |

With `OTEL_EXPORTER_OTLP_ENDPOINT` empty the app sends nothing anywhere. For a local stack instead:
`docker compose --profile observability up -d` starts Jaeger (:16686), Prometheus (:9090) and
Grafana (:3001).

`src/common/observability/instrumentation.ts` must stay the first import in `main.ts`.

## Tests

`npm run test:e2e` rebuilds `libraflow_test` from the entities, loads small fixtures with known
numbers (`test/setup/fixtures.ts`), and boots the real `AppModule`. It uses `TEST_DATABASE_URL`
(the Compose db creates `libraflow_test` on first start; with Homebrew run
`createdb -O libraflow libraflow_test`) and Redis on `TEST_REDIS_HOST`/`TEST_REDIS_PORT`.
CI runs the same suite against Postgres and Redis service containers.

## Docker

`compose.yaml` runs three services on one private network: `db` (postgres:16-alpine, data in the
named volume `pgdata`), `redis` (redis:7-alpine, for the BullMQ queues) and `api` (built from the
Dockerfile, `restart: unless-stopped`, starts once `db` is healthy and `redis` has started).
Inside that network containers reach each other by service name (`db`, `redis`), never
`localhost`. A fourth, one-off service, `seed`, uses the Dockerfile's build stage to run the dev
seed.

```bash
docker compose up -d --build                  # db + redis + api
docker compose run --rm seed                  # schema + demo data
docker compose logs -f api                    # API logs
docker compose --profile observability up -d  # + Jaeger, Prometheus, Grafana
```

Persistence check: create a record, `docker compose down`, `docker compose up -d`, and the record
is still there, because `down` removes containers but keeps the `pgdata` volume (`down -v` deletes it).

## CI/CD and the image

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: `npm ci`, build,
unit and E2E tests, then it builds the Docker image and smoke-tests `/health`. On `main` it pushes
`ghcr.io/panharithhh/libraflow-api:<commit sha>` and `:latest` to GitHub Container Registry, for
both Intel/AMD and Apple-chip machines, then triggers the Render deploy hook if one is configured.
Render deploys from that image, not from the repository. See [Rollback](#rollback) for using an
older SHA tag.

Seed the catalog (books and copies)

npm run seed:dev fills a local database with dummy data. To fill the shared Supabase database with the demo catalog instead (51 books with authors, categories and about 140 physical copies), run the catalog seed:

bash
npm run migration:run     # the schema must be current first (books.item_type, etc.)
npm run seed:catalog      # writes to the database in DATABASE_URL

What it creates:

8 categories, 16 authors and 51 items: books, limited_edition books and research_paper items (books.item_type).
2 to 4 copies per item with barcodes like LIB-000123, mixed conditions, shelf locations, and a few damaged or lost copies for demos. Every item keeps at least one available copy. No copy is seeded as borrowed: that status belongs to the loans flow.

It is safe to run again: it reuses existing rows by title, name and ISBN, tops copies up to the target count, and never touches a copy that has loan history. It does write to whatever DATABASE_URL points at, so tell the team before running it against the shared database.

Roll back a migration

Schema changes go through migrations (npm run migration:generate, then npm run migration:run). To undo the most recent migration:

bash
# 1. See what is applied, newest first (Supabase SQL editor or psql)
#    SELECT id, name FROM migrations ORDER BY id DESC LIMIT 5;

# 2. Undo the newest one: runs its down() and removes its row from "migrations"
npm run migration:revert

# 3. Repeat step 2 to go back one more migration, one at a time

Before you run it:

Know what down() destroys. Reverting a migration that added a column or table drops it and its data (for example, reverting AddBookItemType removes books.item_type). Read the migration's down() first.
Never revert on the shared Supabase database without telling the team. Everyone uses the same schema; one revert changes it for all of you and for the deployed app. Take a backup first (Supabase dashboard, Database, Backups).
Keep the code and the database in step. After a revert, also revert the matching entity and migration commit (git revert <sha>). If an entity still lists a column the database no longer has, requests fail with column ... does not exist.
Check the result: run the SELECT above again, then start the API and open /api/docs.

Local and test databases are rebuilt from the entities, so they never need a revert: drop them (or docker compose down -v) and run npm run seed:dev again.

To roll back the deployed image instead of the schema, see Roll back to an earlier image.

## Database note

`src/database/migrations/1793626719884-InitialSchema.ts` only alters tables that already exist in
Supabase. It cannot build an empty database, and it drops the hand-written CHECK constraints and
indexes there. Local and test databases are therefore built with `synchronize` from the entities.
A baseline migration that creates the tables would let `migration:run` work everywhere.
