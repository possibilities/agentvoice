import { expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { configuredTailnetOrigin } from "../src/web-target.ts";
import { isLocalRequest } from "../web/server/local-origin.ts";

const env = {
  AGENTVOICE_WEB_NAME: "agentvoice",
  PORTLESS_URL: "https://agentvoice.localhost",
  PORTLESS_TAILSCALE_URL: "https://greybird.example.ts.net:8443",
};

function request(host: string, origin?: string, forwarded = "https") {
  return {
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      host,
      ...(origin ? { origin } : {}),
      "x-forwarded-proto": forwarded,
      "sec-fetch-site": "same-origin",
    },
  } as unknown as IncomingMessage;
}

test("accepts only the exact Portless-injected tailnet origin", () => {
  const tailnet = env.PORTLESS_TAILSCALE_URL;
  expect(configuredTailnetOrigin(env)).toBe(tailnet);
  expect(isLocalRequest(request("greybird.example.ts.net:8443", tailnet), env)).toBe(true);
  expect(isLocalRequest(request("greybird.example.ts.net:8444", tailnet), env)).toBe(false);
  expect(isLocalRequest(request("greybird.example.ts.net:8443", "https://other.ts.net"), env)).toBe(
    false,
  );
  expect(isLocalRequest(request("greybird.example.ts.net:8443", tailnet, "http"), env)).toBe(false);
});

test("rejects malformed or non-tailnet injected URLs", () => {
  expect(
    configuredTailnetOrigin({ PORTLESS_TAILSCALE_URL: "https://example.com" }),
  ).toBeUndefined();
  expect(
    configuredTailnetOrigin({ PORTLESS_TAILSCALE_URL: "https://greybird.example.ts.net/path" }),
  ).toBeUndefined();
});
