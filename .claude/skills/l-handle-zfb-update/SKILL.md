---
name: l-handle-zfb-update
description: >-
  Update the zfb upstream dependency (the @takazudo/zfb* packages) in this
  example (password-gate) to the latest stable release, review what changed
  upstream between versions, and adapt this project's code if a change touches a
  surface it uses. Use when: (1) User says 'update zfb', 'bump zfb', 'zfb
  update', or 'handle zfb update', (2) A new zfb release is out and this
  example should track it.
user-invocable: true
argument-hint: "[target-version, e.g. 3.0.1 — omit to use latest stable]"
---

# Handle zfb Update — password-gate

This is a static zfb preview site protected by a hand-written Cloudflare Worker
password gate (`src/index.ts`, deployed with `[assets].run_worker_first = true`).
zfb builds only the static assets; the Worker checks the shared preview password
before serving them via `env.ASSETS`. It depends on `@takazudo/zfb` and
`@takazudo/zfb-runtime` only — it does **not** use the Cloudflare adapter, so a
zfb upgrade affects only the static build, not the gate Worker.

Bump every `@takazudo/*` package this repo depends on to the latest stable
release (kept in lockstep on one version), review what changed upstream, and
adapt this project only where an upstream change touches a surface it actually
uses.

Upstream repo: `Takazudo/zudo-front-builder` (monorepo; npm packages live under
`packages/`). Every release has a `v<version>` tag and GitHub release notes.

## Step 0 — Preconditions

`package.json` and `pnpm-lock.yaml` must be clean (`git status --short` shows
neither). If either is dirty, stop and ask before touching them.

## Step 1 — Resolve current and target versions

```bash
CURRENT=$(node -p "require('./package.json').dependencies['@takazudo/zfb']")
TARGET=${1:-$(npm view @takazudo/zfb dist-tags.latest)}
```

- Always resolve the target from the `latest` dist-tag, never `next` — this repo
  tracks the zfb stable line. The `next` prerelease channel is dead: it ended at
  `1.1.0-next.1`, a prerelease of `1.1.0`, which has since shipped. Resolving
  from `next` would pin a prerelease of an already-released version.
- If `CURRENT` == `TARGET`: report "already at the latest stable (<version>)" and STOP.
- If an explicit target is older than `CURRENT`, that is a downgrade — stop and
  confirm first. This project is on the zfb **3.x** line (floor 3.0.0: zudo-react
  + zudo-wind); a target below 3.0.0 is always a downgrade.
- If the MAJOR version changes (e.g. 3.x → 4.0.0), treat it as a **migration**,
  not a two-line bump: read the upstream `guides/migrating-to-v<N>` doc, and run
  the full "Major-version verification" in Step 5.

## Step 2 — Review upstream changes BEFORE bumping

Enumerate versions between CURRENT (exclusive) and TARGET (inclusive) in publish
order — never sort prerelease strings lexically (`next.9` vs `next.10`):

```bash
node -e '
const vs = JSON.parse(process.argv[1]);
const cur = vs.indexOf(process.argv[2]), tgt = vs.indexOf(process.argv[3]);
if (tgt < 0) { console.error("target not found"); process.exit(1); }
if (cur >= 0 && tgt <= cur) { console.error("not newer than current"); process.exit(1); }
console.log(vs.slice(cur + 1, tgt + 1).join("\n"));
' "$(npm view @takazudo/zfb versions --json)" "$CURRENT" "$TARGET"
```

Read the release notes for EVERY enumerated version:

```bash
gh release view "v<version>" --repo Takazudo/zudo-front-builder --json body -q '.body'
```

If a release has no notes, fall back to the commit list:

```bash
gh api "repos/Takazudo/zudo-front-builder/compare/v<prev>...v<version>" \
  --jq '.commits[].commit.message' | head -40
```

**Fail closed:** if the changes cannot be reviewed at all, stop and ask — never
bump blind.

Flag anything that touches a surface this example uses:

