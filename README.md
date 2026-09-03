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

Set the production password as a Worker secret. This is **required** for a
deployed gate — without it the Worker refuses every login (see below):

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
password `preview-open-sesame` when `SITE_PASSWORD` is absent. That fallback is
**localhost-only** — it is honoured only when the request hostname is
`localhost`, `127.0.0.1`, or `[::1]`. On any other hostname an absent (or blank)
`SITE_PASSWORD` makes the gate refuse *every* login and log the reason, rather
than fall back to a password that is published in this repository. You can also
add a local `.dev.vars` file with `SITE_PASSWORD=...`; do not commit that file.

If a deployed gate rejects a password you know is right, that is the signal: the
secret is not bound to the Worker. `wrangler secret list` returns `[]`, and
`wrangler tail` shows `SITE_PASSWORD is not set for <host>`. Setting the secret
fixes it immediately — no redeploy needed.

The same applies to `wrangler dev --remote`, and to local dev reached over
anything but plain http on a loopback name — an https dev server, or
`--ip 0.0.0.0` reached at `http://192.168.x.x:8787`. Those are deployed origins
as far as the gate is concerned, so the fallback does not apply and every
password is rejected. Use plain `wrangler dev`, or put `SITE_PASSWORD=...` in
`.dev.vars`.

## The marker cookie is derived from the password

A successful login sets `zfb_preview_gate` to
`HMAC-SHA256(password, "zfb-preview-gate-marker-v1")`, and that cookie is
checked before any password logic on every request. It used to be a fixed
constant committed to this repo, which meant anyone who read the source could
forge it and skip the password entirely (issue #23).

Deriving it from the password has two consequences worth knowing: changing
`SITE_PASSWORD` invalidates every outstanding cookie automatically, so rotation
needs no separate step; and when no password resolves — an unbound secret on a
deployed origin — no cookie validates either, which is what makes "closed"
actually mean closed. To force re-authentication without changing the password,
bump the version suffix on `MARKER_LABEL` in `src/index.ts`.

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
  `pnpm test`, `pnpm build`. It needs no Cloudflare credentials, so CI is green
  immediately.
- **deploy** runs on push to `main` and calls `wrangler deploy`. It self-skips
  until the secrets below are set, so a fresh repo never shows a red deploy.
- **smoke test** runs right after a successful deploy — `pnpm smoke`
  (`scripts/smoke.mjs`), with `SMOKE_REQUIRE_LIVE=1`. The custom domain is
  attached and serving, so the script's self-skip is switched off there: an
  unreachable site fails the run instead of passing quietly.

Production runs on the custom domain declared in `wrangler.toml`:

<https://zfb-example-password-gate.takazudomodular.com>

Add these under **Settings → Secrets and variables → Actions** (step-by-step in
[docs/cloudflare-setup.md](docs/cloudflare-setup.md)):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with Account · Workers Scripts: Edit and Zone · Workers Routes: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | target Cloudflare account id |

`SITE_PASSWORD` is a Worker secret set with `wrangler secret put` (it has a localhost-only dev fallback; a deployed Worker without it refuses every login), not a GitHub secret.

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

Point it somewhere else with a first argument (`pnpm smoke https://example.com`)
or `SMOKE_URL`; against a local `wrangler dev` use
`SMOKE_URL=http://localhost:8787 pnpm smoke`.

**Self-skip.** When the host does not resolve, or resolves but nothing routes to
it, the script exits 0 with a `::notice::` instead of failing, so a fresh clone
stays green until the domain is attached. The second case covers the propagation
window right after `wrangler deploy` attaches a custom domain: Cloudflare
publishes the AAAA record before the A record, and GitHub runners have no IPv6
route, so the runner briefly gets `ENETUNREACH` against a site that is in fact
serving. The carve-out stays narrow — once the name resolves and routes, a
refused, reset, or timed-out request is a real outage and fails the build. An
invalid or expired certificate always fails; it is never treated as "not ready".

**`SMOKE_REQUIRE_LIVE`.** Set it to `1` and every self-skip above becomes a hard
failure. CI sets it on the smoke step, because this domain is known to be live —
the skip path exists for repos that have not been wired up to Cloudflare yet.
