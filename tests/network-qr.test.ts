import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NETWORK_USAGE, networkCommand, parseNetworkCommand } from "../src/network/command.ts";
import { configureNetwork, DeviceCredentials } from "../src/network/credentials.ts";
import {
  createGrantQr,
  createGrantQrMatrix,
  createGrantQrPayload,
  GRANT_QR_MAX_BYTES,
  GRANT_QR_PREFIX,
  GRANT_QR_QUIET_ZONE,
  renderGrantQr,
} from "../src/network/qr.ts";

const endpoint = "wss://voice.example:48414/v2/client";
const token = `${"a".repeat(32)}.${"b".repeat(64)}`;

function temporaryState(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "av-network-qr-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function stripAnsi(line: string): string {
  let visible = "";
  for (let index = 0; index < line.length; index++) {
    if (line.charCodeAt(index) !== 27) {
      visible += line[index];
      continue;
    }
    index = line.indexOf("m", index);
    if (index === -1) throw new Error("unterminated ANSI sequence");
  }
  return visible;
}

test("network qr parser accepts exactly one named device and preserves other strict forms", () => {
  expect(parseNetworkCommand(["qr", "--name", "Android phone"])).toEqual({
    action: "qr",
    name: "Android phone",
  });
  expect(parseNetworkCommand(["grant", "--out", "phone.json", "--name", "Phone"])).toEqual({
    action: "grant",
    name: "Phone",
    output: "phone.json",
  });
  for (const args of [
    ["qr"],
    ["qr", "--name"],
    ["qr", "--name", "Phone", "--name", "Again"],
    ["qr", "--out", "phone.json"],
    ["qr", "--name=Phone"],
    ["--help", "extra"],
    ["status", "extra"],
  ])
    expect(() => parseNetworkCommand(args)).toThrow(NETWORK_USAGE);
});

