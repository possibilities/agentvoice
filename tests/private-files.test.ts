import { expect, test } from "bun:test";
import { allowsAndroidTermuxAncestor, type PrivateFilesRuntime } from "../src/private-files.ts";

const termuxRuntime: PrivateFilesRuntime = {
  platform: "linux",
  environment: {
    ANDROID_ROOT: "/system",
    ANDROID_DATA: "/data",
    PREFIX: "/data/data/com.termux/files/usr",
    HOME: "/data/data/com.termux/files/home",
  },
  executablePath: "/data/data/com.termux/files/usr/bin/bun",
  uid: 10234,
};

test("allows only the exact Android traversal ancestors reported by Termux", () => {
  expect(
    allowsAndroidTermuxAncestor("/data", { uid: 1000, mode: 0o40771 }, termuxRuntime, false),
  ).toBe(true);
  expect(
    allowsAndroidTermuxAncestor("/data/data", { uid: 1000, mode: 0o40771 }, termuxRuntime, false),
  ).toBe(true);
  expect(
    allowsAndroidTermuxAncestor(
      "/data/data/com.termux/files",
      { uid: termuxRuntime.uid!, mode: 0o40771 },
      termuxRuntime,
      true,
    ),
  ).toBe(true);
});

test("requires the app-owned mode-0700 boundary before allowing the files directory", () => {
  expect(
    allowsAndroidTermuxAncestor(
      "/data/data/com.termux/files",
      { uid: termuxRuntime.uid!, mode: 0o40771 },
      termuxRuntime,
      false,
    ),
  ).toBe(false);
  expect(
    allowsAndroidTermuxAncestor(
      "/data/data/com.termux/files",
      { uid: 123, mode: 0o40771 },
      termuxRuntime,
      true,
    ),
  ).toBe(false);
});

test("does not relax other Android paths, permissions, packages, or desktop policy", () => {
  expect(
    allowsAndroidTermuxAncestor("/data", { uid: 0, mode: 0o40771 }, termuxRuntime, false),
  ).toBe(false);
  expect(
    allowsAndroidTermuxAncestor("/data/local", { uid: 1000, mode: 0o40771 }, termuxRuntime, false),
  ).toBe(false);
  expect(
    allowsAndroidTermuxAncestor("/data", { uid: 1000, mode: 0o40777 }, termuxRuntime, false),
  ).toBe(false);
  expect(
    allowsAndroidTermuxAncestor(
      "/data/data/com.termux",
      { uid: termuxRuntime.uid!, mode: 0o40771 },
      termuxRuntime,
      false,
    ),
  ).toBe(false);
  expect(
    allowsAndroidTermuxAncestor(
      "/data",
      { uid: 1000, mode: 0o40771 },
      { ...termuxRuntime, platform: "darwin", environment: {}, executablePath: "/usr/bin/bun" },
      false,
    ),
  ).toBe(false);
  expect(
    allowsAndroidTermuxAncestor(
      "/data",
      { uid: 1000, mode: 0o40771 },
      {
        ...termuxRuntime,
        environment: { ANDROID_ROOT: "/system", PREFIX: "/data/data/other.app/files/usr" },
        executablePath: "/data/data/other.app/files/usr/bin/bun",
      },
      false,
    ),
  ).toBe(false);
});
