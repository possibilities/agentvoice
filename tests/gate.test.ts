import { describe, expect, test } from "bun:test";
import { gateRequest, tokenMatches } from "../src/core/gate.ts";

describe("gateRequest", () => {
  test("accepts a plain local request", () => {
    expect(gateRequest(null, "127.0.0.1:7890", 7890)).toEqual({ ok: true });
    expect(gateRequest(null, "localhost:7890", 7890)).toEqual({ ok: true });
  });

  test("rejects any Origin, even a local-looking or opaque one", () => {
    expect(gateRequest("https://evil.example", "127.0.0.1:7890", 7890).ok).toBe(false);
    expect(gateRequest("http://127.0.0.1:7890", "127.0.0.1:7890", 7890).ok).toBe(false);
    expect(gateRequest("null", "127.0.0.1:7890", 7890).ok).toBe(false);
    expect(gateRequest("", "127.0.0.1:7890", 7890).ok).toBe(false);
  });

  test("rejects rebound, wrong-port, and missing hosts", () => {
    expect(gateRequest(null, "rebound.example:7890", 7890).ok).toBe(false);
    expect(gateRequest(null, "127.0.0.1:9999", 7890).ok).toBe(false);
    expect(gateRequest(null, "127.0.0.1", 7890).ok).toBe(false);
    expect(gateRequest(null, null, 7890).ok).toBe(false);
  });
});

describe("tokenMatches", () => {
  test("matches only the exact token", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
    expect(tokenMatches("secreT", "secret")).toBe(false);
    expect(tokenMatches("secret-and-more", "secret")).toBe(false);
  });

  test("never matches an absent or empty token", () => {
    expect(tokenMatches(null, "secret")).toBe(false);
    expect(tokenMatches("", "secret")).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
    expect(tokenMatches("anything", "")).toBe(false);
  });
});
