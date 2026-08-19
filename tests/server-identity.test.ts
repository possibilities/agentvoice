import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceIdFromPublicKey } from "../src/core/pairing.ts";
import { PairedDeviceStore } from "../src/server/paired-devices.ts";
import { ensureServerIdentity } from "../src/server/server-identity.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Server identity", () => {
  test("creates one private TLS identity atomically and reuses it", async () => {
    const directory = await scratch("identity");
    const first = ensureServerIdentity(directory);
    const second = ensureServerIdentity(directory);
    expect(second).toEqual(first);
    expect(first.serverId).toHaveLength(43);
    expect(first.serverName).toBe("agentvoice");
    expect(first.certificate).toContain("BEGIN CERTIFICATE");
    expect(first.privateKey).toContain("BEGIN EC PRIVATE KEY");
    expect((await stat(join(directory, "identity-key.pem"))).mode & 0o777).toBe(0o600);

    await unlink(join(directory, "identity-cert.pem"));
    expect(() => ensureServerIdentity(directory)).toThrow("partial Server identity");
  });
});

describe("paired device store", () => {
  test("persists individual public keys, updates metadata, and revokes one device", async () => {
    const directory = await scratch("devices");
    const path = join(directory, "paired-devices.json");
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const id = deviceIdFromPublicKey(publicKey);
    const store = PairedDeviceStore.open(path);
    store.pair({ id, name: "Samsung", publicKey, pairedAt: "2026-08-18T12:00:00.000Z" });
    store.pair({ id, name: "Samsung S24", publicKey, pairedAt: "2026-08-18T12:00:00.000Z" });
    expect(PairedDeviceStore.open(path).get(id)?.name).toBe("Samsung S24");
    expect(JSON.parse(await readFile(path, "utf8")).devices).toHaveLength(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(store.revoke(id)).toBe(true);
    expect(PairedDeviceStore.open(path).get(id)).toBeUndefined();
    expect(store.revoke(id)).toBe(false);
  });

  test("rejects a claimed id that does not fingerprint the public key", async () => {
    const directory = await scratch("bad-device");
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const store = PairedDeviceStore.open(join(directory, "paired-devices.json"));
    expect(() =>
      store.pair({ id: "wrong", name: "Phone", publicKey, pairedAt: new Date().toISOString() }),
    ).toThrow("fingerprint");
  });
});

async function scratch(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `agentvoice-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}