| Upstream surface | Where this project uses it |
| --- | --- |
| Config schema (JSON form) | `zfb.config.json` — `output`/`outDir`/`publicDir` and `wind` |
| zudo-wind reset (`wind.reset: "owned-v1"`) and class scanning | `styles/global.css` (authored CSS only, no utilities) on top of the owned reset; every class in `layouts/`/`pages/` must stay an "ordinary class" (`pnpm exec zfb wind explain <class>`) |
| zudo-react static rendering (`jsxImportSource: "@takazudo/zfb/zudo-react"`, `Child`, HTML attribute spellings) | `pages/index.tsx`, `pages/checklist.tsx`, `pages/updates.tsx`, `layouts/default.tsx` |
| Static build output (`zfb build` → `dist/`, `/assets/styles-*.css`) | served by the gate Worker via `env.ASSETS` — see `src/index.ts`; `scripts/smoke.mjs` picks a real `/assets/*.css` from `dist/` |
| CLI (`zfb dev/build/preview/check`, `zfb wind audit/explain`) | `package.json` scripts; migration checks |

The hand-written Worker (`src/index.ts`, `src/cookies.ts`, typed by
`worker-configuration.d.ts`) is independent of zfb; upstream zfb changes should
not touch it.

Rule: adapt only if this project actually uses the changed feature. Internal zfb
changes (Rust internals, docs, other frameworks) need no action — note and move on.

## Step 3 — Bump every @takazudo/* package (lockstep)

```bash
PKGS=$(TARGET="$TARGET" node -p "Object.keys(require('./package.json').dependencies).filter(n=>n.startsWith('@takazudo/')).map(n=>n+'@'+process.env.TARGET).join(' ')")
pnpm add -E $PKGS
```

- `-E` keeps the exact pin (no caret) — this repo tracks one known-good zfb version.
- All `@takazudo/*` packages must land on the SAME version.
- Commit `package.json` AND `pnpm-lock.yaml` together — CI installs with
  `pnpm install --frozen-lockfile` and fails on a stale lockfile.
- pnpm is the package manager; npm is only for reading registry metadata.

## Step 4 — Adapt project code (only if Step 2 flagged something)

Apply what the flagged notes require (config schema, renamed APIs, island markup,
etc.). Update `README.md` if commands or documented behavior changed. If nothing
was flagged, skip.

## Step 5 — Verify

```bash
rm -rf ./dist ./.zfb ./.zfb-build
pnpm build       # produces the static dist/ served by the gate Worker
pnpm typecheck   # zfb check passes
```

Also run `pnpm test` (the Worker gate tests) — they must all still pass, unchanged.

`pnpm build` only produces the static `dist/` assets — it does not exercise the
gate Worker, and neither does `pnpm preview` (zfb's static preview). Verify the
gate against the **built** assets:

```bash
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
pnpm exec wrangler dev --local --port "$PORT" --ip 127.0.0.1   # separate terminal
SMOKE_URL="http://127.0.0.1:$PORT" pnpm smoke                 # must print "Static asset under test: /assets/styles-*.css"
```

plus the README's curl checks (wrong password → no `Set-Cookie`; valid password →
marker cookie and 200s with `Cache-Control: private, no-store` / `Vary: Cookie`;
unsafe `next` → `/`). Always use an explicit free port — other sessions may hold
8787 — and never point `pnpm smoke` at the live host by hand (CI owns that).

### Major-version verification (e.g. the 2.x → 3.0.0 migration)

A green build is not proof for a major bump. Additionally:

- **Baseline in a separate worktree** at the pre-bump commit (`git worktree add
  <scratch>/old <sha> --detach`), install + build there, and keep its `dist/`.
- **Diagnose with `pnpm typecheck` first** — `zfb check` names the file and
  suggests HTML spellings (`charset`, `datetime`); `zfb build` render errors
  do not.
- **Parsed-DOM diff** of old vs new `dist/*.html` (ignore serialization-only
  differences such as dropped `/>`).
- **Visual + computed-style diff**: serve both builds side by side with
  `zfb preview --port <free> --host 127.0.0.1` and compare full-page
  screenshots plus every element's computed style at 375/710/730/1280 px
  (±10 px around the `max-width: 720px` breakpoint), in Chromium and WebKit.
  Reset changes only show up in the computed-style diff.
- **Fresh frozen install** in a clean `git worktree` at the final HEAD.
- `pnpm why preact` / `pnpm why preact-render-to-string` stay empty.

## Step 6 — Report

Summarize: versions traversed, notable upstream changes per release (one line
each), adaptations made (or "none needed"), and verification results.
