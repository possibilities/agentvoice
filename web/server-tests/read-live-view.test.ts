import { expect, test } from "bun:test";
import { readLiveView } from "../src/read-live-view.ts";
import type { LiveView } from "../src/types.ts";

const view: LiveView = { phase: "detached", id: "view", voice: [], agent: [] };

test("an accepted large body may finish after the response-header timeout", async () => {
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          const finish = () => {
            if (signal?.aborted) controller.error(signal.reason);
            else {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(view)));
              controller.close();
            }
          };
          setTimeout(finish, 25);
        },
      }),
      { status: 200, headers: { ETag: 'W/"large"' } },
    );
  };

  const result = await readLiveView(new AbortController().signal, undefined, {
    fetcher,
    headerTimeoutMs: 5,
  });
  expect(result).toEqual({ unchanged: false, etag: 'W/"large"', view });
});

test("conditional reads retain the current snapshot without decoding a body", async () => {
  let requestedEtag: string | null = null;
  const result = await readLiveView(new AbortController().signal, 'W/"current"', {
    fetcher: async (_input, init) => {
      requestedEtag = new Headers(init?.headers).get("If-None-Match");
      return new Response(null, { status: 304, headers: { ETag: 'W/"current"' } });
    },
  });
  expect(String(requestedEtag)).toBe('W/"current"');
  expect(result).toEqual({ unchanged: true, etag: 'W/"current"' });
});

test("an accepted response still has a generous body deadline", async () => {
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) =>
    new Response(
      new ReadableStream({
        start(controller) {
          setTimeout(() => {
            if (init?.signal?.aborted) controller.error(init.signal.reason);
          }, 20);
        },
      }),
    );
  await expect(
    readLiveView(new AbortController().signal, undefined, {
      fetcher,
      headerTimeoutMs: 5,
      bodyTimeoutMs: 5,
    }),
  ).rejects.toBeDefined();
});
