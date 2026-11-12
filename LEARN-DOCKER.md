# Learn Docker with the LibraFlow API

This repo is the LibraFlow backend (NestJS API) only. Use it to learn three things in order:
running the API in a container, running a whole stack with Compose, and shipping it with a CI/CD pipeline.

## 0. Words you need

| Word | Meaning |
|---|---|
| **Image** | A packaged app: code + Node + dependencies, frozen. Built from a `Dockerfile`. |
| **Container** | A running copy of an image. You can run many containers from one image. |
| **Registry** | A place to store images online. We use GitHub Container Registry (`ghcr.io`). |
| **Compose** | A file (`docker-compose.yml`) that starts several containers together. |
| **CI** | Continuous Integration: every push is built and tested automatically. |
| **CD** | Continuous Delivery/Deployment: a passing `main` is packaged and shipped automatically. |

## 1. Read the Dockerfile

```dockerfile
FROM node:24-alpine AS build      # stage 1 starts from a small Linux with Node 24
WORKDIR /app                      # all next commands run inside /app
COPY package*.json ./             # copy only the dependency list first...
RUN npm ci                        # ...so this slow step is cached until package.json changes
COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build                 # TypeScript -> dist/

FROM node:24-alpine               # stage 2: a fresh, clean image
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && mkdir logs && chown node:node logs   # production deps only
COPY --from=build /app/dist ./dist                            # take ONLY the built code from stage 1
USER node                         # don't run as root
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/main.js"]
```

Why two stages? Stage 1 has TypeScript and dev tools; stage 2 throws them away, so the final image is smaller and safer.
`.dockerignore` keeps `node_modules`, `.env` and other junk out of the build.

## 2. Build and run it on your Mac

Docker Desktop must be running. In this folder:

```bash
docker build -t libraflow-api:local .        # build the image
docker images libraflow-api                  # see it (≈544 MB)
```

Run it against your local Homebrew Postgres (`host.docker.internal` means "my Mac" from inside a container):

```bash
docker run -d --name api -p 3100:3000 \
  -e DATABASE_URL=postgres://libraflow:libraflow@host.docker.internal:5432/libraflow_dev \
  -e DB_SSL=false -e REDIS_HOST=host.docker.internal -e DEV_AUTH=true -e JWT_SECRET=dev \
  libraflow-api:local

curl http://localhost:3100/health           # 200 = it works
docker ps                                    # list running containers
docker logs -f api                           # follow its logs (Ctrl+C to stop following)
docker exec -it api sh                       # open a shell INSIDE the container; type exit to leave
docker stop api && docker rm api             # stop and delete the container
```

`-p 3100:3000` means "port 3100 on my Mac → port 3000 in the container". `-e` sets an environment variable.
Never bake secrets into the image; always pass them with `-e` or `--env-file`.

**Try this:** change a message in `src/app.service.ts`, rebuild, rerun, and see the change. Notice the `npm ci` step says `CACHED`.

## 3. Run the whole stack with Compose

`docker-compose.yml` starts Postgres, Redis and (with a profile) the API together on a private network,
where containers find each other by service name (`postgres`, `redis`).

Your Homebrew Postgres and Redis use the same ports, so stop them first:

```bash
brew services stop postgresql@17 redis
docker compose up -d                          # Postgres + Redis
docker compose --profile app up -d --build    # + the API built from the Dockerfile
docker compose ps
docker compose logs -f api
docker compose --profile observability up -d  # + Prometheus :9090, Grafana :3001, Jaeger :16686
docker compose --profile app --profile observability down   # stop everything (add -v to also delete the data)
brew services start postgresql@17 redis
```

## 4. The CI/CD pipeline

File: `.github/workflows/ci.yml`. It runs on GitHub's machines on every push:

```
push / pull request
   │
   ▼
1. test     npm ci → build → unit tests → e2e tests (against a throwaway Postgres container)
   │ only if green
   ▼
2. docker   build the image → run it → curl /health  (smoke test)
   │ only on main
   ├──► push image to ghcr.io/panharithhh/learn-docker:latest and :<commit sha>
   ▼
3. deploy   call RENDER_DEPLOY_HOOK_URL if that secret exists (otherwise skip)
```

- On a **pull request**, only steps 1 and 2 run (nothing is published).
- On **main**, the image is pushed. Find it under your GitHub profile → **Packages**.
- Pull it anywhere: `docker pull ghcr.io/panharithhh/learn-docker:latest`
  (if the package is private, first `docker login ghcr.io -u panharithhh` with a token that has `read:packages`).

**Try this:** make a branch, break a test on purpose, open a PR, and watch step 1 go red and step 2 never start.

## 5. Deploy (the CD part)

1. Create a free account on [Render](https://render.com) → **New → Web Service → Existing image** → `ghcr.io/panharithhh/learn-docker:latest`
   (make the package public in GitHub → Packages → Package settings, or give Render a token).
2. Add environment variables in Render: `DATABASE_URL` (your Supabase **Session pooler** URL), `JWT_SECRET`,
   `REDIS_HOST` / `REDIS_PORT` (from Upstash or Render Redis), `PORT=3000`. Leave `DB_SSL` unset so SSL stays on.
3. Health check path: `/health`.
4. In Render → Settings, copy the **Deploy Hook** URL. In GitHub → repo → Settings → Secrets and variables → Actions,
   add it as `RENDER_DEPLOY_HOOK_URL`.

Now every merge to `main` is: tested → packaged → published → deployed, with no manual steps.

## Cheat sheet

| Command | What it does |
|---|---|
| `docker build -t name .` | Build an image from the Dockerfile here |
| `docker run -d -p 3100:3000 --name x name` | Start a container in the background |
| `docker ps` / `docker ps -a` | Running containers / all containers |
| `docker logs -f x` | Follow a container's output |
| `docker exec -it x sh` | Shell inside a running container |
| `docker stop x && docker rm x` | Stop and remove |
| `docker images` / `docker rmi name` | List / delete images |
| `docker system prune` | Delete stopped containers and unused images |
| `docker compose up -d` / `down` | Start / stop the stack |
