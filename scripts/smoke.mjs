#!/usr/bin/env node
// Post-deploy smoke test for the live password gate.
//
// THE ASSERTIONS HERE ARE INVERTED relative to the other zfb-example sites.
// A healthy deploy of THIS repo answers an unauthenticated request with the
// 401 login page, never with site content. "Expect 200 with the homepage" is
// the wrong test here — it would fail on a working gate, and "fixing" it by
// expecting 200 would turn this script into a rubber stamp for a bypassed gate.
//
// Run after `pnpm build` (the static-asset check reads dist/ to learn a real
// deployed asset path). Override the target with the first CLI argument or
// SMOKE_URL. Set SMOKE_REQUIRE_LIVE=1 to turn every self-skip into a failure.

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

// Target precedence: first positional argument, then SMOKE_URL, then the
// deployed custom domain. The argv form exists so the not-ready and TLS paths
// below can be exercised by hand against known-bad hosts.
const SITE_URL = (
  process.argv[2] ?? process.env.SMOKE_URL ?? "https://zfb-example-password-gate.takazudomodular.com"
).replace(/\/+$/, "");
const DIST_DIR = path.resolve(import.meta.dirname, "..", "dist");

// Once the custom domain is confirmed live, "not ready yet" stops being a
// benign pre-setup state and becomes an outage. With SMOKE_REQUIRE_LIVE set,
// every path that would otherwise self-skip fails instead. CI sets it; the skip
// path stays in the code for a fresh clone that has not wired up Cloudflare.
const REQUIRE_LIVE = /^(1|true)$/i.test(process.env.SMOKE_REQUIRE_LIVE ?? "");

const LOGIN_PAGE_MARKERS = ["<title>Preview password</title>", 'action="/__auth"'];
const MARKER_COOKIE = "zfb_preview_gate";

// The DEV_PASSWORD constant committed in src/index.ts. Submitting it on purpose is
// the point of assertion (e): it is public to anyone who can read this repo, so a
// deployed host that accepts it is wide open. Safe to hardcode here for the same
// reason it is unsafe to accept there.
const COMMITTED_DEV_PASSWORD = "preview-open-sesame";

// The fixed marker this gate shipped with before the cookie became a per-password
// HMAC. It was in the repo, and hasValidMarker short-circuits ahead of all password
// logic, so presenting it opened any deployment without submitting a password at
// all (issue #23). Assertion (f) is the one that catches a regression to that.
const RETIRED_AUTH_MARKER = "pg_01_hL7G9sR4vK2pQ8mN6bD3xA";

const ATTEMPTS = 6;
const BACKOFF_MS = [3000, 6000, 10000, 15000, 20000];

// Cloudflare emits these while a freshly attached custom domain is still
// propagating; retry them rather than reporting a broken gate.
const TRANSIENT_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

// The two — and only two — "not reachable yet" conditions, both of which mean
// nothing can be asserted about the target. SMOKE_REQUIRE_LIVE turns them into
// failures once the domain is known to be live.
//
// DNS has not published the name yet: the custom domain is not attached.
const DNS_UNRESOLVED_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

// The name resolved but nothing routes to the address it returned. Cloudflare
// publishes the AAAA record BEFORE the A record when it attaches a custom
// domain, and GitHub-hosted runners have no IPv6 route at all — so for a few
// minutes after the first deploy the runner sees an AAAA it cannot dial and no
// A yet. That is the same "not attached yet" state as a DNS failure on a site
// that is in fact working.
const NO_ROUTE_CODES = new Set(["ENETUNREACH", "EHOSTUNREACH"]);

// TLS answered but the certificate is not valid for this host. That is
// assertion (d) failing, not a "not ready yet" — never skip on these.
const TLS_INVALID_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

class NotWiredUpError extends Error {}
class TlsInvalidError extends Error {}
class UnreachableError extends Error {}

const failures = [];

function pass(label) {
  console.log(`PASS  ${label}`);
}

function fail(label, detail) {
  console.log(`FAIL  ${label} — ${detail}`);
  console.log(`::error::${label} — ${detail}`);
  failures.push(label);
}

function check(label, condition, detail) {
  if (condition) pass(label);
  else fail(label, detail);
}

