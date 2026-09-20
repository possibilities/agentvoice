import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { liveApi } from "../server/api.ts";
import type { LiveView } from "../src/types.ts";

test("large live snapshots are compressed and unchanged polls return 304", async () => {
  let serializations = 0;
  const counted = (value: LiveView): LiveView =>
    Object.defineProperty(value, "toJSON", {
      value: () => {
        serializations++;
        return { ...value };
      },
    });
  let view: LiveView = counted({
    phase: "detached",
    id: "view",
    voice: [],
    agent: [
      {
        id: "history",
        role: "tool",
        content: "",
        status: "complete",
        toolActivity: {
          name: "Command",
          detail: "history",
          state: "complete",
          sections: [{ label: "Output", content: "history".repeat(1_750_000) }],
        },
      },
    ],
  });
  let handler = liveApi({ read: async () => view }, process.env);
  const server = createServer((request, response) =>
    handler(request, response, () => response.writeHead(404).end()),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const url = `http://127.0.0.1:${address.port}/api/live`;
    const first = await fetch(url, { headers: { "Accept-Encoding": "gzip" } });
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Encoding")).toBe("gzip");
    expect(first.headers.get("Vary")).toBe("Accept-Encoding");
    const etag = first.headers.get("ETag");
    expect(etag).toMatch(/^W\/"sha256-/);
    expect(Number(first.headers.get("Content-Length"))).toBeLessThan(4 * 1024 * 1024);
    expect(((await first.json()) as LiveView).id).toBe("view");

    for (let poll = 0; poll < 25; poll++) {
      const unchanged = await fetch(url, { headers: { "If-None-Match": etag! } });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe("");
    }
    expect(serializations).toBe(1);

    view = counted({ ...view, phase: "live" });
    const changed = await fetch(url, { headers: { "If-None-Match": etag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
    expect(((await changed.json()) as LiveView).phase).toBe("live");

    // A surviving page can present its validator to a new serve process. Same
    // byte length must not collide with a different first snapshot.
    view = counted({ ...view, phase: "detached", id: "next" });
    handler = liveApi({ read: async () => view }, process.env);
    const restarted = await fetch(url, { headers: { "If-None-Match": etag! } });
    expect(restarted.status).toBe(200);
    expect(restarted.headers.get("ETag")).not.toBe(etag);
    expect(((await restarted.json()) as LiveView).id).toBe("next");
  } finally {
    server.close();
    await new Promise<void>((resolve) => server.once("close", resolve));
  }
});
