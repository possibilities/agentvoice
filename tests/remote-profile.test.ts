import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRemoteProfile,
  type RemoteProfile,
  saveRemoteProfile,
} from "../src/console/remote-profile.ts";
import { serverIdFromCertificate } from "../src/core/pairing.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Remote console profile", () => {
  test("atomically persists the pinned Server identity and route candidates", async () => {
    const directory = await scratch();
    const path = join(directory, "remote.json");
    const certificate = "certificate";
    const profile: RemoteProfile = {
      version: 1,
      serverId: serverIdFromCertificate(certificate),
      serverName: "agentvoice",
      certificate,
      deviceId: "device-id",
      endpoints: ["mac.example.ts.net", "100.64.0.2"],
      port: 8473,
    };
    saveRemoteProfile(path, profile);
    expect(loadRemoteProfile(path)).toEqual(profile);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("returns null when unpaired and rejects a certificate fingerprint mismatch", async () => {
    const directory = await scratch();
    const path = join(directory, "remote.json");
    expect(loadRemoteProfile(path)).toBeNull();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        serverId: "wrong",
        serverName: "agentvoice",
        certificate: "certificate",
        deviceId: "device",
        endpoints: [],
        port: 8473,
      }),
      { mode: 0o600 },
    );
    expect(() => loadRemoteProfile(path)).toThrow("certificate fingerprint");
  });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentvoice-profile-"));
  temporaryDirectories.push(directory);
  return directory;
}