function skip(reason) {
  if (REQUIRE_LIVE) {
    fail(
      "live site responds",
      `${reason} — SMOKE_REQUIRE_LIVE is set, so "not serving yet" is a failure, not a skip`,
    );
    return;
  }
  console.log(`::notice::Smoke test skipped — ${reason}`);
  console.log(`Skipped: ${SITE_URL} is not serving yet. Nothing was asserted.`);
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Collect every error code in the thrown error's tree. undici hides transport
// failures under `cause`, and Happy Eyeballs dials the A and AAAA addresses in
// parallel and reports both failures as an AggregateError whose OWN `code` is
// undefined — the real ENETUNREACH sits in `errors[]`. A cause-only lookup
// misses it, which is how an IPv6-only propagation window turns into a red CI
// run against a site that is serving perfectly well.
function errorCodes(error) {
  const codes = new Set();
  const seen = new Set();

  const visit = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (typeof node.code === "string") codes.add(node.code);
    if (Array.isArray(node.errors)) node.errors.forEach(visit);
    visit(node.cause);
  };

  visit(error);
  return codes;
}

function matchCode(codes, set) {
  for (const code of codes) if (set.has(code)) return code;
  return null;
}

async function request(url, init = {}) {
  let lastResponse = null;
  let lastTransportError = null;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);

    try {
      const response = await fetch(url, { redirect: "manual", ...init });
      lastResponse = response;
      if (!TRANSIENT_STATUS.has(response.status)) return response;
    } catch (error) {
      // TLS outranks every not-ready code that may sit beside it in the tree:
      // an invalid certificate is an assertion failing, never a skip.
      const tlsCode = matchCode(errorCodes(error), TLS_INVALID_CODES);
      if (tlsCode) {
        throw new TlsInvalidError(`${tlsCode} for ${url}`);
      }
      lastTransportError = error;
    }
  }

  // A transient status that never cleared still counts as "the edge answered":
  // return it and let the assertions report the unexpected status.
  if (lastResponse) return lastResponse;

  const codes = errorCodes(lastTransportError);

  const dnsCode = matchCode(codes, DNS_UNRESOLVED_CODES);
  if (dnsCode) {
    throw new NotWiredUpError(`${dnsCode} for ${url} — the hostname does not resolve yet`);
  }

  const routeCode = matchCode(codes, NO_ROUTE_CODES);
  if (routeCode) {
    throw new NotWiredUpError(
      `${routeCode} for ${url} — the hostname resolves but nothing routes to it, which is what a ` +
        "runner without an IPv6 route sees while a freshly attached custom domain has published " +
        "only its AAAA record",
    );
  }

  // Everything else past DNS — refused, reset, connect/header timeout — means
  // the name resolved AND routes, i.e. the domain is wired up and something is
  // meant to be answering for it. Skipping here would let an outage or a hung
  // Worker exit 0 and pass the post-deploy check, which is the exact rubber
  // stamp this script exists to prevent. It goes red instead.
  throw new UnreachableError(
    `${[...codes].join(", ") || "connection failed"} for ${url} — the hostname resolves and routes, ` +
      "so the domain is attached, but it never returned a response",
  );
}

async function collectDistFiles(dir, base = DIST_DIR) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectDistFiles(full, base)));
    else files.push(`/${path.relative(base, full).split(path.sep).join("/")}`);
  }

  return files;
}

// The gated path MUST be a file that really exists in the deploy. The Worker
// returns the same 401 for a path that matches no asset (it gates before the
// asset layer is ever consulted), so testing an invented path would pass
// vacuously — it could not tell "gate works" apart from "asset missing".
async function findDeployedAssetPath() {
  let files;
  try {
    files = await collectDistFiles(DIST_DIR);
  } catch {
    throw new Error(`dist/ not found at ${DIST_DIR} — run \`pnpm build\` before the smoke test`);
  }

  const asset =
    files.find((file) => file.startsWith("/assets/") && file.endsWith(".css")) ??
    files.find((file) => file.startsWith("/assets/") && file.endsWith(".js")) ??
    files.find((file) => file === "/__zfb/routes.json");

  if (!asset) {
    throw new Error(`no static asset found under ${DIST_DIR} — run \`pnpm build\` before the smoke test`);
  }

  return asset;
}

