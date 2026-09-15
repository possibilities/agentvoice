import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webOrigin } from "../../src/web-target.ts";
import { LiveReader } from "../server/live-reader.ts";
import { isLocalRequest } from "../server/local-origin.ts";
import { fixture } from "./fixture.ts";

test("each configured origin rejects the other reader and malformed names", () => {
  for (const name of ["agentvoice", "agentvoice-test"]) {
    const env = { AGENTVOICE_WEB_NAME: name, PORTLESS_URL: webOrigin(name) };
    const request = (host: string, origin: string) =>
      ({
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host, origin, "x-forwarded-proto": "https" },
      }) as unknown as IncomingMessage;
    expect(isLocalRequest(request(`${name}.localhost`, webOrigin(name)), env)).toBe(true);
    const other = name === "agentvoice" ? "agentvoice-test" : "agentvoice";
    expect(isLocalRequest(request(`${other}.localhost`, webOrigin(other)), env)).toBe(false);
    expect(isLocalRequest(request(`${name}.localhost`, webOrigin(other)), env)).toBe(false);
  }
  for (const name of ["", "../test", "a.b", "test:443", "Test", "-test", "test-", "a".repeat(64)])
    expect(() => webOrigin(name)).toThrow();
});

test("parallel readers select independent workspace sessions and never fall back to default", async () => {
  const state = mkdtempSync(join(tmpdir(), "av-parallel-"));
  const production = await fixture(undefined, { stateDir: state });
  const testing = await fixture(undefined, { stateDir: state, named: true });
  const defaultReader = new LiveReader(state);
  const testReader = new LiveReader(state, undefined, undefined, testing.root);
  const missingReader = new LiveReader(state, undefined, undefined, join(state, "missing"));
  try {
    production.history([
      { turnId: "p", item: { type: "agentMessage", id: "p", text: "Production" } },
    ]);
    testing.history([{ turnId: "t", item: { type: "agentMessage", id: "t", text: "Testing" } }]);
    await production.start();
    await testing.start();
    const populated = async (reader: LiveReader) => {
      let view = await reader.read();
      const deadline = Date.now() + 4000;
      while (!view.agent.length && Date.now() < deadline) {
        await Bun.sleep(260);
        view = await reader.read();
      }
      return view;
    };
    const [p, t, missing] = await Promise.all([
      populated(defaultReader),
      populated(testReader),
      missingReader.read(),
    ]);
    expect(p.agent.map((m) => m.content)).toEqual(["Production"]);
    expect(t.agent.map((m) => m.content)).toEqual(["Testing"]);
    expect(p.persistenceScope).not.toBe(t.persistenceScope);
    expect(missing.phase).toBe("offline");
    expect(missing.agent).toEqual([]);
    await testing.stopFrontend();
    await Bun.sleep(300);
    expect((await defaultReader.read()).agent.map((m) => m.content)).toEqual(["Production"]);
    expect((await testReader.read()).phase).not.toBe("live");
  } finally {
    defaultReader.close();
    testReader.close();
    missingReader.close();
    await testing.close();
    await production.close();
    rmSync(state, { recursive: true, force: true });
  }
});
