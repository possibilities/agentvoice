import { fileURLToPath } from "node:url";
import { adbCaptureDevice, captureLayouts, type LayoutCapture } from "./capture.ts";
import { connectPhone } from "./device.ts";
import { discoverStudioDevices, type StudioDevice } from "./discovery.ts";
import type { Phone } from "./protocol.ts";

export type TargetSnapshot = {
  revision: number;
  selected: string | null;
  devices: StudioDevice[];
  scanning: boolean;
  error?: string;
};
export interface ConfiguratorTargets {
  readonly phone: Phone | undefined;
  readonly label: string;
  readonly saveTo: string;
  readonly epoch: number;
  snapshot(): TargetSnapshot;
  refresh(): Promise<void>;
  select(serial: string | null, revision: number): Promise<void>;
  capture(signal: AbortSignal): Promise<LayoutCapture>;
  close(): Promise<void>;
}
type Connection = { phone: Phone; label: string; close(): Promise<void> };

/** One explicit selection, one reconnect loop and one export destination per host. */
export class StudioTargets implements ConfiguratorTargets {
  epoch = 1;
  private revision = 0;
  private devices: StudioDevice[] = [];
  private scanning = false;
  private selecting = false;
  private error: string | undefined;
  private serial: string | null = null;
  private connection: Connection | undefined;
  private stopped = false;
  private selectionTask: Promise<void> | undefined;
  private cleanupFailed = false;

  constructor(
    private readonly options: { pinnedSerial?: string; saveTo?: string } = {},
    private readonly io: {
      discover(): Promise<StudioDevice[]>;
      connect(serial: string): Promise<Connection>;
    } = { discover: discoverStudioDevices, connect: connectPhone },
  ) {}
  get phone() {
    return this.connection?.phone;
  }
  get label() {
    return this.connection ? `${this.connection.label} · ${this.serial}` : "";
  }
  get saveTo() {
    return this.serial
      ? (this.options.saveTo ??
          fileURLToPath(
            new URL(`../profiles/${encodeURIComponent(this.serial)}.json`, import.meta.url),
          ))
      : "";
  }
  snapshot(): TargetSnapshot {
    return {
      revision: this.revision,
      selected: this.serial,
      devices: this.devices,
      scanning: this.scanning,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  async refresh() {
    if (this.stopped || this.scanning || this.selecting) return;
    this.scanning = true;
    try {
      const devices = await this.io.discover();
      if (!this.stopped) {
        this.devices = this.options.pinnedSerial
          ? devices.filter((item) => item.serial === this.options.pinnedSerial)
          : devices;
        this.error = undefined;
      }
    } catch {
      this.devices = [];
      this.error = "Could not discover devices. Check ADB and USB debugging, then refresh.";
    } finally {
      this.revision++;
      this.scanning = false;
    }
  }
  async select(serial: string | null, revision: number) {
    if (this.stopped || this.selecting || this.scanning || revision !== this.revision)
      throw Error("The device list changed. Refresh before selecting a device.");
    if (this.cleanupFailed)
      throw Error(
        "Previous device cleanup failed. Stop this host and review its ADB forward before reconnecting.",
      );
    if (serial !== null && this.connection)
      throw Error("Release the current device before choosing another.");
    if (serial !== null && !this.devices.some((item) => item.serial === serial))
      throw Error("The selected device is no longer available. Refresh the device list.");
    this.selecting = true;
    this.epoch++;
    this.revision++;
    this.error = undefined;
    this.selectionTask = this.change(serial);
    try {
      await this.selectionTask;
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : "Could not link the selected Studio device.";
      throw error;
    } finally {
      this.selecting = false;
    }
  }
  private async change(serial: string | null) {
    const previous = this.connection;
    this.connection = undefined;
    this.serial = null;
    if (previous) {
      try {
        await previous.close();
      } catch {
        this.cleanupFailed = true;
        throw Error(
          "The previous device disconnected, but its ADB forward could not be removed. Check USB connectivity before stopping this host.",
        );
      }
    }
    if (serial === null || this.stopped) return;
    const connection = await this.io.connect(serial);
    if (this.stopped) {
      await connection.close();
      return;
    }
    this.connection = connection;
    this.serial = serial;
  }
  async capture(signal: AbortSignal) {
    const phone = this.phone,
      serial = this.serial;
    if (!phone || !serial) throw Error("Select a Studio device before capturing.");
    return captureLayouts(phone, adbCaptureDevice(serial), signal);
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    await this.selectionTask?.catch(() => undefined);
    const connection = this.connection;
    this.connection = undefined;
    this.serial = null;
    await connection?.close();
  }
}
