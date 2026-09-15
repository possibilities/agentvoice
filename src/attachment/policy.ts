export type Json = Record<string, unknown>;
export type AttachmentIdentity = { threadId: string; workspace: string };

export function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Json;
}

function keys(params: Json, allowed: string[]): void {
  for (const [key, value] of Object.entries(params))
    if (value === null && !allowed.includes(key)) delete params[key];
  const unknown = Object.entries(params)
    .filter(([key, value]) => value !== null && !allowed.includes(key))
    .map(([key]) => key);
  if (unknown.length) throw new Error(`Attachment does not support ${unknown.join(", ")}`);
}

function textInput(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("One text input is required");
  const input = object(value[0]);
  keys(input, ["type", "text", "text_elements"]);
  if (
    input["type"] !== "text" ||
    typeof input["text"] !== "string" ||
    !input["text"].trim() ||
    Buffer.byteLength(input["text"]) > 64 * 1024 ||
    (input["text_elements"] !== undefined &&
      (!Array.isArray(input["text_elements"]) || input["text_elements"].length !== 0))
  )
    throw new Error("One nonempty text input of at most 64 KiB is required");
}

/** Only host-owned web input and explicit speech operations cross this gateway. */
export function validateAttachmentRequest(
  method: string,
  params: Json,
  identity: AttachmentIdentity,
): void {
  if (method !== "initialize" && params["threadId"] !== identity.threadId)
    throw new Error("Attachment is bound to one thread");
  switch (method) {
    case "initialize":
      keys(params, ["clientInfo", "capabilities"]);
      break;
    case "turn/start":
      keys(params, ["threadId", "clientUserMessageId", "input"]);
      textInput(params["input"]);
      break;
    case "turn/steer":
      keys(params, ["threadId", "expectedTurnId", "clientUserMessageId", "input"]);
      textInput(params["input"]);
      break;
    case "turn/interrupt":
      keys(params, ["threadId", "turnId"]);
      break;
    case "thread/realtime/appendSpeech":
      keys(params, ["threadId", "text"]);
      if (
        typeof params["text"] !== "string" ||
        !params["text"].trim() ||
        Buffer.byteLength(params["text"]) > 64 * 1024
      )
        throw new Error("Speech text must be nonempty and at most 64 KiB");
      break;
    default:
      throw new Error(`Attachment does not support ${method}`);
  }
}
