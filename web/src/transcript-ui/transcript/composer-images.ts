import {
  type LocalImageAttachment,
  MAX_LOCAL_IMAGES,
} from "../../../../src/attachment/image-contract";
export type ComposerImage = LocalImageAttachment;

/** Browser recovery is untrusted; the host separately verifies scoped file ownership. */
export function parseComposerImages(value: unknown): ComposerImage[] {
  if (!Array.isArray(value) || value.length > MAX_LOCAL_IMAGES) return [];
  return value
    .filter(
      (image): image is ComposerImage =>
        image &&
        typeof image.path === "string" &&
        image.path.startsWith("/") &&
        image.path.length <= 4096 &&
        !Array.from(image.path as string).some(
          (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
        ),
    )
    .map(({ path }) => ({ path }));
}

export type SaveClipboardImage = (
  file: File,
  imageId: string,
  signal: AbortSignal,
) => Promise<ComposerImage>;
