import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { liveApi } from "../server/api.ts";
import {
  DocumentAccessError,
  DocumentReader,
  type DocumentViewContext,
  markdownLinks,
} from "../server/document-reader.ts";
import { LiveReader } from "../server/live-reader.ts";
import type { LiveView } from "../src/types.ts";
import { fixture } from "./fixture.ts";

function documentFixture(maxBytes = 2 * 1024 * 1024) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-documents-")));
  const home = join(root, "home");
  const workspace = join(home, "workspace");
  for (const directory of [
    workspace,
    join(workspace, "nested"),
    join(home, "wiki"),
    join(home, "obsidian", "work"),
    join(home, "code", "project"),
  ])
    mkdirSync(directory, { recursive: true });
  let viewId = "view-one";
  let current = true;
  let assistantMarkdown: string[] = [];
  const context = (): DocumentViewContext => ({
    viewId,
    workspace,
    assistantMarkdown,
    current: () => current,
  });
  const reader = new DocumentReader({ documentContext: async () => context() }, { home, maxBytes });
  return {
    root,
    home,
    workspace,
    reader,
    markdown: (...value: string[]) => {
      assistantMarkdown = value;
    },
    replace: () => {
      viewId = randomUUID();
    },
    available: (value: boolean) => {
      current = value;
    },
    write: (path: string, content: string | Uint8Array) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return path;
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("Markdown authority follows rendered links, including references and decoded destinations", () => {
  const links = markdownLinks(`
[Nested](guide_(one).md)
[Angle](<My Guide.md>)
[Entity](Rock&amp;Roll.md)
[Reference][manual]
![Image](private.md)
\`[Inline code](private.md)\`

\`\`\`
[Fenced code](private.md)
\`\`\`

[manual]: nested/reference.markdown
[manual]: ignored/private.md
`);
  expect([...links]).toEqual([
    "guide_(one).md",
    "My%20Guide.md",
    "Rock&Roll.md",
    "nested/reference.markdown",
  ]);
});

test("linked local forms open and only linked relatives inherit a bounded document grant", async () => {
  const h = documentFixture();
  try {
    const guide = h.write(
      join(h.workspace, "Guide With Space.md"),
      "# Guide\n\n[Child](<nested/Child Café.md>)\n[Remote](https://example.test/private.md)",
    );
    const child = h.write(join(h.workspace, "nested", "Child Café.md"), "# Child");
    h.write(join(h.workspace, "Cited.md"), "# Cited");
    const wiki = h.write(join(h.home, "wiki", "Note.md"), "# Wiki");
    const note = h.write(join(h.home, "obsidian", "work", "Scratch.md"), "# Scratch");
    const code = h.write(join(h.home, "code", "project", "README.md"), "# Project");
    const noteHref = pathToFileURL(note).href;
    h.markdown(
      `[Guide](<Guide With Space.md>) [Cited](Cited.md:12:3) [Wiki](~/wiki/Note.md) [Note](${noteHref}) [Code](~/code/project/README.md)`,
    );

    const opened = await h.reader.load({ href: "Guide%20With%20Space.md" });
    expect(opened.title).toBe("Guide With Space");
    expect(opened.path).toBe(guide);
    expect(opened.content).toContain("[Child]");
    expect(await h.reader.load({ href: "nested/Child%20Caf%C3%A9.md", base: opened.path })).toEqual(
      {
        title: "Child Café",
        path: child,
        content: "# Child",
      },
    );
    await expect(h.reader.load({ href: "nested/guessed.md", base: opened.path })).rejects.toEqual(
      expect.objectContaining({ status: 403 }),
    );
    await expect(
      h.reader.load({ href: "https://example.test/private.md", base: opened.path }),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
    expect((await h.reader.load({ href: "~/wiki/Note.md" })).path).toBe(wiki);
    expect((await h.reader.load({ href: "Cited.md:12:3" })).title).toBe("Cited");
    expect((await h.reader.load({ href: noteHref })).path).toBe(note);
    expect((await h.reader.load({ href: "~/code/project/README.md" })).path).toBe(code);
  } finally {
    h.close();
  }
});

test("replacement and unavailable context revoke prior document navigation grants", async () => {
  const h = documentFixture();
  try {
    const guide = h.write(join(h.workspace, "guide.md"), "[Child](nested/child.md)");
    h.write(join(h.workspace, "nested", "child.md"), "Child");
    h.markdown("[Guide](guide.md)");
    expect((await h.reader.load({ href: "guide.md" })).path).toBe(guide);

    h.replace();
    await expect(h.reader.load({ href: "nested/child.md", base: guide })).rejects.toEqual(
      expect.objectContaining({ status: 403 }),
    );
    expect((await h.reader.load({ href: "guide.md" })).path).toBe(guide);

    h.available(false);
    await expect(h.reader.load({ href: "guide.md" })).rejects.toEqual(
      expect.objectContaining({ status: 403 }),
    );
    h.available(true);
    await expect(h.reader.load({ href: "nested/child.md", base: guide })).rejects.toEqual(
      expect.objectContaining({ status: 403 }),
    );
  } finally {
    h.close();
  }
});

test("served-document grants are bounded and keep only recent linked navigation", async () => {
  const h = documentFixture();
  try {
    const hrefs = Array.from({ length: 129 }, (_, index) => `document-${index}.md`);
    for (const href of hrefs) h.write(join(h.workspace, href), "[Child](nested/child.md)");
    const child = h.write(join(h.workspace, "nested", "child.md"), "Child");
    h.markdown(hrefs.map((href) => `[Document](${href})`).join("\n"));
    const paths: string[] = [];
    for (const href of hrefs) paths.push((await h.reader.load({ href })).path);

    await expect(h.reader.load({ href: "nested/child.md", base: paths[0]! })).rejects.toEqual(
      expect.objectContaining({ status: 403 }),
    );
    expect((await h.reader.load({ href: "nested/child.md", base: paths.at(-1)! })).path).toBe(
      child,
    );
  } finally {
    h.close();
  }
});

test("filesystem boundary rejects traversal, hidden files, links, non-Markdown and unsafe bytes", async () => {
  const h = documentFixture(8);
  try {
    const outside = h.write(join(h.home, "outside.md"), "outside");
    const hidden = h.write(join(h.workspace, ".hidden.md"), "hidden");
    const missing = join(h.workspace, "missing.md");
    const text = h.write(join(h.workspace, "note.txt"), "text");
    h.write(join(h.workspace, "invalid.md"), Uint8Array.of(0xc3, 0x28));
    const exact = h.write(join(h.workspace, "exact.md"), "12345678");
    h.write(join(h.workspace, "large.md"), "123456789");
    const linkedFile = join(h.workspace, "linked.md");
    symlinkSync(exact, linkedFile);
    const linkedDirectory = join(h.workspace, "linked-directory");
    symlinkSync(join(h.workspace, "nested"), linkedDirectory);
    const hardSource = h.write(join(h.workspace, "hard-source.md"), "source");
    const hard = join(h.workspace, "hard.md");
    linkSync(hardSource, hard);
    h.markdown(
      [
        "[Traversal](../outside.md)",
        "[Hidden](.hidden.md)",
        "[Missing](missing.md)",
        "[Text](note.txt)",
        "[Invalid](invalid.md)",
        "[Exact](exact.md)",
        "[Large](large.md)",
        "[File link](linked.md)",
        "[Directory link](linked-directory/child.md)",
        "[Hard link](hard.md)",
      ].join(" "),
    );
    const cases = [
      ["../outside.md", 403],
      [".hidden.md", 403],
      ["missing.md", 404],
      ["note.txt", 415],
      ["invalid.md", 415],
      ["large.md", 413],
      ["linked.md", 403],
      ["linked-directory/child.md", 403],
      ["hard.md", 403],
    ] as const;
    for (const [href, status] of cases)
      await expect(h.reader.load({ href })).rejects.toEqual(expect.objectContaining({ status }));
    expect((await h.reader.load({ href: "exact.md" })).content).toBe("12345678");
    expect(outside).not.toBe(hidden);
    expect(missing).not.toBe(text);
  } finally {
    h.close();
  }
});

test("LiveReader document context contains assistant links and fences a replacement", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  try {
    h.history([
      {
        turnId: "turn",
        item: {
          type: "userMessage",
          id: "user",
          content: [{ type: "text", text: "[Untrusted](private.md)" }],
        },
      },
      {
        turnId: "turn",
        item: { type: "agentMessage", id: "assistant", text: "[Guide](guide.md)" },
      },
    ]);
    await h.start();
    let view: LiveView = await reader.read();
    for (let count = 0; view.agent.length < 2 && count < 30; count++) {
      await Bun.sleep(20);
      view = await reader.read();
    }
    const context = await reader.documentContext();
    expect(context?.workspace).toBe(h.root);
    expect(context?.assistantMarkdown).toEqual(["[Guide](guide.md)"]);
    expect(context?.current()).toBe(true);
    h.replace("successor");
    for (let count = 0; context?.current() && count < 30; count++) await Bun.sleep(10);
    expect(context?.current()).toBe(false);
  } finally {
    reader.close();
    await h.close();
  }
});

test("document HTTP boundary requires exact-origin JSON and returns only stable errors", async () => {
  const calls: unknown[] = [];
  const documents = {
    load: async (request: { href: string; base?: string }) => {
      calls.push(request);
      if (request.href === "missing.md")
        throw new DocumentAccessError(404, "Document was not found.");
      if (request.href === "explode.md") throw new Error("ENOENT /private/server/secret.md");
      return { title: "Guide", path: "/visible/Guide.md", content: "# Guide" };
    },
  };
  const reader = {
    read: async (): Promise<LiveView> => ({ phase: "empty", id: "empty", voice: [], agent: [] }),
  };
  const server = createServer((request, response) =>
    liveApi(
      reader,
      process.env,
      undefined,
      documents,
    )(request, response, () => response.writeHead(404).end()),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const send = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${origin}/api/document`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...headers },
      body,
    });
  try {
    expect((await fetch(`${origin}/api/document`)).status).toBe(405);
    expect(
      (
        await fetch(`${origin}/api/document`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ href: "Guide.md" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await send(JSON.stringify({ href: "Guide.md" }), { Origin: "https://foreign.test" })).status,
    ).toBe(403);
    expect(
      (await send(JSON.stringify({ href: "Guide.md" }), { "Content-Type": "text/plain" })).status,
    ).toBe(403);
    expect((await send(JSON.stringify({ href: "Guide.md", extra: true }))).status).toBe(400);
    expect((await send(JSON.stringify({ href: "x".repeat(17 * 1024) }))).status).toBe(413);

    const opened = await send(JSON.stringify({ href: "Guide.md" }));
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({
      title: "Guide",
      path: "/visible/Guide.md",
      content: "# Guide",
    });
    expect(calls).toEqual([{ href: "Guide.md" }]);

    const missing = await send(JSON.stringify({ href: "missing.md" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Document was not found." });
    const exploded = await send(JSON.stringify({ href: "explode.md" }));
    expect(exploded.status).toBe(500);
    const failure = await exploded.text();
    expect(failure).toBe('{"error":"Document could not be opened."}');
    expect(failure).not.toContain("/private/server");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
