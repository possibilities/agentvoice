/** Browser and host share path metadata only; native Codex owns image preparation. */
export type LocalImageAttachment = { path: string };
export const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_LOCAL_IMAGES = 4;
export const CLIPBOARD_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
