import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker, {
  deriveMarker,
  resolveExpectedPassword,
  sanitizeNext,
  timingSafeEqual,
} from "./index";

// The committed fallback, spelled out rather than imported: these tests assert
// that this exact public string cannot open a deployed gate, which is a claim
// about the literal in the repo, not about whatever the constant happens to hold.
const DEV_PASSWORD = "preview-open-sesame";

// The fixed marker this gate shipped with before the cookie became password-derived.
// It was readable by anyone with repo access and opened any deployment (issue #23);
// it must never validate again, so it is pinned here as a permanent regression guard.
const RETIRED_AUTH_MARKER = "pg_01_hL7G9sR4vK2pQ8mN6bD3xA";

describe("sanitizeNext", () => {
  it("passes through an unchanged path with query and hash", () => {
    expect(sanitizeNext("/docs?a=1#b")).toBe("/docs?a=1#b");
  });

  it("rejects a protocol-relative URL (open-redirect case from issue #5)", () => {
    expect(sanitizeNext("//evil.example")).toBe("/");
  });

  it("rejects an absolute URL", () => {
    expect(sanitizeNext("https://evil.example")).toBe("/");
  });

  it("rejects a relative path with no leading slash", () => {
    expect(sanitizeNext("relative/path")).toBe("/");
  });

  it("rejects a backslash", () => {
    expect(sanitizeNext("/\\evil")).toBe("/");
  });

  it("rejects CR, LF, NUL and \\x7f anywhere in the value", () => {
    expect(sanitizeNext("/a\rb")).toBe("/");
    expect(sanitizeNext("/a\nb")).toBe("/");
    expect(sanitizeNext("/a\x00b")).toBe("/");
    expect(sanitizeNext("/a\x7fb")).toBe("/");
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings", async () => {
    expect(await timingSafeEqual("secret", "secret")).toBe(true);
  });

  it("returns false for different strings of equal length", async () => {
    expect(await timingSafeEqual("secret", "sesame")).toBe(false);
  });

  it("returns false for different lengths", async () => {
    expect(await timingSafeEqual("short", "much-longer-string")).toBe(false);
  });

  it("compares multi-byte / unicode input correctly", async () => {
    expect(await timingSafeEqual("パスワード", "パスワード")).toBe(true);
    expect(await timingSafeEqual("パスワード", "ぱすわーど")).toBe(false);
  });
});

