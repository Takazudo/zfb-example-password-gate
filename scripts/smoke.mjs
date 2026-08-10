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
// deployed asset path). Override the target with SMOKE_URL.

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

const SITE_URL = (
  process.env.SMOKE_URL ?? "https://zfb-example-password-gate.takazudomodular.com"
).replace(/\/+$/, "");
const DIST_DIR = path.resolve(import.meta.dirname, "..", "dist");

const LOGIN_PAGE_MARKERS = ["<title>Preview password</title>", 'action="/__auth"'];
const MARKER_COOKIE = "zfb_preview_gate";

const ATTEMPTS = 6;
const BACKOFF_MS = [3000, 6000, 10000, 15000, 20000];

// Cloudflare emits these while a freshly attached custom domain is still
// propagating; retry them rather than reporting a broken gate.
const TRANSIENT_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

// The host is unreachable at the DNS/TCP layer — the domain is not wired up
// yet. This is the self-skip path, not a failure.
const NOT_WIRED_UP_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

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
  console.log(`::notice::Smoke test skipped — ${reason}`);
  console.log(`Skipped: ${SITE_URL} is not serving yet. Nothing was asserted.`);
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorCode(error) {
  return error?.cause?.code ?? error?.code ?? null;
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
      const code = errorCode(error);
      if (TLS_INVALID_CODES.has(code)) {
        throw new TlsInvalidError(`${code} for ${url}`);
      }
      lastTransportError = error;
    }
  }

  // A transient status that never cleared still counts as "the edge answered":
  // return it and let the assertions report the unexpected status.
  if (lastResponse) return lastResponse;

  const code = errorCode(lastTransportError);
  if (NOT_WIRED_UP_CODES.has(code)) {
    throw new NotWiredUpError(`${code} for ${url}`);
  }
  throw lastTransportError ?? new Error(`could not reach ${url}`);
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

// Plain http is tolerated only against a local `wrangler dev`, so the same
// script can be run before pushing. Mirrors isLocalHost() in src/index.ts,
// which makes the identical carve-out for the Secure cookie.
function isLocalTarget(url) {
  try {
    const { protocol, hostname } = new URL(url);
    const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    return protocol === "http:" && local;
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
  check(
    "(d) target is https (or a local dev host)",
    SITE_URL.startsWith("https://") || isLocalTarget(SITE_URL),
    `SMOKE_URL is neither https nor a local dev host: ${SITE_URL}`,
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

  if (isLocalTarget(SITE_URL)) {
    console.log("SKIP  (d) TLS not applicable — target is a local http dev server");
  } else {
    pass("(d) TLS certificate is valid for the host (verified https responses received)");
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof NotWiredUpError) {
    skip(`${SITE_URL} does not resolve yet (${error.message}). Attach the custom domain, then re-run.`);
  } else if (error instanceof TlsInvalidError) {
    fail("(d) TLS certificate is valid for the host", error.message);
  } else {
    fail("smoke test crashed", error.message);
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}

console.log("\nAll checks passed — the gate is active on the live site.");
