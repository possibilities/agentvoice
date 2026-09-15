import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listening address");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

test.each([
  ["dev", "agentvoice"],
  ["preview", "agentvoice"],
  ["dev", "agentvoice-test"],
  ["preview", "agentvoice-test"],
] as const)(
  "%s %s serves the API through portless HTTPS, rejects duplicate binds, and closes on TERM",
  async (mode, name) => {
    const web = resolve(import.meta.dirname, "..");
    // The check workflow builds before testing. Exercise those actual assets.
    if (mode === "preview" && !existsSync(join(web, "dist/index.html")))
      throw new Error("Run bun run web:build before reader tests");
    const directory = mkdtempSync(join(tmpdir(), "agentvoice-preview-"));
    const port = await freePort();
    const env = {
      ...process.env,
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".localhost",
      PORT: String(port),
      PORTLESS_URL: `https://${name}.localhost`,
      AGENTVOICE_WEB_NAME: name,
      XDG_STATE_HOME: directory,
    };
    const backend = Bun.spawn([process.execPath, join(web, `server/${mode}.ts`)], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    let proxy: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const deadline = Date.now() + 10000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          ready = (await fetch(`http://127.0.0.1:${port}/`)).ok;
        } catch {
          /* starting */
        }
        if (ready) break;
        await Bun.sleep(25);
      }
      expect(ready).toBe(true);
      const certificate = join(directory, "cert.pem");
      const key = join(directory, "key.pem");
      const generated = Bun.spawnSync(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          `/CN=${name}.localhost`,
          "-keyout",
          key,
          "-out",
          certificate,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      expect(generated.exitCode).toBe(0);
      const proxyPortFile = join(directory, "proxy-port");
      const script = join(directory, "proxy.mjs");
      writeFileSync(
        script,
        `
      import { createProxyServer } from ${JSON.stringify(new URL("../node_modules/portless/dist/index.js", import.meta.url).href)};
      import { readFileSync, writeFileSync } from "node:fs";
      const server = createProxyServer({
        getRoutes: () => [{ hostname: "${name}.localhost", port: ${port} }], proxyPort: 443,
        tls: { cert: readFileSync(${JSON.stringify(certificate)}), key: readFileSync(${JSON.stringify(key)}) }
      });
      server.listen(0, "127.0.0.1", () => writeFileSync(${JSON.stringify(proxyPortFile)}, String(server.address().port)));
    `,
      );
      proxy = Bun.spawn(["node", script], { stdout: "ignore", stderr: "pipe" });
      const proxyDeadline = Date.now() + 3000;
      while (!existsSync(proxyPortFile) && Date.now() < proxyDeadline) await Bun.sleep(20);
      expect(existsSync(proxyPortFile)).toBe(true);
      const proxyPort = Number(readFileSync(proxyPortFile, "utf8"));
      const headers = {
        Host: `${name}.localhost`,
        Origin: `https://${name}.localhost`,
      };
      // The certificate is synthetic, generated only inside this test directory.
      const options = { headers, tls: { rejectUnauthorized: false } };
      const base = `https://127.0.0.1:${proxyPort}`;
      const html = await fetch(base, options);
      const assertCsp = (response: Response) => {
        const policy = response.headers.get("Content-Security-Policy");
        expect(policy).not.toBeNull();
        const connect = policy
          ?.split(";")
          .map((directive) => directive.trim())
          .find((directive) => directive.startsWith("connect-src "));
        expect(connect).toBeDefined();
        const sources = connect!.split(/\s+/).slice(1);
        expect(sources.filter((source) => source.startsWith("wss:"))).toEqual([
          `wss://${name}.localhost`,
        ]);
        expect(sources).not.toContain("*");
      };
      assertCsp(html);
      const document = await html.text();
      expect(document).toContain("<title>AgentVoice</title>");
      if (mode === "dev") {
        expect(document).toContain("/@vite/client");
        const client = await (await fetch(`${base}/@vite/client`, options)).text();
        expect(client.includes('const socketProtocol = "wss"')).toBe(true);
        expect(client.includes(JSON.stringify(`${name}.localhost`))).toBe(true);
        expect(client.includes("const hmrPort = 443")).toBe(true);
        const token = client.match(/const wsToken = "([^"\n]+)"/u)?.[1];
        expect(token).toBeDefined();
        // The web tsconfig also includes DOM's narrower WebSocket constructor.
        const HmrWebSocket = WebSocket as unknown as {
          new (url: string, options: Bun.WebSocketOptions): WebSocket;
        };
        const socket = new HmrWebSocket(`wss://127.0.0.1:${proxyPort}/?token=${token}`, {
          protocols: ["vite-hmr"],
          headers,
          tls: { rejectUnauthorized: false },
        });
        try {
          const connected = await new Promise<string>((done, reject) => {
            const timer = setTimeout(() => reject(new Error("HMR handshake timed out")), 3000);
            socket.onmessage = (event) => {
              clearTimeout(timer);
              done(String(event.data));
            };
            socket.onerror = () => {
              clearTimeout(timer);
              reject(new Error("HMR connection failed"));
            };
          });
          expect(JSON.parse(connected)).toEqual({ type: "connected" });
        } finally {
          socket.close();
        }
      }
      const foreignHost = await fetch(`http://127.0.0.1:${port}/api/live`, {
        headers: { Host: "another.localhost" },
      });
      expect(foreignHost.status).toBe(403);
      const result = await fetch(`${base}/api/live`, options);
      expect(result.status).toBe(200);
      assertCsp(result);
      expect(result.headers.get("x-portless")).toBe("1");
      expect(await result.json()).toEqual({
        phase: "offline",
        id: "offline",
        voice: [],
        agent: [],
      });
      const foreign = await fetch(`${base}/api/live`, {
        ...options,
        headers: { ...headers, Origin: "https://another.localhost" },
      });
      expect(foreign.status).toBe(403);
      const duplicate = Bun.spawn([process.execPath, join(web, `server/${mode}.ts`)], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await duplicate.exited).toBe(1);
      expect(await new Response(duplicate.stderr).text()).toContain("already in use");
      expect((await fetch(`${base}/api/live`, options)).status).toBe(200);
      backend.kill("SIGTERM");
      expect(await backend.exited).toBe(0);
      expect(
        await fetch(`http://127.0.0.1:${port}/`).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      backend.kill("SIGTERM");
      proxy?.kill("SIGTERM");
      await Promise.all([backend.exited, proxy?.exited]);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15000,
);
