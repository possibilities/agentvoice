import qrcode from "qrcode-generator";
import { type ConnectionProfile, connectionProfileSchema } from "./credentials.ts";

export const GRANT_QR_PREFIX = "agentvoice-grant:v1:";
export const GRANT_QR_MAX_BYTES = 2048;
export const GRANT_QR_QUIET_ZONE = 4;

export type QrMatrix = readonly (readonly boolean[])[];

function validatedProfile(value: unknown): ConnectionProfile {
  try {
    return connectionProfileSchema.parse(value);
  } catch {
    throw new Error("Grant profile is invalid");
  }
}

export function createGrantQrPayload(value: unknown): string {
  const profile = validatedProfile(value);
  const payload = `${GRANT_QR_PREFIX}${JSON.stringify({
    version: profile.version,
    endpoint: profile.endpoint,
    token: profile.token,
  })}`;
  if (new TextEncoder().encode(payload).byteLength > GRANT_QR_MAX_BYTES)
    throw new Error("Grant QR payload exceeds the 2048-byte limit");
  return payload;
}

export function createGrantQrMatrix(payload: string): QrMatrix {
  const bytes = new TextEncoder().encode(payload);
  if (bytes.byteLength > GRANT_QR_MAX_BYTES)
    throw new Error("Grant QR payload exceeds the 2048-byte limit");
  try {
    if (
      !payload.startsWith(GRANT_QR_PREFIX) ||
      createGrantQrPayload(JSON.parse(payload.slice(GRANT_QR_PREFIX.length))) !== payload
    )
      throw new Error();
  } catch {
    throw new Error("Grant QR payload is invalid");
  }
  try {
    const code = qrcode(0, "M");
    code.addData(String.fromCharCode(...bytes), "Byte");
    code.make();
    return Array.from({ length: code.getModuleCount() }, (_, row) =>
      Array.from({ length: code.getModuleCount() }, (_, column) => code.isDark(row, column)),
    );
  } catch {
    throw new Error("Unable to encode private credential QR");
  }
}

export function createGrantQr(value: unknown): { payload: string; matrix: QrMatrix } {
  const payload = createGrantQrPayload(value);
  return { payload, matrix: createGrantQrMatrix(payload) };
}

function validateMatrix(matrix: QrMatrix): number {
  const size = matrix.length;
  if (
    size < 21 ||
    size > 177 ||
    (size - 21) % 4 !== 0 ||
    matrix.some((row) => row.length !== size || row.some((module) => typeof module !== "boolean"))
  )
    throw new Error("Grant QR matrix is invalid");
  return size;
}

function moduleAt(matrix: QrMatrix, row: number, column: number): boolean {
  const sourceRow = row - GRANT_QR_QUIET_ZONE;
  const sourceColumn = column - GRANT_QR_QUIET_ZONE;
  return matrix[sourceRow]?.[sourceColumn] ?? false;
}

export function renderGrantQr(
  matrix: QrMatrix,
  terminal: { isTTY: boolean; columns?: number },
): string {
  const size = validateMatrix(matrix) + 2 * GRANT_QR_QUIET_ZONE;
  if (terminal.isTTY && (terminal.columns === undefined || terminal.columns < size))
    throw new Error("Terminal is too narrow to display the private credential QR");

  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = "";
    let colors = "";
    for (let column = 0; column < size; column++) {
      const foreground = moduleAt(matrix, row, column) ? "38;2;0;0;0" : "38;2;255;255;255";
      const background = moduleAt(matrix, row + 1, column) ? "48;2;0;0;0" : "48;2;255;255;255";
      const next = `${foreground};${background}`;
      if (next !== colors) {
        line += `\u001b[${next}m`;
        colors = next;
      }
      line += "▀";
    }
    lines.push(`${line}\u001b[0m`);
  }
  return lines.join("\n");
}
