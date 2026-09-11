import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:net";
import { connectPhone } from "../src/device.ts";
import {
  type Adb,
  discoverStudioDevices,
  parseAdbDevices,
  parseStudioBinding,
  studioIsForeground,
} from "../src/discovery.ts";
import {
  defaultLandscapeLayout,
  defaultPortraitLayout,
  defaultSharedAppearance,
  defaultVisualSettings,
  type PhoneState,
  parseState,
} from "../src/protocol.ts";
import { serveConfigurator } from "../src/server.ts";
import { defaultSounds } from "../src/sounds.ts";
import { StudioTargets } from "../src/targets.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const foreground =
  "mCurrentFocus=Window{abc u0 com.arthack.agentvoice.studio/com.arthack.agentvoice.PersonaPreviewActivity}";
const socketName = `agentvoice-halo-${"a".repeat(32)}`;
const binding = JSON.stringify({ socket: socketName, token: "b".repeat(64) });
function state(): PhoneState {
  const p = defaultPortraitLayout(),
    l = defaultLandscapeLayout(),
    visual = defaultVisualSettings();
  return parseState({
    ...p,
    ...visual,
    protocol: 29,
    revision: 0,
    orientation: "portrait",
    orientationEpoch: 0,
    connectionPreview: "off",
    connection: "connected",
    mode: "idle",
    activity: "steady",
    holding: false,
    micMuted: true,
    speakerMuted: true,
    savedScales: p.scales,
    defaults: p.scales,
    savedVerticalOffsetDp: p.verticalOffsetDp,
    defaultVerticalOffsetDp: p.verticalOffsetDp,
    savedDesign: p.design,
    defaultDesign: p.design,
    savedHalo: p.halo,
    defaultHalo: p.halo,
    savedSpirit: p.spirit,
    defaultSpirit: p.spirit,
    savedPersonaSide: p.personaSide,
    defaultPersonaSide: p.personaSide,
    savedHorizontalOffsetDp: p.horizontalOffsetDp,
    defaultHorizontalOffsetDp: p.horizontalOffsetDp,
    savedAppearanceOverrides: p.appearanceOverrides,
    otherLayout: l,
    savedOtherLayout: l,
    remainingLayouts: { portraitReverse: p, landscapeReverse: l },
    savedRemainingLayouts: { portraitReverse: p, landscapeReverse: l },
    sounds: defaultSounds(),
    savedSounds: defaultSounds(),
    defaultSounds: defaultSounds(),
    sharedAppearance: defaultSharedAppearance(),
    savedSharedAppearance: defaultSharedAppearance(),
    defaultSharedAppearance: defaultSharedAppearance(),
    savedAppearance: visual,
    defaultAppearance: visual,
  });
}

test("discovery lists only authorized foreground Studio targets without launching", async () => {
  const commands: string[][] = [];
  const adb: Adb = async (args) => {
    commands.push(args);
    if (args[0] === "devices")
      return "List of devices attached\none device model:Pixel_9\ntwo device model:Other\nlocked unauthorized\nlost offline\n";
    return args[1] === "one" ? foreground : "mCurrentFocus=Window{abc u0 other/.Main}";
  };
  expect(await discoverStudioDevices(adb)).toEqual([{ serial: "one", label: "Pixel 9" }]);
  expect(commands).toEqual([
    ["devices", "-l"],
    ["-s", "one", "shell", "dumpsys", "window"],
    ["-s", "two", "shell", "dumpsys", "window"],
  ]);
  expect(parseAdbDevices("../../bad device\nabc unauthorized")).toEqual([]);
  expect(studioIsForeground(foreground.replace("mCurrentFocus", "mLastFocus"))).toBe(false);
  expect(() => parseStudioBinding(binding)).not.toThrow();
  for (const input of [
    "bad",
    binding.replace('"token"', '"secret"'),
    `${binding.slice(0, -1)},"extra":true}`,
    "x".repeat(1025),
  ])
    expect(() => parseStudioBinding(input)).toThrow("private browser binding");
});

function fakeAdb(options: { busy?: boolean; port?: number; race?: boolean } = {}) {
  const commands: string[][] = [];
  let own = false;
  const runner: Adb = async (args) => {
    commands.push(args);
    if (args[0] === "devices") return "one device model:Phone";
    const cmd = args.slice(2).join(" ");
    if (cmd === "shell dumpsys window") return foreground;
    if (cmd.startsWith("shell run-as")) return binding;
    if (cmd === "shell getprop ro.product.model") return "Phone";
    if (cmd === "get-state") return "device";
    if (cmd === "forward --list")
      return [
        ...(own ? [`one tcp:${options.port ?? 1} localabstract:${socketName}`] : []),
        ...(options.busy || (options.race && own)
          ? [`one tcp:49999 localabstract:${socketName}`]
          : []),
        "other tcp:49998 localabstract:other-socket",
      ].join("\n");
    if (cmd.startsWith("forward --no-rebind tcp:0")) {
      own = true;
      return String(options.port ?? 1);
    }
    if (cmd.startsWith("forward --remove")) {
      own = false;
      return "";
    }
    throw Error(`Unexpected fake command ${cmd}`);
  };
  return { runner, commands };
}

