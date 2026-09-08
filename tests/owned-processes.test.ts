import { expect, test } from "bun:test";
import { processTableBackendForPlatform } from "../src/core/owned-processes.ts";

test("uses proc for Linux and Android runtimes", () => {
  expect(processTableBackendForPlatform("linux")).toBe("proc");
  expect(processTableBackendForPlatform("android")).toBe("proc");
});

test("keeps the Darwin libproc backend", () => {
  expect(processTableBackendForPlatform("darwin")).toBe("libproc");
});

test("rejects unsupported platforms", () => {
  expect(() => processTableBackendForPlatform("win32")).toThrow(
    "Owned process tracking is unsupported on win32",
  );
});