test("grant QR payload is exact, strict and byte bounded; terminal rendering has a quiet zone", () => {
  const profile = { version: 1 as const, endpoint, token };
  const payload = createGrantQrPayload(profile);
  expect(payload).toBe(`${GRANT_QR_PREFIX}${JSON.stringify(profile)}`);
  expect(() => createGrantQrPayload({ ...profile, extra: true })).toThrow("invalid");
  try {
    createGrantQrPayload({ ...profile, token: "DO-NOT-PRINT" });
    throw new Error("accepted invalid profile");
  } catch (error) {
    expect(String(error)).not.toContain("DO-NOT-PRINT");
  }
  expect(() => createGrantQrMatrix("not-a-grant")).toThrow("invalid");
  expect(() =>
    createGrantQrMatrix(`${GRANT_QR_PREFIX}${JSON.stringify({ ...profile, extra: true })}`),
  ).toThrow("invalid");
  expect(() => createGrantQrMatrix(`${GRANT_QR_PREFIX} ${JSON.stringify(profile)}`)).toThrow(
    "invalid",
  );

  const exactEndpoint = `wss://${"a".repeat(1869)}.example/v2/client`;
  expect(
    new TextEncoder().encode(createGrantQrPayload({ ...profile, endpoint: exactEndpoint })),
  ).toHaveLength(GRANT_QR_MAX_BYTES);
  const oversizedEndpoint = `wss://${"a".repeat(1870)}.example/v2/client`;
  expect(() => createGrantQrPayload({ ...profile, endpoint: oversizedEndpoint })).toThrow(
    "2048-byte limit",
  );

  const qr = createGrantQr(profile);
  const width = qr.matrix.length + 2 * GRANT_QR_QUIET_ZONE;
  expect(() => renderGrantQr(qr.matrix, { isTTY: true, columns: width - 1 })).toThrow("too narrow");
  const rendered = renderGrantQr(qr.matrix, { isTTY: true, columns: width });
  const visibleLines = rendered.split("\n").map(stripAnsi);
  expect(visibleLines).toHaveLength(Math.ceil(width / 2));
  expect(visibleLines.every((line) => [...line].length === width)).toBe(true);
  expect(
    rendered
      .split("\n")
      .slice(0, GRANT_QR_QUIET_ZONE / 2)
      .join("\n"),
  ).toBe(
    Array.from(
      { length: GRANT_QR_QUIET_ZONE / 2 },
      () => `\u001b[38;2;255;255;255;48;2;255;255;255m${"▀".repeat(width)}\u001b[0m`,
    ).join("\n"),
  );
  expect(rendered).toContain("38;2;0;0;0");
  expect(rendered).toContain("48;2;0;0;0");
  expect(rendered).not.toMatch(/\[(?:30|37|40|47)(?:;|m)/);
  expect(renderGrantQr(qr.matrix, { isTTY: false, columns: 1 })).toContain("▀");
});

test("network qr writes the inactive code before activation, then writes only its safe receipt", () => {
  temporaryState((root) => {
    configureNetwork(root, { version: 1, endpoint, port: 44414 });
    const credentials = new DeviceCredentials(root);
    expect(() => credentials.prepareGrant("Phone", "ws://voice.example/v2/client")).toThrow();
    expect(() => credentials.prepareGrant("", endpoint)).toThrow();
    expect(() =>
      networkCommand(["qr", "--name", "Too narrow"], root, {
        terminal: { isTTY: true, columns: 1 },
        write: () => {
          throw new Error("render failure must not write");
        },
      }),
    ).toThrow("too narrow");
    expect(credentials.list()).toHaveLength(0);

    const output: string[] = [];
    const recordsWhenWritten: number[] = [];
    networkCommand(["qr", "--name", "Android"], root, {
      terminal: { isTTY: false },
      write: (value) => {
        recordsWhenWritten.push(credentials.list().length);
        output.push(value);
      },
    });
    expect(recordsWhenWritten).toEqual([0, 1]);
    expect(output).toHaveLength(2);
    expect(output[0]).toContain("▀");
    expect(output[0]).not.toContain("Device ID:");
    expect(output[1]).not.toContain("▀");
    expect(credentials.list()[0]?.label).toBe("Android");
    expect(output[1]).toContain("Private reusable device credential, valid for 30 days");
    expect(output.join("\n")).not.toContain(endpoint);
    expect(output.join("\n")).not.toContain(GRANT_QR_PREFIX);
    expect(output.join("\n")).not.toContain('{"version"');
    expect(output.join("\n")).not.toMatch(/[a-f0-9]{32}\.[a-f0-9]{64}/);
    expect(output[1]).toContain(`Device ID: ${credentials.list()[0]!.id}`);
    expect(output[1]).toContain(
      `Expires: ${new Date(credentials.list()[0]!.expiresAt).toISOString()}`,
    );
    expect(output[1]).toContain(`agentvoice network revoke ${credentials.list()[0]!.id}`);
  });
});

test("initial QR output failure leaves no active grant and sanitizes the error", () => {
  temporaryState((root) => {
    configureNetwork(root, { version: 1, endpoint, port: 44414 });
    const credentials = new DeviceCredentials(root);
    let recordsWhenWritten = -1;
    let error = "";
    try {
      networkCommand(["qr", "--name", "Android"], root, {
        terminal: { isTTY: false },
        write: (output) => {
          recordsWhenWritten = credentials.list().length;
          throw new Error(output);
        },
      });
    } catch (value) {
      error = String(value);
    }
    expect(recordsWhenWritten).toBe(0);
    expect(credentials.list()).toHaveLength(0);
    expect(error).toBe(
      "Error: Unable to write private credential QR; no device grant was activated",
    );
    expect(error).not.toContain(endpoint);
    expect(error).not.toContain(GRANT_QR_PREFIX);
    expect(error).not.toMatch(/[a-f0-9]{32}\.[a-f0-9]{64}/);
  });
});

test("activation failure leaves the displayed code invalid and reports no secret", () => {
  temporaryState((root) => {
    configureNetwork(root, { version: 1, endpoint, port: 44414 });
    const credentials = new DeviceCredentials(root);
    let displayed = "";
    let error = "";
    try {
      networkCommand(["qr", "--name", "Android"], root, {
        terminal: { isTTY: false },
        write: (output) => {
          displayed = output;
          for (let index = 0; index < 1024; index++)
            writeFileSync(join(credentials.directory, `capacity-${index}`), "", { mode: 0o600 });
        },
      });
    } catch (value) {
      error = String(value);
    }
    expect(displayed).toContain("▀");
    expect(credentials.list()).toHaveLength(0);
    expect(error).toBe(
      "Error: Unable to activate displayed private credential QR; displayed code is invalid",
    );
    expect(error).not.toContain(endpoint);
    expect(error).not.toContain(GRANT_QR_PREFIX);
    expect(error).not.toMatch(/[a-f0-9]{32}\.[a-f0-9]{64}/);
  });
});

test("receipt output failure retains the already disclosed active grant", () => {
  temporaryState((root) => {
    configureNetwork(root, { version: 1, endpoint, port: 44414 });
    const credentials = new DeviceCredentials(root);
    let writes = 0;
    const activeWhenWritten: boolean[] = [];
    let firstOutput = "";
    let error = "";
    try {
      networkCommand(["qr", "--name", "Android"], root, {
        terminal: { isTTY: false },
        write: (output) => {
          writes++;
          activeWhenWritten.push(credentials.list()[0]?.active === true);
          if (writes === 1) {
            firstOutput = output;
            return;
          }
          throw new Error(output);
        },
      });
    } catch (value) {
      error = String(value);
    }
    expect(writes).toBe(2);
    expect(activeWhenWritten).toEqual([false, true]);
    expect(firstOutput).toContain("▀");
    expect(credentials.list()).toHaveLength(1);
    expect(credentials.list()[0]?.active).toBe(true);
    expect(error).toBe(
      "Error: Private credential QR is active, but its receipt could not be written; run agentvoice network list for its device ID and expiry",
    );
    expect(error).not.toContain(endpoint);
    expect(error).not.toContain(GRANT_QR_PREFIX);
    expect(error).not.toMatch(/[a-f0-9]{32}\.[a-f0-9]{64}/);
  });
});

test("invalid metadata, missing configuration and oversized QR never activate credentials", () => {
  temporaryState((root) => {
    expect(() => networkCommand(["qr", "--name", "Phone"], root)).toThrow(
      "Configure the network endpoint first",
    );
  });
  temporaryState((root) => {
    configureNetwork(root, { version: 1, endpoint, port: 44414 });
    const credentials = new DeviceCredentials(root);
    expect(() =>
      networkCommand(["qr", "--name", "bad\nname"], root, {
        terminal: { isTTY: false },
      }),
    ).toThrow("control characters");
    expect(credentials.list()).toHaveLength(0);
  });
  temporaryState((root) => {
    const oversizedEndpoint = `wss://${"a".repeat(1870)}.example/v2/client`;
    configureNetwork(root, { version: 1, endpoint: oversizedEndpoint, port: 44414 });
    const credentials = new DeviceCredentials(root);
    let error = "";
    try {
      networkCommand(["qr", "--name", "Phone"], root, { terminal: { isTTY: false } });
    } catch (value) {
      error = String(value);
    }
    expect(error).toContain("2048-byte limit");
    expect(error).not.toContain(oversizedEndpoint);
    expect(credentials.list()).toHaveLength(0);
  });
});

test("staged QR grants retain 30-day authentication and revocation semantics", () => {
  temporaryState((root) => {
    const credentials = new DeviceCredentials(root);
    const now = 1_800_000_000_000;
    const pending = credentials.prepareGrant("Android", endpoint, now);
    expect(credentials.list()).toHaveLength(0);
    expect(credentials.activateGrant(pending)).toBe(pending.id);
    expect(() => credentials.activateGrant(pending)).toThrow("already activated");
    expect(credentials.authenticate(pending.profile.token, now)).toBe(pending.id);
    expect(credentials.authenticate(pending.profile.token, now + 30 * 86400_000 - 1)).toBe(
      pending.id,
    );
    expect(credentials.authenticate(pending.profile.token, now + 30 * 86400_000)).toBeUndefined();
    credentials.revoke(pending.id);
    expect(credentials.authenticate(pending.profile.token, now)).toBeUndefined();
  });
});