test("busy binding and simultaneous forward never evict or remove another host", async () => {
  for (const options of [{ busy: true }, { race: true }]) {
    const f = fakeAdb(options);
    await expect(connectPhone("one", f.runner)).rejects.toThrow(/another browser|linked elsewhere/);
    const removes = f.commands.filter((args) => args.includes("--remove"));
    expect(removes).toEqual(options.race ? [["-s", "one", "forward", "--remove", "tcp:1"]] : []);
    expect(f.commands.some((args) => args.includes("am"))).toBe(false);
  }
});

test("selection authenticates existing binding, reads only, and removes only its own forward", async () => {
  const requests: string[] = [];
  const server = createServer((socket) => {
    let buffer = "",
      authenticated = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (!authenticated) {
          expect(message).toEqual({ token: "b".repeat(64) });
          authenticated = true;
        } else {
          requests.push(message.method);
          socket.write(`${JSON.stringify({ id: message.id, state: state() })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const f = fakeAdb({ port });
  const connection = await connectPhone("one", f.runner);
  cleanup.push(connection.close);
  expect(connection.phone.connected).toBe(true);
  await connection.close();
  expect(requests).toEqual(["get"]);
  expect(f.commands.filter((args) => args.includes("--remove"))).toEqual([
    ["-s", "one", "forward", "--remove", `tcp:${port}`],
  ]);
  expect(f.commands.some((args) => args.includes("am"))).toBe(false);
});

function targetFixture() {
  const closed: string[] = [],
    edits: string[] = [];
  const manager = new StudioTargets(
    {},
    {
      discover: async () => [
        { serial: "one", label: "One" },
        { serial: "two", label: "Two" },
      ],
      connect: async (serial: string) => ({
        label: serial,
        close: async () => {
          closed.push(serial);
        },
        phone: {
          state: state(),
          connected: true,
          generation: 1,
          request: async (command: Record<string, unknown>) => {
            edits.push(`${serial}:${command["method"]}`);
            return { state: state() };
          },
        },
      }),
    },
  );
  cleanup.push(() => manager.close());
  return { manager, closed, edits };
}

test("target lifecycle fences list revisions and isolates export paths", async () => {
  const { manager, closed } = targetFixture();
  expect(manager.phone).toBeUndefined();
  await manager.refresh();
  await expect(manager.select("one", 0)).rejects.toThrow("list changed");
  await manager.select("one", manager.snapshot().revision);
  expect(manager.saveTo.endsWith("/one.json")).toBe(true);
  await expect(manager.select("two", manager.snapshot().revision)).rejects.toThrow("Release");
  await manager.select(null, manager.snapshot().revision);
  await manager.select("two", manager.snapshot().revision);
  expect(manager.saveTo.endsWith("/two.json")).toBe(true);
  expect(closed).toEqual(["one"]);
});

test("picker HTTP stays idle and fences old device commands after switching", async () => {
  const { manager, edits } = targetFixture();
  await manager.refresh();
  const web = await serveConfigurator(undefined, {
    port: 0,
    device: "",
    saveTo: "",
    targets: manager,
  });
  cleanup.push(() => web.close());
  const post = (path: string, body: unknown, origin = new URL(web.url).origin) =>
    fetch(`${web.url}${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const idle = await (await fetch(`${web.url}state`)).json();
  expect(idle.state).toBeNull();
  expect(idle.connected).toBe(false);
  expect(
    (
      await post(
        "targets/select",
        { selectionEpoch: idle.selectionEpoch, revision: idle.targets.revision, serial: "one" },
        "http://evil.invalid",
      )
    ).status,
  ).toBe(403);
  const selected = await (
    await post("targets/select", {
      selectionEpoch: idle.selectionEpoch,
      revision: idle.targets.revision,
      serial: "one",
    })
  ).json();
  expect(selected.connected).toBe(true);
  const old = {
    selectionEpoch: selected.selectionEpoch,
    generation: 1,
    orientation: "portrait",
    orientationEpoch: 0,
  };
  expect((await post("icon-credits", old)).status).toBe(200);
  const released = await (
    await post("targets/select", {
      selectionEpoch: selected.selectionEpoch,
      revision: selected.targets.revision,
      serial: null,
    })
  ).json();
  const next = await (
    await post("targets/select", {
      selectionEpoch: released.selectionEpoch,
      revision: released.targets.revision,
      serial: "two",
    })
  ).json();
  expect(next.selectionEpoch).toBeGreaterThan(selected.selectionEpoch);
  expect(next.hostSaved).toBeNull();
  expect((await post("icon-credits", old)).status).toBe(409);
  expect(edits).toEqual(["one:iconCredits"]);
});
