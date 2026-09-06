import { voiceNotification } from "../src/events/voice.ts";

/** Append-only output works in terminals and pipes, including interleaved speakers. */
export class VoiceMessageStream {
  private readonly items = new Map<string, { role: string; text: string }>();
  private line: string | undefined;

  constructor(private readonly write: (text: string) => unknown) {}

  finish(): void {
    if (this.line !== undefined) this.write("\n");
    this.line = undefined;
  }

  accept(frame: {
    event: string;
    data: { instanceId?: string; generation?: number; [key: string]: unknown };
  }): void {
    const { instanceId, generation, sequence: _sequence, ...data } = frame.data;
    const notification = voiceNotification({ event: frame.event, data });
    if (!notification) return;
    const itemId =
      notification.event === "voice.item.transcript.delta"
        ? notification.data.itemId
        : notification.data.item.id;
    const key = JSON.stringify([instanceId, generation, notification.data.threadId, itemId]);
    const append = (role: string, text: string) => {
      if (!text) return;
      if (this.line !== key) {
        this.finish();
        this.write(`${role}: `);
        this.line = key;
      }
      this.write(text);
    };
    if (notification.event === "voice.item.transcript.delta") {
      const active = this.items.get(key);
      // A delta has no role. Wait for completion when its start was missed.
      if (!active) return;
      append(active.role, notification.data.delta);
      active.text += notification.data.delta;
      if (active.text.length > 64 * 1024) this.items.delete(key);
      return;
    }
    const item = notification.data.item;
    if (item.type !== "transcriptSegment") return;
    if (notification.event === "voice.item.started") {
      if (this.items.has(key)) return;
      if (this.items.size >= 128) this.items.delete(this.items.keys().next().value!);
      this.items.set(key, { role: item.role, text: item.text });
      append(item.role, item.text);
      return;
    }
    const active = this.items.get(key);
    if (!active) {
      append(item.role, item.text);
    } else if (item.text.startsWith(active.text)) {
      append(item.role, item.text.slice(active.text.length));
    } else if (item.text !== active.text) {
      this.finish();
      this.write(`${item.role} (final): ${item.text}\n`);
    }
    if (this.line === key) this.finish();
    this.items.delete(key);
  }
}