describe("default export fetch handler", () => {
  const SITE_PASSWORD = "test-password";

  // `null` models the secret being unbound entirely (the issue #18 state); a
  // string models it being bound to that value, including "" and whitespace.
  function makeEnv(sitePassword: string | null = SITE_PASSWORD) {
    const assetsFetch = vi.fn(async () => new Response("asset-body"));
    const env = {
      ASSETS: { fetch: assetsFetch },
      ...(sitePassword === null ? {} : { SITE_PASSWORD: sitePassword }),
    } as unknown as Env & { SITE_PASSWORD?: string };
    return { env, assetsFetch };
  }

  function extractCookiePair(setCookieHeader: string): { name: string; header: string } {
    const pair = setCookieHeader.split(";")[0] ?? "";
    const [name] = pair.split("=");
    return { name: name ?? "", header: pair };
  }

  async function login(
    env: Env & { SITE_PASSWORD?: string },
    options: { password?: string; next?: string; url?: string } = {},
  ) {
    const { password = SITE_PASSWORD, next = "/", url = "https://example.com/__auth" } = options;
    const body = new URLSearchParams({ password, next });
    const request = new Request(url, { method: "POST", body });
    return worker.fetch(request, env);
  }

  it("returns 401 with text/html when no cookie is present, and never calls assetsFetch", async () => {
    const { env, assetsFetch } = makeEnv();
    const request = new Request("https://example.com/docs");
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it("serves the asset response when the request carries the valid marker cookie", async () => {
    const { env, assetsFetch } = makeEnv();
    const loginResponse = await login(env);
    const setCookie = loginResponse.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    const { header } = extractCookiePair(setCookie as string);

    const request = new Request("https://example.com/docs", {
      headers: { Cookie: header },
    });
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset-body");
    expect(assetsFetch).toHaveBeenCalledTimes(1);
  });

  it("returns 401 and does not reach assets when the cookie value is wrong", async () => {
    const { env, assetsFetch } = makeEnv();
    const loginResponse = await login(env);
    const setCookie = loginResponse.headers.get("Set-Cookie");
    const { name } = extractCookiePair(setCookie as string);

    const request = new Request("https://example.com/docs", {
      headers: { Cookie: `${name}=wrong-value` },
    });
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(401);
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it("302s with a sanitized Location and an HttpOnly, SameSite=Lax cookie on a correct password", async () => {
    const { env } = makeEnv();
    const response = await login(env, { next: "/docs?a=1" });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/docs?a=1");
    const setCookie = response.headers.get("Set-Cookie");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("returns 401 and no Set-Cookie on a wrong password", async () => {
    const { env } = makeEnv();
    const response = await login(env, { password: "wrong-password" });

    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it.each([
    {
      name: "an unsupported Content-Type",
      headers: new Headers({ "Content-Type": "application/json" }),
      body: "{}",
    },
    {
      name: "no Content-Type",
      headers: new Headers(),
      body: new Uint8Array([0x70, 0x61, 0x73, 0x73]),
    },
  ])("returns the 401 login response for $name", async ({ headers, body }) => {
    const { env, assetsFetch } = makeEnv();
    const request = new Request("https://example.com/__auth", {
      method: "POST",
      headers,
      body,
    });
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.text()).toContain("That password did not match.");
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it("redirects to / when next is hostile, even with the correct password", async () => {
    const { env } = makeEnv();
    const response = await login(env, { next: "//evil.example" });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
  });

  it("omits Secure over http://localhost but includes it over https://", async () => {
    const { env: httpEnv } = makeEnv();
    const httpResponse = await login(httpEnv, { url: "http://localhost/__auth" });
    expect(httpResponse.headers.get("Set-Cookie")).not.toContain("Secure");

    const { env: httpsEnv } = makeEnv();
    const httpsResponse = await login(httpsEnv, { url: "https://example.com/__auth" });
    expect(httpsResponse.headers.get("Set-Cookie")).toContain("Secure");
  });
});

describe("resolveExpectedPassword", () => {
  const env = (SITE_PASSWORD?: string) => ({ SITE_PASSWORD }) as Env & { SITE_PASSWORD?: string };
  const at = (href: string) => new URL(href);

  it("returns the secret when it is set, on any origin", () => {
    expect(resolveExpectedPassword(env("real"), at("https://example.com/"))).toBe("real");
    expect(resolveExpectedPassword(env("real"), at("http://localhost/"))).toBe("real");
  });

  it("returns the secret verbatim, without trimming a deliberately spaced password", () => {
    expect(resolveExpectedPassword(env("  spaced  "), at("https://example.com/"))).toBe("  spaced  ");
  });

  it.each([undefined, "", "   ", "\t\n"])(
    "returns null on a deployed origin when the secret is %j",
    (secret) => {
      expect(resolveExpectedPassword(env(secret), at("https://example.com/"))).toBeNull();
    },
  );

  it.each(["http://localhost/", "http://127.0.0.1/", "http://[::1]/"])(
    "falls back to the dev password at %s when the secret is unset",
    (href) => {
      expect(resolveExpectedPassword(env(undefined), at(href))).toBe(DEV_PASSWORD);
    },
  );

  // The protocol half of the pair: url.hostname comes from the client-controlled
  // Host header, so a loopback name over https is treated as a deployment.
  it.each(["https://localhost/", "https://127.0.0.1/"])(
    "refuses the dev fallback at %s — a loopback name over https is not local dev",
    (href) => {
      expect(resolveExpectedPassword(env(undefined), at(href))).toBeNull();
    },
  );
});

describe("deriveMarker", () => {
  it("is a 64-char hex digest that depends on the password", async () => {
    const a = await deriveMarker("one");
    const b = await deriveMarker("two");

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("is stable for the same password", async () => {
    expect(await deriveMarker("same")).toBe(await deriveMarker("same"));
  });

  it("never contains the password", async () => {
    expect(await deriveMarker("hunter2")).not.toContain("hunter2");
  });
});

describe("gate fails closed when SITE_PASSWORD is unbound (issue #18)", () => {
  function makeEnv(sitePassword: string | null) {
    const assetsFetch = vi.fn(async () => new Response("asset-body"));
    const env = {
      ASSETS: { fetch: assetsFetch },
      ...(sitePassword === null ? {} : { SITE_PASSWORD: sitePassword }),
    } as unknown as Env & { SITE_PASSWORD?: string };
    return { env, assetsFetch };
  }

  function login(
    env: Env & { SITE_PASSWORD?: string },
    password: string,
    url = "https://example.com/__auth",
  ) {
    const body = new URLSearchParams({ password, next: "/" });
    return worker.fetch(new Request(url, { method: "POST", body }), env);
  }

  // The diagnostic is deliberate output, so keep it out of the test log while
  // still proving it fires. Installed per test and restored after, so it cannot
  // silence console.error for any other describe in this file.
  let consoleError: MockInstance<typeof console.error>;
  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  // The whole point of the issue: preview-open-sesame is public in this repo, so
  // an unbound secret must not turn it into a working production password.
  it.each([
    { label: "unbound", secret: null },
    { label: "empty", secret: "" },
    { label: "whitespace-only", secret: "   " },
  ])("refuses the committed dev password on a deployed host when the secret is $label", async ({ secret }) => {
    const { env, assetsFetch } = makeEnv(secret);
    const response = await login(env, DEV_PASSWORD);

    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it("refuses an arbitrary password too — nothing opens an unconfigured gate", async () => {
    const { env } = makeEnv(null);
    const response = await login(env, "anything-at-all");

    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("logs the misconfiguration so wrangler tail shows a cause", async () => {
    const { env } = makeEnv(null);
    await login(env, DEV_PASSWORD);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toContain("SITE_PASSWORD is not set");
  });

  it.each(["http://localhost/__auth", "http://127.0.0.1/__auth"])(
    "still accepts the dev password at %s so wrangler dev keeps working",
    async (url) => {
      const { env } = makeEnv(null);
      const response = await login(env, DEV_PASSWORD, url);

      expect(response.status).toBe(302);
      expect(response.headers.get("Set-Cookie")).toContain(
        `zfb_preview_gate=${await deriveMarker(DEV_PASSWORD)}`,
      );
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it("prefers a bound secret over the dev password even on localhost", async () => {
    const { env } = makeEnv("real-password");

    expect((await login(env, DEV_PASSWORD, "http://localhost/__auth")).status).toBe(401);
    expect((await login(env, "real-password", "http://localhost/__auth")).status).toBe(302);
  });
});

describe("marker cookie is derived from the password, not a committed constant (issue #23)", () => {
  function makeEnv(sitePassword: string | null) {
    const assetsFetch = vi.fn(async () => new Response("asset-body"));
    const env = {
      ASSETS: { fetch: assetsFetch },
      ...(sitePassword === null ? {} : { SITE_PASSWORD: sitePassword }),
    } as unknown as Env & { SITE_PASSWORD?: string };
    return { env, assetsFetch };
  }

  const get = (env: Env & { SITE_PASSWORD?: string }, cookie: string, url = "https://example.com/docs") =>
    worker.fetch(new Request(url, { headers: { Cookie: cookie } }), env);

  // The regression this whole change exists for: the retired constant is public
  // in this repository and used to open every deployment outright.
  it.each([
    { label: "a bound secret", secret: "real-password" },
    { label: "an unbound secret", secret: null },
  ])("rejects the retired committed marker under $label", async ({ secret }) => {
    const { env, assetsFetch } = makeEnv(secret);
    const response = await get(env, `zfb_preview_gate=${RETIRED_AUTH_MARKER}`);

    expect(response.status).toBe(401);
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it("accepts the marker derived from the bound secret", async () => {
    const { env, assetsFetch } = makeEnv("real-password");
    const response = await get(env, `zfb_preview_gate=${await deriveMarker("real-password")}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset-body");
    expect(assetsFetch).toHaveBeenCalledTimes(1);
  });

  // Rotation for free: the old cookie stops validating the moment the password changes.
  it("rejects a marker derived from the previous password after rotation", async () => {
    const stale = await deriveMarker("old-password");
    const { env, assetsFetch } = makeEnv("new-password");
    const response = await get(env, `zfb_preview_gate=${stale}`);

    expect(response.status).toBe(401);
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  // This is the property the docs claim. Before the marker was derived it was
  // false: an unbound secret closed the login form but left every cookie working.
  it("validates no cookie at all on a deployed origin when the secret is unbound", async () => {
    const { env, assetsFetch } = makeEnv(null);

    for (const value of [RETIRED_AUTH_MARKER, await deriveMarker(DEV_PASSWORD), "", "guess"]) {
      const response = await get(env, `zfb_preview_gate=${value}`);
      expect(response.status).toBe(401);
    }
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it("still admits a locally derived marker on a local dev origin", async () => {
    const { env } = makeEnv(null);
    const marker = await deriveMarker(DEV_PASSWORD);
    const response = await get(env, `zfb_preview_gate=${marker}`, "http://localhost/docs");

    expect(response.status).toBe(200);
  });

  it("round-trips: the cookie handed out by a successful login opens the gate", async () => {
    const { env } = makeEnv("real-password");
    const body = new URLSearchParams({ password: "real-password", next: "/" });
    const loginResponse = await worker.fetch(
      new Request("https://example.com/__auth", { method: "POST", body }),
      env,
    );
    const cookie = (loginResponse.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

    expect(loginResponse.status).toBe(302);
    expect((await get(env, cookie)).status).toBe(200);
  });
});
