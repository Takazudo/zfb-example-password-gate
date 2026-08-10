# Cloudflare setup — from zero to deployed

This repo is **not deployed yet**. It has no Cloudflare secrets set, and the
`deploy` job in `.github/workflows/deploy.yml` self-skips until they exist — so
CI is green today, but nothing is published. This document is the ordered path
from that state to a live Worker.

The deploy target is **Cloudflare Workers with static assets**: `zfb build`
emits static files into `dist/`, and the hand-written Worker in `src/index.ts`
checks the shared preview password before letting any request reach them.
`wrangler.toml` sets `[assets].run_worker_first = true`, which is what makes the
gate run ahead of the asset server. Keep that line enabled.

**There is nothing to provision.** No KV namespace, no D1 database, no queue —
`wrangler.toml` declares only the `ASSETS` binding, which Workers creates from
`dist/` automatically. (The comment block at the top of `deploy.yml` mentions
Workers KV and Workers AI permissions; that text is shared boilerplate across
the `zfb-example-*` family and does not apply to this repo.) Setup here is
entirely about credentials.

For background on the gate's security properties, read the **Trust model**
section of the README before putting anything real behind this.

## 1. Create or reuse the Cloudflare API token

All nine `zfb-example-*` repos share **one account-scoped token**. If you have
already created it for another example site, reuse it and skip to step 2 — the
family-wide guide is here:

<https://github.com/Takazudo/zfbex-tweaker/blob/main/docs/cloudflare-shared-token-and-env-setup.md>

To create it fresh: Cloudflare dashboard → **My Profile → API Tokens → Create
Custom Token**, with these permissions:

| Type | Resource | Permission |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | Account Settings | Read |
| Zone | Workers Routes | Edit |

Set **Account Resources → Include → (your account)** and **Zone Resources →
Include → `takazudomodular.com`**.

**The Zone permission is not optional here.** `wrangler.toml` attaches the
custom domain `zfb-example-password-gate.takazudomodular.com` with a
`custom_domain` route, and creating that route is a zone-level operation. A
token without it uploads the Worker fine and then fails on the route step.

Copy the token value when it is shown. Cloudflare will not display it again.

You also need your **account id**: dashboard → Workers & Pages → the account id
shown in the right-hand sidebar.

## 2. Set the two GitHub Actions secrets

