# Deploying pulseboard

The app needs somewhere that runs a Node process and a Postgres database. It
boots with nothing but `DATABASE_URL`; migrations run on startup and the demo
data seeds itself, so a fresh deploy has something to look at immediately.

## Render — one click

There is a `render.yaml` in this repo, so Render creates both the database and
the web service for you.

1. Sign in at [render.com](https://render.com) with GitHub.
2. **New → Blueprint**.
3. Pick the `pulseboard` repository.
4. **Apply**.

That is the whole setup. `DATABASE_URL` is wired from the database defined in
the blueprint, and `/healthz` is the health check.

The URL Render gives you goes in the README, replacing the demo placeholder.

## Railway

1. Sign in at [railway.app](https://railway.app) with GitHub.
2. **New Project → Deploy from GitHub repo →** `pulseboard`.
3. In the project, **New → Database → PostgreSQL**.
4. Open the app service → **Variables** → add `DATABASE_URL` with the value
   `${{Postgres.DATABASE_URL}}` (Railway substitutes the real one).
5. **Settings → Networking → Generate Domain**.

Railway builds from the `Dockerfile` automatically.

## Fly.io

Needs the CLI, and a card on file even for the free allowance.

```bash
fly launch --no-deploy          # keeps the fly.toml in this repo
fly postgres create
fly postgres attach <db-name>
fly deploy
```

`fly.toml` is already set up, including the health check.

## Notes for this app

Pulseboard holds a WebSocket connection, so a free instance that sleeps will drop it and reconnect when you come back. The client reconnects automatically; the first load after a sleep just takes a moment.

Free tiers change; check the current terms on whichever host you pick. A free
instance that has been idle usually sleeps and takes a few seconds to wake on
the next request — fine for a demo, worth knowing before you send the link to
someone.

## Checking it worked

```bash
curl https://<your-url>/healthz      # {"ok":true}
```

Then open the root URL. The demo data is already there.
