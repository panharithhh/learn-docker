# LibraFlow API

> Learning Docker and CI/CD with this backend? Start with [LEARN-DOCKER.md](LEARN-DOCKER.md).

Library management system: a NestJS API (`src/`) on Postgres (Supabase) and Redis/BullMQ. Every request is traced (OpenTelemetry), logged (JSON lines with trace
ids) and measured (Prometheus), and every admin/librarian write lands in `activity_logs`.

## Run it locally

You need Postgres and Redis on their default ports (Homebrew services), or run the whole stack in Docker (see below).

```bash
cp .env.example .env     # local defaults; nothing here touches Supabase
npm install
npm run seed:dev         # builds the schema in the LOCAL db and fills ~4 months of dummy data
npm run start:dev        # http://localhost:3000, Swagger at /api/docs
npm run simulate -- 300  # optional: 5 min of dummy traffic for traces and metrics (other terminal)
```

Until JWT login lands, `DEV_AUTH=true` lets an `x-user-id` header choose the acting user
(`GET /dev/users` lists them). Keep it off anywhere but local dev and tests.

`seed:dev` and the E2E setup refuse to run against anything but localhost or Docker, so a
Supabase `DATABASE_URL` is never reset.

## Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` | API in watch mode |
| `npm run seed:dev` | Rebuild the local schema from the entities and seed dummy data |
| `npm run simulate -- <seconds>` | Dummy traffic against the running API (after a build) |
| `npm test` | Unit tests |
| `npm run test:e2e` | E2E tests against a local `libraflow_test` database ([below](#tests)) |

## Dashboard, activity logs and roles

| Endpoint | Who | Notes |
|---|---|---|
| `GET /dashboard/stats` | admin, librarian | Stat cards, copies and loan items by status, 30-day loan trend, top books, category usage, recent activity |
| `GET /activity-logs` | admin, librarian | `page`, `limit` (≤100), `action`, `entityType`, `userId`, `role`, `from`, `to`, `search` |
| `GET /activity-logs/facets` | admin, librarian | Values and counts for the filter dropdowns |
| `GET /observability/{metrics,traces,logs}` | admin | Recent metrics, traces and logs as JSON |
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

**Roles.** `@Roles(RoleName.ADMIN, RoleName.LIBRARIAN)` plus the global `RolesGuard`
(`src/common/rbac`) check `request.user.role`. Whatever auth sets `request.user` must use
the `AuthUser` shape `{ id, username, role }`, and a global JWT guard should skip `@Public()`
routes.

## Observability

| Signal | Where | Later |
|---|---|---|
| Traces | OpenTelemetry: HTTP → `Controller.handler` → service spans → Postgres. The latest 500 are kept in memory for `GET /observability/traces` | Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to send them to Jaeger or Tempo |
| Logs | JSON lines with `traceId`/`spanId` in `LOG_FILE`, plus `GET /observability/logs` | Ship the file with Promtail or Vector |
| Metrics | `/metrics`: RED per route, `libraflow_book_copies`, `libraflow_loan_items`, `libraflow_overdue_loan_items`, `libraflow_activity_logs_written_total` | `docker compose --profile observability up -d` (Prometheus :9090, Grafana :3001, Jaeger :16686) |

`src/common/observability/instrumentation.ts` must stay the first import in `main.ts`.

## Tests

`npm run test:e2e` rebuilds `libraflow_test` from the entities, loads small fixtures with known
numbers (`test/setup/fixtures.ts`), and boots the real `AppModule`. It expects
`postgres://libraflow:libraflow@localhost:5432/libraflow_test` (Docker creates it; with Homebrew run
`createdb -O libraflow libraflow_test`), or set `TEST_DATABASE_URL`. CI runs the same suite against a
Postgres service container.

## Docker

`compose.yaml` runs three services on one private network: `db` (postgres:16-alpine, data in the
named volume `pgdata`), `redis` (redis:7-alpine, for the BullMQ queues) and `api` (built from the
Dockerfile, `restart: unless-stopped`, starts once `db` is healthy and `redis` has started).
Inside that network containers reach each other by service name, so `.env` sets `DB_HOST=db` and
`REDIS_HOST=redis` (not `localhost`).

```bash
# .env for Compose (never commit it):
#   DB_HOST=db  REDIS_HOST=redis  JWT_ACCESS_SECRET=<random>  API_PORT=3000  DB_HOST_PORT=5433
docker compose up -d --build                   # db + redis + api
# First run only: build the schema and demo data in the new database
DATABASE_URL=postgres://libraflow:libraflow@localhost:5433/libraflow_dev npm run seed:dev
curl localhost:3000/health                     # 200 with database, redis, memory_heap all "up"
docker compose --profile observability up -d   # + Jaeger, Prometheus, Grafana
```

Persistence check: create a record, `docker compose down`, `docker compose up -d`, and the record
is still there, because `down` removes containers but keeps the `pgdata` volume (`down -v` deletes it).

## CI/CD and the image

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: `npm ci`, build,
unit and E2E tests, then it builds the Docker image and smoke-tests `/health`. On `main` it pushes
`ghcr.io/panharithhh/libraflow-api:<commit sha>` and `:latest` to GitHub Container Registry, for
both Intel/AMD and Apple-chip machines. Render deploys from that image, not from the repository.

## Database note

`src/database/migrations/1793626719884-InitialSchema.ts` only alters tables that already exist in
Supabase. It cannot build an empty database, and it drops the hand-written CHECK constraints and
indexes there. Local and test databases are therefore built with `synchronize` from the entities.
A baseline migration that creates the tables would let `migration:run` work everywhere.
