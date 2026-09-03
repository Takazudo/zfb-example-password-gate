import { parseCookieHeader, serializeCookie } from "./cookies";

const AUTH_PATH = "/__auth";
const COOKIE_NAME = "zfb_preview_gate";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const DEV_PASSWORD = "preview-open-sesame";

// Domain-separation label for the cookie marker. This is NOT a secret and is not
// what makes the cookie unguessable -- the password is. Bump the suffix to force
// every outstanding cookie to be re-issued without changing the password.
const MARKER_LABEL = "zfb-preview-gate-marker-v1";

// SITE_PASSWORD is a secret, not a wrangler.toml var, so keep it out of config.
type RuntimeEnv = Env & {
  SITE_PASSWORD?: string;
};

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);

    if (await hasValidMarker(request, env, url)) {
      return withPrivateCaching(await env.ASSETS.fetch(request));
    }

    if (url.pathname === AUTH_PATH && request.method === "POST") {
      return handleAuth(request, env);
    }

    return loginResponse(sanitizeNext(url.pathname + url.search));
  },
} satisfies ExportedHandler<RuntimeEnv>;

// Gated content must never sit in a shared cache. env.ASSETS serves assets with
// `Cache-Control: public, max-age=0, must-revalidate` and no Vary on Cookie, so
// Cloudflare's edge stored authorized 200s under a key that ignored the gate and
// replayed them to requests the Worker refuses. Observed live: after the marker
// fix deployed, a forged-cookie request still got a 200 with cf-cache-status HIT
// while the Worker itself was answering 401 (issue #25). The 401 path already
// sets no-store; this gives the authorized path the same treatment.
function withPrivateCaching(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("Cache-Control", "private, no-store");

  const vary = copy.headers.get("Vary");
  const parts = vary ? vary.split(",").map((part) => part.trim()).filter(Boolean) : [];
  if (!parts.some((part) => part.toLowerCase() === "cookie")) parts.push("Cookie");
  copy.headers.set("Vary", parts.join(", "));

  return copy;
}

// The marker is derived from the password rather than being a constant, so there
// is no value in this repository that opens a deployed gate (issue #23). Two
// consequences fall out for free: when no password can be resolved -- an unbound
// SITE_PASSWORD on a deployed host -- no cookie is valid either, so the gate is
// genuinely closed rather than merely refusing the login form; and changing the
// password invalidates every outstanding cookie, so rotation needs no separate step.
async function hasValidMarker(request: Request, env: RuntimeEnv, url: URL): Promise<boolean> {
  const presented = parseCookieHeader(request.headers.get("Cookie")).get(COOKIE_NAME);
  if (typeof presented !== "string" || presented === "") return false;

  const expectedPassword = resolveExpectedPassword(env, url);
  if (expectedPassword === null) return false;

  return timingSafeEqual(presented, await deriveMarker(expectedPassword));
}

// HMAC-SHA256(password, label). The password is the key, so the marker cannot be
// computed without it, and it never appears in the cookie.
export async function deriveMarker(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(MARKER_LABEL));

  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function handleAuth(request: Request, env: RuntimeEnv): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return loginResponse("/", true);
  }

  const password = form.get("password");
  const nextValue = form.get("next");
  const next = sanitizeNext(typeof nextValue === "string" ? nextValue : "/");
  const url = new URL(request.url);
  const expectedPassword = resolveExpectedPassword(env, url);

  if (expectedPassword === null) {
    // The only state the gate cannot serve. Log it so `wrangler tail` shows a
    // cause; without this the site looks normal and simply rejects everyone.
    console.error(
      `SITE_PASSWORD is not set for ${url.host} — refusing every login. ` +
        "Set it with `wrangler secret put SITE_PASSWORD`.",
    );
    return loginResponse(next, true);
  }

  if (typeof password !== "string" || !(await timingSafeEqual(password, expectedPassword))) {
    return loginResponse(next, true);
  }

  const headers = gateHeaders();
  headers.set("Location", next);
  headers.append(
    "Set-Cookie",
    serializeCookie(COOKIE_NAME, await deriveMarker(expectedPassword), {
      path: "/",
      maxAge: COOKIE_MAX_AGE_SECONDS,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookie(url),
    }),
  );

  return new Response(null, { status: 302, headers });
}

