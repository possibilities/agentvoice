import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { type Orientation, type Phone, stateLayouts, visualSettingsOf } from "./protocol.ts";

const execute = promisify(execFile);
const captureOrder = ["portrait", "landscape", "portrait-reverse", "landscape-reverse"] as const;
export type RotationState = { mode: "free" | "lock"; rotation?: number };
export interface CaptureDevice {
  rotation(): Promise<RotationState>;
  rotate(rotation: number): Promise<void>;
  restore(state: RotationState, originalRotation: number): Promise<void>;
  foreground(): Promise<void>;
  screenshot(): Promise<Uint8Array>;
}
export type LayoutFrame = {
  orientation: Orientation;
  width: number;
  height: number;
  png: Uint8Array;
};
export type LayoutCapture = {
  id: string;
  createdAt: string;
  frames: LayoutFrame[];
  restored: true;
};

export function parseRotation(value: string): RotationState {
  const match = /^(free|lock)(?:\s+([0-3]))?$/.exec(value.trim());
  if (!match || (match[1] === "lock" && match[2] === undefined))
    throw Error("The selected device does not expose a supported rotation control.");
  return {
    mode: match[1] as "free" | "lock",
    ...(match[2] === undefined ? {} : { rotation: Number(match[2]) }),
  };
}

export function pngSize(png: Uint8Array): { width: number; height: number } {
  const bytes = Buffer.from(png);
  if (
    bytes.length < 33 ||
    bytes.length > 16 * 1024 * 1024 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw Error("The device did not return a valid bounded PNG screenshot.");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 32_000_000)
    throw Error("The device screenshot dimensions are unsupported.");
  return { width, height };
}

export function adbCaptureDevice(serial: string): CaptureDevice {
  async function adb(args: string[], binary = false): Promise<Buffer> {
    try {
      const result = await execute("adb", ["-s", serial, ...args], {
        timeout: 12000,
        maxBuffer: binary ? 16 * 1024 * 1024 : 2 * 1024 * 1024,
        encoding: "buffer",
      });
      return result.stdout;
    } catch {
      throw Error("Capture could not reach the selected ADB device.");
    }
  }
  async function rotate(rotation: number) {
    await adb(["shell", "wm", "user-rotation", "lock", String(rotation)]);
  }
  return {
    rotation: async () => parseRotation((await adb(["shell", "wm", "user-rotation"])).toString()),
    rotate,
    restore: async (state, originalRotation) => {
      await rotate(state.rotation ?? originalRotation);
      if (state.mode === "free") await adb(["shell", "wm", "user-rotation", "free"]);
      const restored = parseRotation((await adb(["shell", "wm", "user-rotation"])).toString());
      if (
        restored.mode !== state.mode ||
        (state.mode === "lock" && restored.rotation !== state.rotation)
      )
        throw Error("The device did not restore its original rotation mode.");
    },
    foreground: async () => {
      const windows = (await adb(["shell", "dumpsys", "window"])).toString();
      if (
        !/mCurrentFocus=Window\{[^\n]* com\.arthack\.agentvoice\.studio\/com\.arthack\.agentvoice\.PersonaPreviewActivity\}/.test(
          windows,
        )
      )
        throw Error(
          "Keep AgentVoice Studio in the foreground and the device unlocked during capture.",
        );
    },
    screenshot: () => adb(["exec-out", "screencap", "-p"], true),
  };
}

function designKey(phone: Phone) {
  const layouts = stateLayouts(phone.state);
  return JSON.stringify({
    layouts: captureOrder.map((orientation) => layouts[orientation]),
    appearance: visualSettingsOf(phone.state),
    sounds: phone.state.sounds,
    shared: phone.state.sharedAppearance,
    mode: phone.state.mode,
    connection: phone.state.connection,
    activity: phone.state.activity,
    micMuted: phone.state.micMuted,
    speakerMuted: phone.state.speakerMuted,
  });
}

/** Captures are read-only design operations; only temporary device rotation changes. */
export async function captureLayouts(
  phone: Phone,
  device: CaptureDevice,
  signal?: AbortSignal,
  timing = { timeout: 7000, settle: 700, poll: 100 },
): Promise<LayoutCapture> {
  if (!phone.connected || phone.state.holding || phone.state.connectionPreview !== "off")
    throw Error("Open the Studio design and release any held button before capturing layouts.");
  const generation = phone.generation ?? 1;
  const original = phone.state.orientation;
  const originalRotation = captureOrder.indexOf(original);
  if (originalRotation < 0) throw Error("Unsupported Studio orientation.");
  const design = designKey(phone);
  const rotation = await device.rotation();
  await device.foreground();
  const frames: LayoutFrame[] = [];
  const assertCurrent = (checkSignal = true) => {
    if (checkSignal) signal?.throwIfAborted();
    if (!phone.connected || (phone.generation ?? 1) !== generation)
      throw Error("The device reconnected during capture. No comparison was published.");
    if (
      phone.state.holding ||
      phone.state.connectionPreview !== "off" ||
      designKey(phone) !== design
    )
      throw Error("The Studio changed during capture. Release the controls and try again.");
  };
  const waitFor = async (orientation: Orientation, checkSignal = true) => {
    const deadline = Date.now() + timing.timeout;
    let stableSince = 0;
    while (Date.now() < deadline) {
      assertCurrent(checkSignal);
      await phone.request({ method: "get" });
      assertCurrent(checkSignal);
      if (phone.state.orientation === orientation) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= timing.settle) return;
      } else stableSince = 0;
      await Bun.sleep(timing.poll);
    }
    throw Error("The device did not settle in the requested orientation. Check rotation support.");
  };
  let changedRotation = false;
  let captureError: Error | undefined;
  try {
    for (let rotationIndex = 0; rotationIndex < captureOrder.length; rotationIndex++) {
      assertCurrent();
      changedRotation = true;
      await device.rotate(rotationIndex);
      const orientation = captureOrder[rotationIndex]!;
      await waitFor(orientation);
      await device.foreground();
      const before = phone.state.orientationEpoch;
      const png = await device.screenshot();
      await device.foreground();
      await phone.request({ method: "get" });
      assertCurrent();
      if (phone.state.orientation !== orientation || phone.state.orientationEpoch !== before)
        throw Error("The device rotated during a screenshot. Try capturing again.");
      const size = pngSize(png);
      if (size.width > size.height !== orientation.startsWith("landscape"))
        throw Error("The screenshot does not match the Studio orientation.");
      frames.push({ orientation, ...size, png });
    }
  } catch (error) {
    captureError = error instanceof Error ? error : Error("Layout capture failed.");
  }
  if (changedRotation) {
    try {
      await device.restore(rotation, originalRotation);
    } catch {
      throw Error(
        "Capture ended, but rotation could not be restored. Check the selected device's rotation setting.",
      );
    }
    if (phone.connected && (phone.generation ?? 1) === generation && designKey(phone) === design) {
      // Free rotation follows the sensor again; it need not return to the original slot.
      if (rotation.mode === "lock") await waitFor(captureOrder[rotation.rotation!]!, false);
      else await phone.request({ method: "get" });
    }
  }
  if (captureError) throw captureError;
  return {
    id: randomBytes(12).toString("hex"),
    createdAt: new Date().toISOString(),
    frames,
    restored: true,
  };
}
