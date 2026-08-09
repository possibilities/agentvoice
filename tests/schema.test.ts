import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSchema } from "../scripts/generate-schema.ts";

describe("server.schema.json", () => {
  test("matches the generator (fix with `bun run generate:schema`)", async () => {
    const checkedIn = JSON.parse(
      await Bun.file(join(import.meta.dir, "..", "server.schema.json")).text(),
    );
    // buildSchema() itself throws when a config.ts key list and the schema
    // properties disagree, so this test also gates new config keys.
    expect(checkedIn).toEqual(buildSchema());
  });
});
