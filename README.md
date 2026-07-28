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

- `index.html`, `about.html`, `services.html`, `service-area.html`, `contact.html` — the business site
- `assets/` — CSS, JS, images
- `src/index.js` — Worker: handles the `www` redirect and the password gate
- `gate.html` — password page for gated links
- `LCRCC/`, `sermon-search/`, `hive.html` — unrelated pages hosted on the same
  domain as a convenience. `LCRCC` and `hive.html` are password-gated and
  `noindex,nofollow`; `sermon-search/` is public but also `noindex,nofollow`
  so none of it affects the business site's SEO.

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
GATE_PASSWORD=<password for the LCRCC/Hive gate>
GATE_SIGNING_KEY=<random 32+ byte hex string>
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

## Rotating the gate password

```bash
wrangler secret put GATE_PASSWORD
wrangler deploy
```

Changing `GATE_PASSWORD` alone doesn't invalidate cookies already issued
under the old password — rotate `GATE_SIGNING_KEY` too if you need to force
everyone to re-enter the password.
