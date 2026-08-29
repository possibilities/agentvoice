import { describe, expect, test } from "bun:test"
import {
  DroidedHostClient,
  KEYBOARD_HIDE_SEQUENCE,
  KEYBOARD_SHOW_SEQUENCE,
  PRIVATE_OSC_PAYLOAD_LIMIT,
  PrivateOscParser,
  hostMessageSequence,
  hostRequestSequence,
  keyboard,
  keyboardRequestSequence,
  parseHostMessageSequence,
} from "../src/index.ts"

describe("keyboard request encoding", () => {
  test("uses exact private OSC bytes", () => {
    expect(KEYBOARD_SHOW_SEQUENCE).toBe("\x1b]888;droidedtui;2;keyboard;show\x1b\\")
    expect(KEYBOARD_HIDE_SEQUENCE).toBe("\x1b]888;droidedtui;2;keyboard;hide\x1b\\")
    expect(keyboardRequestSequence("show", "bel")).toBe("\x1b]888;droidedtui;2;keyboard;show\x07")
  })

  test("writes through an injected terminal writer", () => {
    const output: string[] = []
    keyboard.show((sequence) => {
      output.push(sequence)
    })
    keyboard.hide((sequence) => {
      output.push(sequence)
    })
    expect(output).toEqual([KEYBOARD_SHOW_SEQUENCE, KEYBOARD_HIDE_SEQUENCE])
  })
})

describe("PrivateOscParser", () => {
  test("accepts ST-terminated commands at every chunk split", () => {
    for (const sequence of [KEYBOARD_SHOW_SEQUENCE, KEYBOARD_HIDE_SEQUENCE]) {
      const expected = sequence === KEYBOARD_SHOW_SEQUENCE ? "show" : "hide"
      for (let split = 0; split <= sequence.length; split += 1) {
        const parser = new PrivateOscParser()
        const requests = [...parser.feed(sequence.slice(0, split)), ...parser.feed(sequence.slice(split))]
        expect(requests).toEqual([expected])
      }
    }
  })

  test("accepts BEL and a sequence split one byte at a time", () => {
    const parser = new PrivateOscParser()
    const requests: string[] = []
    for (const byte of new TextEncoder().encode(keyboardRequestSequence("show", "bel"))) {
      requests.push(...parser.feed(Uint8Array.of(byte)))
    }
    expect(requests).toEqual(["show"])
  })

  test("finds multiple commands amid ordinary terminal output", () => {
    const seen: string[] = []
    const parser = new PrivateOscParser((request) => seen.push(request))
    const parsed = parser.feed(`before${KEYBOARD_SHOW_SEQUENCE}middle${KEYBOARD_HIDE_SEQUENCE}after`)
    expect(parsed).toEqual(["show", "hide"])
    expect(seen).toEqual(parsed)
  })

  test("ignores unknown, malformed, and non-ASCII payloads", () => {
    const parser = new PrivateOscParser()
    const input = [
      "\x1b]889;droidedtui;2;keyboard;show\x1b\\",
      "\x1b]888;elsewhere;2;keyboard;show\x1b\\",
      "\x1b]888;droidedtui;1;keyboard;show\x1b\\",
      "\x1b]888;droidedtui;2;keyboard;toggle\x1b\\",
      "\x1b]888;droidedtui;2;keyboard;shöw\x07",
    ].join("")
    expect(parser.feed(input)).toEqual([])
  })

  test("bounds oversized payloads and recovers at the next OSC", () => {
    const parser = new PrivateOscParser()
    const oversized = `\x1b]${"x".repeat(PRIVATE_OSC_PAYLOAD_LIMIT + 1)}\x1b\\`
    expect(parser.feed(`${oversized}${KEYBOARD_SHOW_SEQUENCE}`)).toEqual(["show"])
  })

  test("recovers from a malformed unterminated OSC when a new OSC starts", () => {
    const parser = new PrivateOscParser()
    expect(parser.feed(`\x1b]broken${KEYBOARD_HIDE_SEQUENCE}`)).toEqual(["hide"])
  })

  test("reset drops a partial command", () => {
    const parser = new PrivateOscParser()
    parser.feed(KEYBOARD_SHOW_SEQUENCE.slice(0, -1))
    parser.reset()
    expect(parser.feed("\\")).toEqual([])
  })
})

describe("host request and response encoding", () => {
  test("round-trips bounded JSON through private OSC", () => {
    const request = { id: "request-1", op: "identity.get-or-create", params: { alias: "remote" } }
    expect(hostRequestSequence(request)).toBe(
      "\x1b]888;droidedtui;2;host;eyJpZCI6InJlcXVlc3QtMSIsIm9wIjoiaWRlbnRpdHkuZ2V0LW9yLWNyZWF0ZSIsInBhcmFtcyI6eyJhbGlhcyI6InJlbW90ZSJ9fQ\x1b\\",
    )

    const message = { id: "request-1", ok: true as const, result: { publicKey: "abc" } }
    expect(parseHostMessageSequence(hostMessageSequence(message))).toEqual(message)
    expect(parseHostMessageSequence("\x1b]888;droidedtui;1;host;e30\x1b\\")).toBeNull()
    expect(parseHostMessageSequence("ordinary input")).toBeNull()
  })

  test("rejects malformed envelopes and oversized JSON", () => {
    expect(() => hostRequestSequence({ id: "", op: "host.info" })).toThrow("id")
    expect(() => hostRequestSequence({ id: "ok", op: "not allowed" })).toThrow("op")
    expect(() =>
      hostRequestSequence({ id: "ok", op: "host.info", params: { value: "x".repeat(PRIVATE_OSC_PAYLOAD_LIMIT) } }),
    ).toThrow("bytes")
    expect(parseHostMessageSequence("\x1b]888;droidedtui;2;host;%%%\x1b\\")).toBeNull()
  })
})

describe("DroidedHostClient", () => {
  test("correlates replies and fans out discovery events", async () => {
    const writes: string[] = []
    let oscHandler: ((sequence: string) => void) | null = null
    const events: unknown[] = []
    const client = new DroidedHostClient(
      {
        subscribeOsc(handler) {
          oscHandler = handler
          return () => {
            oscHandler = null
          }
        },
      },
      (sequence) => {
        writes.push(sequence)
      },
    )
    const unsubscribe = client.subscribe("discovery.service", (data) => events.push(data))

    const pending = client.request("host.info")
    const request = decodeHostRequest(writes[0]!)
    const emitOsc = (sequence: string): void => {
      if (!oscHandler) throw new Error("OSC handler was not installed")
      oscHandler(sequence)
    }
    emitOsc(hostMessageSequence({ id: request.id, ok: true, result: { platform: "android" } }))
    expect(await pending).toEqual({ platform: "android" })

    emitOsc(hostMessageSequence({ event: "discovery.service", data: { name: "AgentVoice", host: "192.0.2.1" } }))
    expect(events).toEqual([{ name: "AgentVoice", host: "192.0.2.1" }])
    unsubscribe()
    client.close()
    expect(oscHandler).toBeNull()
  })

  test("bounds pending work and rejects it on close", async () => {
    const client = new DroidedHostClient({ subscribeOsc: () => () => {} }, () => {}, {
      maxPending: 1,
      timeoutMs: 60_000,
    })
    const first = client.request("host.info")
    await expect(client.request("host.info")).rejects.toThrow("pending")
    client.close()
    await expect(first).rejects.toThrow("closed")
  })
})

function decodeHostRequest(sequence: string): { id: string; op: string; params?: unknown } {
  const encoded = sequence.slice(sequence.indexOf(";host;") + 6, -2)
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
}