// Returns the password that opens the gate, or null for "nothing opens it".
//
// DEV_PASSWORD is committed to this public repo, so it must never authenticate
// anywhere but a local dev server. If the SITE_PASSWORD secret is unbound,
// deleted, its name typo'd, or set to blank/whitespace, a deployed origin gets
// null and nothing opens the gate -- no login succeeds and no cookie validates
// (issue #18). A blank secret is treated as unset on every origin, so it takes
// the same path an absent one would; on a local dev origin that still means the
// DEV_PASSWORD fallback, which is the point of the fallback. The secret is
// returned untrimmed, so a password with deliberate surrounding space works as set.
export function resolveExpectedPassword(env: RuntimeEnv, url: URL): string | null {
  const fromSecret = typeof env.SITE_PASSWORD === "string" ? env.SITE_PASSWORD : "";
  if (fromSecret.trim() !== "") return fromSecret;

  return isLocalDevOrigin(url) ? DEV_PASSWORD : null;
}

export function sanitizeNext(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "\\" || code < 0x20 || code === 0x7f) return "/";
  }

  return value;
}

export async function timingSafeEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let diff = providedBytes.length ^ expectedBytes.length;

  for (let index = 0; index < providedBytes.length; index += 1) {
    diff |= (providedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }

  return diff === 0;
}

function shouldUseSecureCookie(url: URL): boolean {
  return !isLocalDevOrigin(url);
}

// Plain http on a loopback name. url.hostname comes from the Host header, which
// the client controls, so the protocol half matters: a real deployment is always
// https, and pairing the two means a spoofed `Host: localhost` cannot reach the
// dev fallback even if this Worker later sits behind a wildcard route or a proxy
// that forwards Host through. Note this makes an https local dev server behave
// like a deployment -- see the README; `wrangler dev` is plain http by default
// and wrangler.toml pins local_protocol = "http".
function isLocalDevOrigin(url: URL): boolean {
  return url.protocol === "http:" && isLocalHost(url.hostname);
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function loginResponse(next: string, invalid = false): Response {
  const headers = gateHeaders("text/html; charset=utf-8");
  return new Response(renderLoginPage(next, invalid), { status: 401, headers });
}

function gateHeaders(contentType?: string): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
    Vary: "Cookie",
  });

  if (contentType) headers.set("Content-Type", contentType);
  return headers;
}

function renderLoginPage(next: string, invalid: boolean): string {
  const escapedNext = escapeHtml(next);
  const error = invalid ? `<p class="error">That password did not match.</p>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Preview password</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#20242a;background:#f6f7f8;color-scheme:light}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
main{width:min(100%,390px);background:#fff;border:1px solid #d9dee3;border-radius:8px;padding:28px;box-shadow:0 18px 45px rgba(30,39,50,.08)}
p{color:#5d6470;line-height:1.55;margin:0 0 20px}
h1{font-size:1.45rem;line-height:1.2;margin:0 0 10px;color:#181b20}
label{display:block;font-size:.84rem;font-weight:650;margin-bottom:8px;color:#303741}
input[type=password]{box-sizing:border-box;width:100%;border:1px solid #b8c0ca;border-radius:6px;padding:11px 12px;font:inherit;color:#1f242b;background:#fff}
button{width:100%;margin-top:14px;border:0;border-radius:6px;padding:11px 14px;background:#176a55;color:white;font:inherit;font-weight:700;cursor:pointer}
.error{border:1px solid #e2b6b1;background:#fff3f1;color:#913b32;border-radius:6px;padding:10px 12px;margin-bottom:16px}
</style>
</head>
<body>
<main>
<h1>Preview password</h1>
<p>This static preview is shared with reviewers only.</p>
${error}
<form method="post" action="${AUTH_PATH}">
<input type="hidden" name="next" value="${escapedNext}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus>
<button type="submit">Enter preview</button>
</form>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