These are repository secrets, consumed by the `deploy` job:

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo Takazudo/zfb-example-password-gate
gh secret set CLOUDFLARE_ACCOUNT_ID --repo Takazudo/zfb-example-password-gate
```

Each command prompts for the value. Confirm both landed:

```sh
gh secret list --repo Takazudo/zfb-example-password-gate
```

The equivalent dashboard path is **Settings → Secrets and variables → Actions**.

## 3. Set the `SITE_PASSWORD` Worker secret (optional, but do it)

This one is a **Cloudflare-side Worker secret, not a GitHub secret**. It never
appears in `wrangler.toml` and is not needed for the deploy to succeed:

```sh
pnpm exec wrangler secret put SITE_PASSWORD
```

Wrangler needs to be authenticated for this — either run `wrangler login`, or
export the same token from step 1 as `CLOUDFLARE_API_TOKEN` in your shell.

**Why you want it.** `src/index.ts` falls back to a hardcoded development
password when the secret is absent:

```ts
const DEV_PASSWORD = "preview-open-sesame";
// …
const expectedPassword = env.SITE_PASSWORD || DEV_PASSWORD;
```

That fallback exists so `wrangler dev --local` and the README's manual checks
work without any Cloudflare state. Deploying without setting `SITE_PASSWORD`
ships it to a public `workers.dev` URL — and `preview-open-sesame` is the
published default of a public example repo, so anyone who has read this
repository can open your preview. The README's **Trust model** section is
already explicit that this is a shared-password gate rather than
authentication; leaving the fallback in place weakens it further, to a gate
whose password is a matter of public record.

Set it before you hand the URL to anyone. Worker secrets take effect
immediately and survive later deploys, so no redeploy is required after
changing it.

If you run this before the first deploy, Wrangler will offer to create the
Worker script so it has somewhere to attach the secret; accepting is fine, and
step 4 then deploys the real code over it. Running it after step 4 is equally
fine.

For local Wrangler runs you can instead put `SITE_PASSWORD=...` in a `.dev.vars`
file. Do not commit that file.

## 4. Trigger the first deploy

The `deploy` job runs on push to `main`. With the secrets from step 2 in place,
the next push deploys — an empty commit is enough:

```sh
git commit --allow-empty -m "chore: trigger first Cloudflare deploy"
git push origin main
gh run watch --repo Takazudo/zfb-example-password-gate
```

To deploy from your machine instead:

```sh
pnpm build
pnpm exec wrangler deploy
```

After the first successful deploy the site is at its custom domain:

<https://zfb-example-password-gate.takazudomodular.com>

Cloudflare creates that hostname's DNS record and TLS certificate automatically
from the `custom_domain` route; allow a few minutes after the first deploy for
the certificate to be issued. `workers_dev = true` is also set, so the Worker
stays reachable at <https://zfb-example-password-gate.takazudo.workers.dev> too.

## 5. Verify

Confirm the deploy job actually ran rather than self-skipping:

```sh
gh run list --repo Takazudo/zfb-example-password-gate --workflow Deploy --limit 1
```

A skipped deploy logs a `::notice::` line naming the missing piece.

The deploy job then runs the automated smoke test (`pnpm smoke`) against the
custom domain. Run it yourself the same way:

```sh
pnpm build   # the static-asset check reads a real asset path out of dist/
pnpm smoke
```

It asserts that both `/` **and a real static asset** come back as the 401 login
page — the second one is what catches a `run_worker_first` regression, where the
asset layer serves files before the Worker and the gate is bypassed for every
static path while `/` still looks protected. Against a host that does not
resolve yet it exits 0 with a `::notice::` instead of failing.

To check by hand — an unauthenticated request must return **401** with the
inline login page, not your site:

```sh
curl -i https://zfb-example-password-gate.takazudomodular.com/
```

Look for `HTTP/2 401`, `Cache-Control: no-store`, and `X-Robots-Tag: noindex`.
If you get a 200 with page content, the gate is not running ahead of the assets
— check that `run_worker_first = true` survived in `wrangler.toml`.

Then confirm your password is accepted and the marker cookie comes back:

```sh
curl -i -X POST https://zfb-example-password-gate.takazudomodular.com/__auth \
  -H "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "password=<your SITE_PASSWORD>" \
  --data-urlencode "next=/updates/"
```

Expect `302` with `Location: /updates/` and a `Set-Cookie: zfb_preview_gate=…`
carrying `HttpOnly`, `SameSite=Lax`, and `Secure`.

The README's **Manual Worker checks** section covers the same flow plus the
`next` sanitization cases against `wrangler dev --local`. Those are worth
running locally after any change to `src/index.ts`; they do not need to be
repeated against production.

## Troubleshooting

**The deploy job was skipped.** The preflight step found no
`CLOUDFLARE_API_TOKEN`, or found a `REPLACE_WITH` placeholder in
`wrangler.toml`. This repo ships no such placeholder, so in practice it is the
missing secret — redo step 2 and confirm with `gh secret list`. Note the job
reads `CLOUDFLARE_API_TOKEN` only; a token set without
`CLOUDFLARE_ACCOUNT_ID` clears preflight and then fails inside `wrangler
deploy`, so set both.

**The gate accepts `preview-open-sesame`.** `SITE_PASSWORD` was never set on
the Worker, so it is falling back to the development default. Do step 3, then
re-run the step 5 curl. Setting the secret is enough — no redeploy needed.
Note that anyone already holding the marker cookie keeps access until it
expires, since the Worker only checks the cookie value; the cookie's lifetime is
one year.

**`wrangler deploy` fails with an authentication or authorization error.** The
token is missing **Workers Scripts — Edit**, or its Account Resources scope does
not include the account in `CLOUDFLARE_ACCOUNT_ID`. Re-check both against step 1.

**The Worker uploads, then the deploy fails on the route step.** The token is
missing **Zone · Workers Routes — Edit**, or its Zone Resources scope does not
include `takazudomodular.com`. This is the one failure mode where the Worker
itself deploys successfully and only the custom-domain attach fails, so the
`workers.dev` URL keeps working while the custom domain does not resolve. Add
the Zone permission in step 1 and re-run the deploy. Do **not** "fix" it by
deleting the `[[routes]]` block from `wrangler.toml` — that silently drops the
custom domain.

**A deploy succeeds but the URL 404s.** The `workers.dev` subdomain may not be
enabled for the account. Enable it in the dashboard under Workers & Pages →
your Worker → Settings → Domains & Routes.
