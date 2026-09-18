import { expect, test } from "bun:test";
import {
  absoluteReferencePath,
  insertFileReferences,
  transferredReferencePaths,
} from "../src/transcript-ui/transcript/file-references";

test("references accept actual absolute paths and local file URIs, never filename inference", () => {
  expect(absoluteReferencePath("file:///Users/me/a%20b.png")).toBe("/Users/me/a b.png");
  expect(absoluteReferencePath("@/Users/me/image.png")).toBe("/Users/me/image.png");
  expect(absoluteReferencePath('"/Users/me/a b.png"')).toBe("/Users/me/a b.png");
  for (const invalid of [
    "image.png",
    "C:\\fakepath\\image.png",
    "file://remote/share/a.png",
    "https://example.com/image.png",
    "data:image/png;base64,abc",
    "/a\nb",
    "//server/share",
    "file:///a%00b",
  ])
    expect(absoluteReferencePath(invalid)).toBeNull();
});

test("reference insertion replaces only the selection and preserves exact path text", () => {
  expect(insertFileReferences("Inspect this please", ["/Users/me/a b.png"], 8, 12)).toEqual({
    text: "Inspect @/Users/me/a b.png please",
    caret: 26,
  });
  expect(insertFileReferences("", ["/a.png", "/b.png"], 0, 0).text).toBe("@/a.png\n@/b.png");
});

test("clipboard worker task paths stay plain while file references retain their mention syntax", () => {
  const transfer = (text: string) => ({
    getData: (type: string) => (type === "text/plain" ? text : ""),
    files: [],
  });
  expect(transferredReferencePaths(transfer("/root/transcript_worker_path_copy"))).toEqual([]);
  expect(transferredReferencePaths(transfer("/Users/me/image.png"))).toEqual([
    "/Users/me/image.png",
  ]);
  expect(transferredReferencePaths(transfer("@/root/explicit_file_reference"))).toEqual([
    "/root/explicit_file_reference",
  ]);
});
