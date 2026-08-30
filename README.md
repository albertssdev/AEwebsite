# Alberts Electric Website

Static site for Alberts Electric, served via a Cloudflare Worker with static
assets. Deployed at [albertselectric.net](https://albertselectric.net).

## How updates work

1. Edit files in this repo (locally or however you're working).
2. Commit and push to `main`: `git push`.
3. GitHub Actions ([.github/workflows/deploy.yml](.github/workflows/deploy.yml))
   picks up the push and runs `wrangler deploy` automatically — see
   [Automatic deploys](#automatic-deploys-github-actions) below.
4. Live within ~30s at [albertselectric.net](https://albertselectric.net).

No manual deploy step needed for normal edits. `wrangler deploy` from your
own machine (see [Deploying](#deploying)) is only for when you need to push
a change immediately without waiting on a commit/push, or you're working
somewhere without GitHub Actions access.

Repo: [github.com/albertssdev/AEwebsite](https://github.com/albertssdev/AEwebsite)
(public, default branch `main`).

## Project structure

- `index.html`, `about.html`, `services.html`, `contact.html` — the business site (Service Area is a section on About; `/service-area` redirects there)
- `assets/` — CSS, JS, images
- `src/index.js` — Worker: handles the `www` redirect and the password gate
- `gate.html` — password page for gated links
- `LCRCC/`, `sermon/`, `hive.html` — unrelated pages sharing this Worker.
  `LCRCC/` backs the separate **lcrccmissouri.org** site (hostname-routed in
  `src/index.js`); `albertselectric.net/LCRCC/*` 301-redirects there.
  `hive.html` is password-gated. `sermon/` is public, served at `/sermon`
  (`/sermon-search/*` and `/sermons/*` 301-redirect to it). All are
  `noindex,nofollow` so none of it affects the business site's SEO.
- `sermon/sermons.json` — the sermon search data. Regenerate it from the
  sermon-processor export with `python scripts/build_sermons_json.py <path-to>/sermon_database.csv`
  (see that script's header). `scripts/` is `.assetsignore`d, not served.
- `assets/js/reviews.js` — fetches `/api/reviews` (a Worker route backed by
  Google's Places API, cached in KV) and renders the homepage reviews section

## Prerequisites

- Node.js
- A Cloudflare account with access to the `alberts-electric` Worker

## Setup

```bash
npm install -g wrangler
```

Authenticate wrangler (opens a Cloudflare login page in your browser):

```bash
wrangler login
```

> On Windows PowerShell, if you hit a "running scripts is disabled" error,
> use `npx.cmd wrangler login` instead of `npx wrangler login`.

## Local development

Create a `.dev.vars` file in this directory (never commit it — it's in
`.gitignore`) with:

```
GATE_PASSWORD=<password for the Hive gate>
GATE_SIGNING_KEY=<random 32+ byte hex string>
GOOGLE_PLACES_API_KEY=<see "Google reviews setup" below>
```

Generate a signing key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then start the dev server:

```bash
wrangler dev
```

## Deploying

Secrets are set once per environment and persist across deploys — you don't
need to re-set them unless rotating the password or signing key:

```bash
wrangler secret put GATE_PASSWORD
wrangler secret put GATE_SIGNING_KEY
```

Then deploy:

```bash
wrangler deploy
```

This uploads all static assets and the Worker, and applies routes for
`albertselectric.net` and `www.albertselectric.net` as defined in
`wrangler.jsonc`.

## Automatic deploys (GitHub Actions)

`.github/workflows/deploy.yml` runs `wrangler deploy` automatically on every
push to `main`. It needs two repository secrets under **Settings → Secrets
and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — create at
  [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
  using the **Edit Cloudflare Workers** template, scoped to this account only
- `CLOUDFLARE_ACCOUNT_ID` — from `wrangler whoami`

The `GATE_PASSWORD` / `GATE_SIGNING_KEY` Worker secrets are set separately
(see above) and persist across CI deploys — the workflow doesn't touch them.

**Gotchas already hit and fixed — don't reintroduce these:**

- The workflow pins `wranglerVersion: "4.114.0"`. Without it,
  `cloudflare/wrangler-action` installs an old cached Wrangler (3.x) that
  can't parse `wrangler.jsonc`, so it silently finds no config and fails
  with "Missing entry-point."
- CI installs Wrangler into `node_modules/` inside the checkout. Since the
  assets directory is `./` (the whole repo), `node_modules/` (and any future
  `package.json`/`package-lock.json`) must stay listed in `.assetsignore` —
  otherwise Wrangler's own 122 MB `workerd` binary gets uploaded as a site
  asset and the deploy fails with "Asset too large."
- `.assetsignore` also excludes repo-management files (`README.md`,
  `LICENSE`, `.github/`, `.git/`, `.gitignore`) so they aren't served
  publicly at e.g. `/README.md`.

## Google reviews widget

The homepage reviews section is custom-built (not a third-party embed), so
it can be kept free of duplicate-name-in-a-row reviews and doesn't require a
paid subscription. It works like this:

1. A daily Cron Trigger (`0 6 * * *` in `wrangler.jsonc`) calls
   `scheduled()` in `src/index.js`, which fetches up to 5 reviews from
   Google's Places API (New), drops any review whose first name matches the
   review immediately before it, and stores the result in the `REVIEWS_KV`
   namespace.
2. The `/api/reviews` Worker route serves that cached JSON (and lazily
   fetches+caches on first request if KV is empty, so it self-heals without
   waiting for the next cron run).
3. `assets/js/reviews.js` fetches `/api/reviews` on page load and renders
   the cards.

**One-time setup (required — the widget won't show anything until this is
done):**

1. In [Google Cloud Console](https://console.cloud.google.com/), create/use
   a project, enable **Places API (New)**, and enable billing (required by
   Google even though usage at this volume — ~30 calls/month — stays inside
   the free monthly credit).
2. Create an API key under **APIs & Services → Credentials**, and restrict
   it to **Places API (New)** only.
3. Find your Place ID using Google's
   [Place ID Finder](https://developers.google.com/maps/documentation/places/web-service/place-id)
   (search the business name/address). Place IDs aren't sensitive — put it
   directly in `wrangler.jsonc` under `vars.GOOGLE_PLACE_ID`.
4. Set the API key as a secret (never commit it):
   ```bash
   wrangler secret put GOOGLE_PLACES_API_KEY
   ```
5. Deploy. The section stays blank (gracefully, no error shown) until steps
   1–4 are done and a review fetch has succeeded at least once.

To force an immediate refresh instead of waiting for the next 6am cron run,
delete the `reviews` key from the `REVIEWS_KV` namespace — the next visitor
to hit `/api/reviews` will trigger a fresh fetch.

## Rotating the gate password

```bash
wrangler secret put GATE_PASSWORD
wrangler deploy
```

Changing `GATE_PASSWORD` alone doesn't invalidate cookies already issued
under the old password — rotate `GATE_SIGNING_KEY` too if you need to force
everyone to re-enter the password.
