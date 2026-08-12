import { describe, expect, it } from "vitest";
import { parseCookieHeader, serializeCookie } from "./cookies";

describe("parseCookieHeader", () => {
  it("returns an empty map for a null header", () => {
    expect(parseCookieHeader(null).size).toBe(0);
  });

  it("skips a segment with no '='", () => {
    const cookies = parseCookieHeader("a=1; noequals; b=2");
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("b")).toBe("2");
    expect(cookies.has("noequals")).toBe(false);
    expect(cookies.size).toBe(2);
  });

  it("skips an empty name", () => {
    const cookies = parseCookieHeader("=value; a=1");
    expect(cookies.has("")).toBe(false);
    expect(cookies.get("a")).toBe("1");
  });

  it("trims names and values", () => {
    const cookies = parseCookieHeader("  a  =  1  ; b=2");
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("b")).toBe("2");
  });

  it("decodes percent-encoded values", () => {
    const cookies = parseCookieHeader("a=hello%20world");
    expect(cookies.get("a")).toBe("hello world");
  });

  it("falls back to the raw string on a malformed percent sequence", () => {
    const cookies = parseCookieHeader("a=%E0%A4%A");
    expect(cookies.get("a")).toBe("%E0%A4%A");
  });

  it("keeps everything after the first '=' when the value contains '='", () => {
    const cookies = parseCookieHeader("a=1=2=3");
    expect(cookies.get("a")).toBe("1=2=3");
  });
});

describe("serializeCookie", () => {
  it("percent-encodes the value", () => {
    expect(serializeCookie("name", "hello world")).toBe("name=hello%20world");
  });

  it("emits only 'name=value' when no options are given", () => {
    expect(serializeCookie("name", "value")).toBe("name=value");
  });

  it("floors maxAge", () => {
    expect(serializeCookie("name", "value", { maxAge: 12.9 })).toBe("name=value; Max-Age=12");
  });

  it("includes Path, HttpOnly, SameSite, Secure when requested", () => {
    const result = serializeCookie("name", "value", {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: true,
    });
    expect(result).toContain("Path=/");
    expect(result).toContain("HttpOnly");
    expect(result).toContain("SameSite=Lax");
    expect(result).toContain("Secure");
  });

  it("omits Path, HttpOnly, SameSite, Secure when not requested", () => {
    const result = serializeCookie("name", "value");
    expect(result).not.toContain("Path=");
    expect(result).not.toContain("HttpOnly");
    expect(result).not.toContain("SameSite=");
    expect(result).not.toContain("Secure");
  });
});