// Mirrors isLocalHost() in src/index.ts. That function gates two separate
// carve-outs there -- the Secure cookie (which also requires http) and the
// DEV_PASSWORD fallback (which does not) -- so the hostname test is factored out
// on its own and each caller adds the protocol condition it actually needs.
function hasLocalHostname(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

// Plain http is tolerated only against a local `wrangler dev`, so the same
// script can be run before pushing.
function isLocalTarget(url) {
  try {
    return new URL(url).protocol === "http:" && hasLocalHostname(url);
  } catch {
    return false;
  }
}

function isLoginPage(body) {
  return LOGIN_PAGE_MARKERS.every((marker) => body.includes(marker));
}

function setCookies(response) {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

async function main() {
  console.log(`Smoke testing ${SITE_URL}`);

  // (d) TLS. Node verifies certificates by default, so every successful https
  // response below is itself the proof. That evidence is only worth anything
  // while verification is actually on — refuse to run with it disabled.
  // The local-http carve-out is itself a skip of assertion (d), so
  // SMOKE_REQUIRE_LIVE withdraws it: under require-live only real https counts.
  const localAllowed = isLocalTarget(SITE_URL) && !REQUIRE_LIVE;
  check(
    "(d) target is https (or, without SMOKE_REQUIRE_LIVE, a local dev host)",
    SITE_URL.startsWith("https://") || localAllowed,
    isLocalTarget(SITE_URL)
      ? `SMOKE_REQUIRE_LIVE is set, so the local dev host ${SITE_URL} is not an acceptable target`
      : `target is neither https nor a local dev host: ${SITE_URL}`,
  );
  check(
    "(d) TLS verification is enabled",
    process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
    "NODE_TLS_REJECT_UNAUTHORIZED=0 — certificate errors would be ignored, so TLS cannot be confirmed",
  );
  if (failures.length > 0) return;

  // (a) An unauthenticated request must NOT return the protected content.
  const rootResponse = await request(`${SITE_URL}/`);
  const rootBody = await rootResponse.text();
  const rootType = rootResponse.headers.get("content-type") ?? "";

  check(
    "(a) unauthenticated GET / is gated with 401",
    rootResponse.status === 401,
    `expected 401, got ${rootResponse.status}`,
  );
  check(
    "(a) unauthenticated GET / returns the login page, not site content",
    isLoginPage(rootBody),
    `body did not contain the login page markers (content-type: ${rootType || "none"})`,
  );

  // (b) The regression test that matters: a real static asset must be gated
  // too. If run_worker_first ever flips to false, the asset layer answers this
  // request with 200 and the gate is silently bypassed — this is the assertion
  // that catches it.
  const assetPath = await findDeployedAssetPath();
  const assetResponse = await request(`${SITE_URL}${assetPath}`);
  const assetBody = await assetResponse.text();
  const assetType = assetResponse.headers.get("content-type") ?? "";

  console.log(`Static asset under test: ${assetPath}`);
  check(
    `(b) static asset ${assetPath} is gated with 401`,
    assetResponse.status === 401,
    `expected 401, got ${assetResponse.status} — run_worker_first may have regressed to false, ` +
      "letting the asset layer serve files before the gate runs",
  );
  check(
    "(b) static asset returns the login page, not the asset bytes",
    isLoginPage(assetBody) && assetType.startsWith("text/html"),
    `content-type was "${assetType || "none"}" and the body did not match the login page — ` +
      "the asset appears to be served directly, bypassing the gate",
  );

  // (c) The auth endpoint is live and rejecting. A random value, so no
  // password-shaped string is committed and none ever reaches a query string.
  const authResponse = await request(`${SITE_URL}/__auth`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: `smoke-wrong-${randomUUID()}`, next: "/" }),
  });
  const authCookies = setCookies(authResponse);

  check(
    "(c) POST /__auth with a wrong password is rejected with 401",
    authResponse.status === 401,
    `expected 401, got ${authResponse.status}`,
  );
  check(
    "(c) a wrong password does not issue the marker cookie",
    !authCookies.some((cookie) => cookie.startsWith(`${MARKER_COOKIE}=`)),
    `response set ${MARKER_COOKIE} for an incorrect password`,
  );

  const malformedAuthResponse = await request(`${SITE_URL}/__auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const malformedAuthBody = await malformedAuthResponse.text();
  const malformedAuthCookies = setCookies(malformedAuthResponse);

  check(
    "(c) malformed POST /__auth is rejected with 401",
    malformedAuthResponse.status === 401,
    `expected 401, got ${malformedAuthResponse.status}`,
  );
  check(
    "(c) malformed POST /__auth returns the login page",
    isLoginPage(malformedAuthBody),
    "response body did not contain the login page markers",
  );
  check(
    "(c) malformed POST /__auth does not issue the marker cookie",
    !malformedAuthCookies.some((cookie) => cookie.startsWith(`${MARKER_COOKIE}=`)),
    `response set ${MARKER_COOKIE} for malformed input`,
  );

  // (e) The committed development password must not open a deployed gate.
  // Every check above still passes on a deploy whose SITE_PASSWORD secret was
  // never bound: the gate is up, unauthenticated requests are 401, assets are
  // gated -- and the password that opens it is published in this repository.
  // That is the one failure mode with no visible signal (issue #18), so it needs
  // an assertion that submits the constant on purpose. On a local dev host the
  // fallback is the intended behavior, so the assertion inverts to match.
  if (hasLocalHostname(SITE_URL)) {
    // Not merely unassertable but pointless to send: against a local host the
    // fallback is live, so the request would authenticate and take a real
    // marker cookie for nothing.
    console.log("SKIP  (e) committed dev password — it is meant to work against a local dev host");
  } else {
    const devPasswordResponse = await request(`${SITE_URL}/__auth`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: COMMITTED_DEV_PASSWORD, next: "/" }),
    });
    const devPasswordCookies = setCookies(devPasswordResponse);

    check(
      "(e) POST /__auth with the committed dev password is rejected with 401",
      devPasswordResponse.status === 401,
      `expected 401, got ${devPasswordResponse.status} — the gate is accepting a password that is ` +
        "public in this repository. Either the deployed code predates the host guard (check " +
        "`wrangler deployments list` and redeploy), or SITE_PASSWORD is deliberately set to the " +
        "published default (set it to something else with `wrangler secret put SITE_PASSWORD`; " +
        "no redeploy needed)",
    );
    check(
      "(e) the committed dev password does not issue the marker cookie",
      !devPasswordCookies.some((cookie) => cookie.startsWith(`${MARKER_COOKIE}=`)),
      `response set ${MARKER_COOKIE} for the repository's published development password`,
    );
  }

  // (f) No value committed to this repository may open the gate. The marker cookie
  // is checked BEFORE any password logic, so while it was a constant it was the
  // strongest bypass in the gate and none of (a)-(e) could see it: every one of
  // them passes against a deploy that hands out site content to this cookie. The
  // marker is now HMAC(password, label), so this must be rejected on every origin
  // — unlike (e), there is no local carve-out, because no password derives it.
  const forgedResponse = await request(`${SITE_URL}/`, {
    headers: { cookie: `${MARKER_COOKIE}=${RETIRED_AUTH_MARKER}` },
  });
  const forgedBody = await forgedResponse.text();

  check(
    "(f) the retired committed marker cookie does not open the gate",
    forgedResponse.status === 401 && isLoginPage(forgedBody),
    `expected the 401 login page, got ${forgedResponse.status} — a cookie value published in ` +
      "this repository is being accepted, so anyone who can read the source can bypass the " +
      "password entirely. The deployed code predates the password-derived marker; redeploy",
  );

  if (localAllowed) {
    console.log("SKIP  (d) TLS not applicable — target is a local http dev server");
  } else {
    pass("(d) TLS certificate is valid for the host (verified https responses received)");
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof NotWiredUpError) {
    skip(`${SITE_URL} is not reachable yet (${error.message}). Attach the custom domain, then re-run.`);
  } else if (error instanceof TlsInvalidError) {
    fail("(d) TLS certificate is valid for the host", error.message);
  } else if (error instanceof UnreachableError) {
    fail("live site responds", error.message);
  } else {
    fail("smoke test crashed", error.message);
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}

console.log("\nAll checks passed — the gate is active on the live site.");
