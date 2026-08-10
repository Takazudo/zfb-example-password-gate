# zfb-example-password-gate

A small static zfb preview site protected by a hand-written Cloudflare Worker
password gate. zfb builds only static assets; the Worker checks the shared
preview password before it lets any request reach those assets.

## Local run

```sh
pnpm install
pnpm dev
pnpm build
pnpm preview
```

`pnpm preview` uses the zfb static preview server. It does not exercise the
Cloudflare Worker gate. Use Wrangler for Worker checks after `pnpm build`.

## Cloudflare setup

For the ordered from-zero walkthrough (API token, repo secrets, first deploy,
verification), see [docs/cloudflare-setup.md](docs/cloudflare-setup.md). The
notes below are the reference summary.

Set the production password as a Worker secret:

```sh
pnpm exec wrangler secret put SITE_PASSWORD
```

Then build and deploy:

```sh
pnpm build
pnpm exec wrangler deploy
```

**Important: `wrangler.toml` sets `[assets].run_worker_first = true`. Keep that
line enabled. Without it, Workers Static Assets may serve public files before
the Worker can ask for the preview password.**

For local Wrangler checks, the Worker uses the hardcoded development fallback
password `preview-open-sesame` when `SITE_PASSWORD` is absent. You can also add a
local `.dev.vars` file with `SITE_PASSWORD=...`; do not commit that file.

## Trust model

This is a shared password preview gate, not identity or user authentication. It
does not create users, sessions, roles, audit trails, logout, or per-person
authorization. Anyone with the shared password can enter, and anyone with the
fixed marker cookie value can keep using the preview until the cookie expires.

Use Cloudflare Access, an identity provider, or application-level auth for
private production data. This example is for low-risk preview sites where a
shared password is enough to stop casual discovery.

The marker cookie is `HttpOnly` and `SameSite=Lax`. The Worker omits `Secure`
only for plain local development on `http://localhost`, `http://127.0.0.1`, or
`http://[::1]`; every other host/protocol gets a `Secure` cookie.

## Manual Worker checks

After `pnpm build`, start Wrangler in a terminal:

```sh
pnpm exec wrangler dev --local
```

In another terminal, check that unauthenticated requests get the inline login
page:

```sh
curl -i http://localhost:8787/
```

Check successful auth and the cookie:

```sh
curl -i -X POST http://localhost:8787/__auth \
  -H "content-type: application/x-www-form-urlencoded" \
  --data "password=preview-open-sesame&next=/updates/"
```

Check `next` sanitization. Each unsafe `next` value should redirect to `/`:

```sh
curl -i -X POST http://localhost:8787/__auth \
  -H "content-type: application/x-www-form-urlencoded" \
  --data "password=preview-open-sesame&next=//example.com"

curl -i -X POST http://localhost:8787/__auth \
  -H "content-type: application/x-www-form-urlencoded" \
  --data "password=preview-open-sesame&next=/updates/%0ASet-Cookie:bad=1"

curl -i -X POST http://localhost:8787/__auth \
  -H "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "password=preview-open-sesame" \
  --data-urlencode "next=/bad\\path"
```

Stop Wrangler when you are done.

## Continuous deployment (GitHub Actions)

This repo ships `.github/workflows/deploy.yml`:

- **build** runs on every push and PR — `pnpm install`, `pnpm typecheck`,
  `pnpm build`. It needs no Cloudflare credentials, so CI is green immediately.
- **deploy** runs on push to `main` and calls `wrangler deploy`. It self-skips
  until the secrets below are set, so a fresh repo never shows a red deploy.
- **smoke test** runs right after a successful deploy — `pnpm smoke`
  (`scripts/smoke.mjs`). It self-skips the same way while the custom domain does
  not resolve yet.

Production runs on the custom domain declared in `wrangler.toml`:

<https://zfb-example-password-gate.takazudomodular.com>

Add these under **Settings → Secrets and variables → Actions** (step-by-step in
[docs/cloudflare-setup.md](docs/cloudflare-setup.md)):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with Account · Workers Scripts: Edit and Zone · Workers Routes: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | target Cloudflare account id |

`SITE_PASSWORD` is a Worker secret set with `wrangler secret put` (it has a local dev fallback), not a GitHub secret.

### Cloudflare API token permissions

The `CLOUDFLARE_API_TOKEN` repo secret is an **Account**-scoped custom token
(Cloudflare dashboard → My Profile → API Tokens → Create Custom Token) with
these permissions:

- **Workers Scripts** — Edit
- **Account Settings** — Read
- **Workers Routes** — Edit (Zone-scoped)

Set **Account Resources → Include → (your account)**, and **Zone Resources →
Include → `takazudomodular.com`**.

The Zone permission is required: `wrangler.toml` attaches the custom domain
`zfb-example-password-gate.takazudomodular.com` via a `custom_domain` route, and
creating that route is a zone-level operation. Without it `wrangler deploy`
uploads the Worker and then fails on the route step. A single token can be
shared across all `zfb-example-*` repos if it carries the union of every repo's
permissions.

### Post-deploy smoke test

`scripts/smoke.mjs` (`pnpm smoke`) checks the **live** site. Its assertions are
deliberately inverted compared to the other `zfb-example-*` sites: a healthy
deploy of this repo answers an unauthenticated request with the **401 login
page**, never with site content. It asserts:

1. `GET /` is gated — 401 plus the login page, not the site.
2. **A real static asset is gated too.** The path is read from `dist/` at
   runtime, so it is a file that genuinely exists in the deploy. This is the
   check that catches a `run_worker_first` regression — with `false`, the asset
   layer serves files before the Worker and the gate is silently bypassed while
   `GET /` still looks correctly protected.
3. `POST /__auth` with a wrong password is rejected and issues no marker cookie.
   The wrong password is generated at runtime — no password is committed.
4. TLS is valid for the host (Node verifies certificates by default, and the
   script refuses to run with verification disabled).

Run it against a local `wrangler dev` with `SMOKE_URL=http://localhost:8787
pnpm smoke`. When the host does not resolve at all it exits 0 with a
`::notice::`, so CI stays green until the domain is attached. That self-skip is
deliberately narrow — a DNS failure is the only signal that means "not attached
yet". Once the name resolves, a refused, reset, or timed-out request is a real
outage and fails the build rather than skipping.
