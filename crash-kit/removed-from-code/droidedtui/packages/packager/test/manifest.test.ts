import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadManifest, ManifestError, resolveLaunchArguments, validateManifest } from "../src/manifest.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("package manifest", () => {
  test("validates the developer milestone contract", () => {
    expect(validateManifest(validManifest())).toEqual(validManifest())
  })

  test("rejects unknown fields and unsupported ABIs", () => {
    expect(() => validateManifest({ ...validManifest(), duplicatePolicy: true })).toThrow(ManifestError)
    expect(() =>
      validateManifest({
        ...validManifest(),
        android: { minSdk: 28, targetSdk: 36, abis: ["x86_64"] },
      }),
    ).toThrow("android.abis")
  })

  test("validates an exported launch and resolves bounded environment arguments", () => {
    const manifest = validateManifest({
      ...validManifest(),
      launch: {
        export: "runRemote",
        arguments: [{ host: { $env: "AGENTVOICE_REMOTE_HOST" }, port: 8473, token: { $env: "TOKEN" } }],
      },
      android: {
        ...validManifest().android,
        network: { internet: true, cleartext: true, localDiscovery: true },
      },
    })

    expect(manifest.launch?.export).toBe("runRemote")
    expect(manifest.android.network).toEqual({ internet: true, cleartext: true, localDiscovery: true })
    expect(resolveLaunchArguments(manifest.launch!, { AGENTVOICE_REMOTE_HOST: "100.64.0.1", TOKEN: "secret" })).toEqual(
      [{ host: "100.64.0.1", port: 8473, token: "secret" }],
    )
  })

  test("requires internet when local network discovery is enabled", () => {
    expect(() =>
      validateManifest({
        ...validManifest(),
        android: {
          ...validManifest().android,
          network: { internet: false, cleartext: false, localDiscovery: true },
        },
      }),
    ).toThrow("android.network.localDiscovery requires android.network.internet")
  })

  test("rejects malformed or unresolved launch environment references", () => {
    expect(() =>
      validateManifest({
        ...validManifest(),
        launch: { export: "runRemote", arguments: [{ $env: "TOKEN", fallback: "unsafe" }] },
      }),
    ).toThrow("launch.arguments[0].$env must be the only field")

    const manifest = validateManifest({
      ...validManifest(),
      launch: { export: "runRemote", arguments: [{ token: { $env: "TOKEN" } }] },
    })
    expect(() => resolveLaunchArguments(manifest.launch!, {})).toThrow("TOKEN is required by launch.arguments")

    const inheritedName = validateManifest({
      ...validManifest(),
      launch: { export: "runRemote", arguments: [{ $env: "constructor" }] },
    })
    expect(() => resolveLaunchArguments(inheritedName.launch!, {})).toThrow(
      "constructor is required by launch.arguments",
    )
  })

  test("bounds launch argument shape and resolved environment values", () => {
    expect(() =>
      validateManifest({
        ...validManifest(),
        launch: { export: "run", arguments: [new Array(257).fill(null)] },
      }),
    ).toThrow("at most 256 values")

    let nested: unknown = null
    for (let depth = 0; depth < 18; depth += 1) nested = [nested]
    expect(() =>
      validateManifest({
        ...validManifest(),
        launch: { export: "run", arguments: [nested] },
      }),
    ).toThrow("at most 16 levels")

    expect(() =>
      validateManifest({
        ...validManifest(),
        launch: { export: "run", arguments: [new Array(5).fill("x".repeat(14_000))] },
      }),
    ).toThrow("at most 65536 UTF-8 bytes")

    const manifest = validateManifest({
      ...validManifest(),
      launch: { export: "run", arguments: [{ $env: "VALUE" }] },
    })
    expect(() => resolveLaunchArguments(manifest.launch!, { VALUE: "x".repeat(16 * 1024 + 1) })).toThrow(
      "at most 16384 UTF-8 bytes",
    )
  })

  test("resolves a real entry inside the project", async () => {
    const root = await project()
    const manifest = await loadManifest(root)
    expect(manifest.entryPath).toBe(await realpath(join(root, "src", "app.ts")))
  })

  test("rejects an entry outside the project", async () => {
    const root = await project({ entry: "../outside.ts" })
    await expect(loadManifest(root)).rejects.toThrow("entry must stay inside")
  })
})

function validManifest() {
  return {
    schemaVersion: 1 as const,
    name: "Example",
    applicationId: "com.example.app",
    version: { name: "1.0.0", code: 1 },
    entry: "src/app.ts",
    android: { minSdk: 28, targetSdk: 36, abis: ["arm64-v8a"] as ["arm64-v8a"] },
  }
}

async function project(overrides: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "droidedtui-manifest-"))
  temporaryDirectories.push(root)
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src", "app.ts"), "export {}\n")
  await writeFile(join(root, "droidedtui.json"), JSON.stringify({ ...validManifest(), ...overrides }))
  return root
}
