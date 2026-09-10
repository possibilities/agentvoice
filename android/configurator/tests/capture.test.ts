import { expect, test } from "bun:test";
import { type CaptureDevice, captureLayouts, parseRotation, pngSize } from "../src/capture.ts";
import {
  defaultLandscapeLayout,
  defaultPortraitLayout,
  defaultVisualSettings,
  type Orientation,
  type Phone,
  type PhoneState,
} from "../src/protocol.ts";
import { serveConfigurator } from "../src/server.ts";

const order: Orientation[] = ["portrait", "landscape", "portrait-reverse", "landscape-reverse"];
function png(width: number, height: number) {
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
function fixture() {
  const layouts = {
    portrait: defaultPortraitLayout(),
    landscape: defaultLandscapeLayout(),
    "portrait-reverse": { ...defaultPortraitLayout(), verticalOffsetDp: 22 },
    "landscape-reverse": { ...defaultLandscapeLayout(), horizontalOffsetDp: -17 },
  };
  let state = {
    ...layouts.portrait,
    ...defaultVisualSettings(),
    orientation: "portrait",
    orientationEpoch: 0,
    revision: 0,
    holding: false,
    connectionPreview: "off",
    mode: "idle",
    connection: "connected",
    activity: "steady",
    micMuted: true,
    speakerMuted: true,
    otherLayout: layouts.landscape,
    remainingLayouts: {
      portraitReverse: layouts["portrait-reverse"],
      landscapeReverse: layouts["landscape-reverse"],
    },
  } as unknown as PhoneState;
  const commands: string[] = [];
  const phone: Phone = {
    connected: true,
    generation: 1,
    get state() {
      return state;
    },
    set state(next) {
      state = next;
    },
    request: async (request) => {
      commands.push(String(request["method"]));
      return { state };
    },
  };
  const rotations: number[] = [];
  const restored: unknown[] = [];
  function setOrientation(index: number) {
    const orientation = order[index]!;
    const reverse = orientation.endsWith("reverse");
    const other = order[index ^ 1]!;
    state = {
      ...state,
      ...layouts[orientation],
      orientation,
      orientationEpoch: state.orientationEpoch + 1,
      otherLayout: layouts[other],
      remainingLayouts: reverse
        ? { portrait: layouts.portrait, landscape: layouts.landscape }
        : {
            portraitReverse: layouts["portrait-reverse"],
            landscapeReverse: layouts["landscape-reverse"],
          },
    };
  }
  const device: CaptureDevice = {
    rotation: async () => ({ mode: "free" }),
    rotate: async (rotation) => {
      rotations.push(rotation);
      setOrientation(rotation);
    },
    restore: async (rotation, original) => {
      restored.push(rotation);
      setOrientation(original);
    },
    foreground: async () => {},
    screenshot: async () =>
      state.orientation.startsWith("landscape") ? png(780, 360) : png(360, 780),
  };
  return { phone, device, rotations, restored, commands, setOrientation };
}
const fast = { timeout: 80, settle: 0, poll: 1 };

test("capture collects four actual slots and restores rotation without saving or editing", async () => {
  const f = fixture();
  f.setOrientation(3);
  const result = await captureLayouts(f.phone, f.device, undefined, fast);
  expect(result.frames.map((frame) => frame.orientation)).toEqual(order);
  expect(f.rotations).toEqual([0, 1, 2, 3]);
  expect(f.restored).toEqual([{ mode: "free" }]);
  expect(f.phone.state.orientation).toBe("landscape-reverse");
  expect(new Set(f.commands)).toEqual(new Set(["get"]));
  expect(result.restored).toBe(true);
});

test("capture failure restores original mode and publishes no partial comparison", async () => {
  const f = fixture();
  f.device.rotation = async () => ({ mode: "lock", rotation: 0 });
  f.device.screenshot = async () => {
    throw Error("screen failure");
  };
  await expect(captureLayouts(f.phone, f.device, undefined, fast)).rejects.toThrow(
    "screen failure",
  );
  expect(f.restored).toEqual([{ mode: "lock", rotation: 0 }]);
});

test("changed design and lost target fail closed, with rotation restored", async () => {
  const f = fixture();
  f.device.screenshot = async () => {
    f.phone.state = { ...f.phone.state, verticalOffsetDp: 99 };
    return png(360, 780);
  };
  await expect(captureLayouts(f.phone, f.device, undefined, fast)).rejects.toThrow(
    "Studio changed",
  );
  expect(f.restored).toHaveLength(1);
  const lost = fixture();
  lost.device.screenshot = async () => {
    lost.phone.generation = 2;
    return png(360, 780);
  };
  await expect(captureLayouts(lost.phone, lost.device, undefined, fast)).rejects.toThrow(
    "reconnected",
  );
  expect(lost.restored).toHaveLength(1);
});

test("capture refuses holds and setup scenes before touching rotation", async () => {
  for (const change of [{ holding: true }, { connectionPreview: "camera" as const }]) {
    const f = fixture();
    f.phone.state = { ...f.phone.state, ...change };
    await expect(captureLayouts(f.phone, f.device, undefined, fast)).rejects.toThrow(
      "release any held",
    );
    expect(f.rotations).toHaveLength(0);
  }
});

test("cancellation and restoration failure are visible", async () => {
  const f = fixture();
  const abort = new AbortController();
  f.device.screenshot = async () => {
    abort.abort();
    return png(360, 780);
  };
  await expect(captureLayouts(f.phone, f.device, abort.signal, fast)).rejects.toThrow();
  expect(f.restored).toHaveLength(1);
  const broken = fixture();
  broken.device.restore = async () => {
    throw Error("unplugged");
  };
  await expect(captureLayouts(broken.phone, broken.device, undefined, fast)).rejects.toThrow(
    "rotation could not be restored",
  );
});

test("rotation and screenshot metadata reject unsafe or unsupported output", () => {
  expect(parseRotation("lock 3\n")).toEqual({ mode: "lock", rotation: 3 });
  expect(parseRotation("free")).toEqual({ mode: "free" });
  for (const value of ["lock 4", "lock", "free; reboot", ""])
    expect(() => parseRotation(value)).toThrow();
  expect(pngSize(png(720, 1560))).toEqual({ width: 720, height: 1560 });
  expect(() => pngSize(png(9000, 2))).toThrow();
  expect(() => pngSize(Buffer.from("not png"))).toThrow();
});

test("capture endpoint fences requests and serves only its completed comparison", async () => {
  const f = fixture();
  let calls = 0;
  const host = await serveConfigurator(f.phone, {
    port: 0,
    device: "test emulator",
    saveTo: "/unused/capture-test.json",
    capture: async () => {
      calls++;
      return {
        id: "a".repeat(24),
        createdAt: "2026-09-10T00:00:00Z",
        restored: true,
        frames: [{ orientation: "portrait", width: 360, height: 780, png: png(360, 780) }],
      };
    },
  });
  try {
    const origin = new URL(host.url).origin;
    const request = (generation: number, requestOrigin = origin) =>
      fetch(`${host.url}capture-layouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: requestOrigin },
        body: JSON.stringify({
          generation,
          revision: 0,
          orientation: "portrait",
          orientationEpoch: 0,
        }),
      });
    expect((await request(2)).status).toBe(409);
    expect((await request(1, "https://unrelated.invalid")).status).toBe(403);
    expect(calls).toBe(0);
    const response = await request(1);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { capture: { frames: { url: string }[] } };
    const image = await fetch(new URL(body.capture.frames[0]!.url, origin));
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png(360, 780));
    expect((await fetch(`${host.url}capture/${"b".repeat(24)}/portrait.png`)).status).toBe(404);
    expect(calls).toBe(1);
  } finally {
    await host.close();
  }
});

test("restoring free rotation accepts the sensor-selected slot", async () => {
  const f = fixture();
  f.device.restore = async () => {
    f.setOrientation(1);
  };
  const result = await captureLayouts(f.phone, f.device, undefined, fast);
  expect(result.restored).toBe(true);
  expect(f.phone.state.orientation).toBe("landscape");
});
