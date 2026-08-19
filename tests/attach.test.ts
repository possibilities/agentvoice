import { describe, expect, test } from "bun:test";
import { SocketOutbox } from "../src/core/socket-outbox.ts";

/** A socket that accepts at most `cap` bytes per write until drained. */
function throttledSink(cap: number): {
  outbox: SocketOutbox;
  drained(): Buffer;
  drainKernel(): void;
} {
  const accepted: Buffer[] = [];
  let budget = cap;
  const outbox = new SocketOutbox((data) => {
    const take = Math.min(budget, data.length);
    if (take > 0) accepted.push(Buffer.from(data.subarray(0, take)));
    budget -= take;
    return take;
  });
  return {
    outbox,
    drained: () => Buffer.concat(accepted),
    drainKernel: () => {
      budget = cap;
      outbox.flush();
    },
  };
}

describe("SocketOutbox", () => {
  test("small writes pass straight through", () => {
    const sink = throttledSink(8192);
    sink.outbox.write(Buffer.from("hello"));
    expect(sink.drained().toString()).toBe("hello");
    expect(sink.outbox.hasPending).toBe(false);
  });

  test("a frame larger than the kernel buffer delivers whole across drains", () => {
    const sink = throttledSink(8192);
    const frame = Buffer.alloc(20000, 7);
    sink.outbox.write(frame);
    expect(sink.outbox.hasPending).toBe(true);
    sink.drainKernel();
    sink.drainKernel();
    expect(sink.outbox.hasPending).toBe(false);
    expect(Buffer.compare(sink.drained(), frame)).toBe(0);
  });

  test("writes issued while a remainder is pending keep their order", () => {
    const sink = throttledSink(4);
    sink.outbox.write(Buffer.from("AAAAAAAA")); // 8 bytes: 4 sent, 4 pending
    sink.outbox.write(Buffer.from("BB"));
    sink.outbox.write(Buffer.from("C"));
    while (sink.outbox.hasPending) sink.drainKernel();
    expect(sink.drained().toString()).toBe("AAAAAAAABBC");
  });

  test("a zero-byte kernel acceptance keeps the whole write pending", () => {
    const sink = throttledSink(0);
    sink.outbox.write(Buffer.from("payload"));
    expect(sink.outbox.hasPending).toBe(true);
    expect(sink.drained().length).toBe(0);
  });

  test("a negative write return is treated as nothing accepted", () => {
    const outbox = new SocketOutbox(() => -1);
    outbox.write(Buffer.from("data"));
    expect(outbox.hasPending).toBe(true);
  });

  test("flush stops at the still-full boundary and resumes later", () => {
    const sink = throttledSink(3);
    sink.outbox.write(Buffer.from("123456"));
    sink.outbox.write(Buffer.from("789"));
    sink.drainKernel(); // sends "456"
    expect(sink.drained().toString()).toBe("123456");
    sink.drainKernel(); // sends "789"
    expect(sink.drained().toString()).toBe("123456789");
    expect(sink.outbox.hasPending).toBe(false);
  });
});
