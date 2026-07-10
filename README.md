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

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with Account · Workers Scripts: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | target Cloudflare account id |

`SITE_PASSWORD` is a Worker secret set with `wrangler secret put` (it has a local dev fallback), not a GitHub secret.

### Cloudflare API token permissions

The `CLOUDFLARE_API_TOKEN` repo secret is an **Account**-scoped custom token
(Cloudflare dashboard → My Profile → API Tokens → Create Custom Token) with
these permissions:

- **Workers Scripts** — Edit
- **Account Settings** — Read

Set **Account Resources → Include → (your account)**. No Zone permissions are
needed — this repo deploys to a `*.workers.dev` host, not a custom domain. A
single token can be shared across all `zfb-example-*` repos if it carries the
union of every repo's permissions.
