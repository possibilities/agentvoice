/**
 * Ordered writer over a partial-write stream socket. Bun's `socket.write`
 * returns the bytes accepted by the kernel, so every remainder stays queued
 * until a later drain without allowing newer frames to overtake it.
 */
export class SocketOutbox {
  private readonly pending: Buffer[] = [];

  constructor(private readonly writeBytes: (data: Buffer) => number) {}

  write(data: Buffer): void {
    if (this.pending.length > 0) {
      this.pending.push(data);
      return;
    }
    const written = this.writeBytes(data);
    if (written < data.length) this.pending.push(data.subarray(Math.max(0, written)));
  }

  /** Called from the socket's drain event: send what the kernel deferred. */
  flush(): void {
    while (this.pending.length > 0) {
      const head = this.pending[0] as Buffer;
      const written = this.writeBytes(head);
      if (written < head.length) {
        this.pending[0] = head.subarray(Math.max(0, written));
        return;
      }
      this.pending.shift();
    }
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }
}
