/**
 * Ambient view of the DroidedTUI host-protocol surface this repo relies on.
 * The real implementation ships from the sibling `~/code/droidedtui`
 * checkout as an optional file: dependency — optional so CI, which has no
 * sibling checkout, still installs — and is imported only at Android
 * runtime, where the packager bundles it. Keep this in lockstep with
 * `droidedtui/packages/protocol/src/index.ts`.
 */
declare module "droidedtui/protocol" {
  export interface OscSubscriptionSource {
    subscribeOsc(handler: (sequence: string) => void): () => void;
  }

  export class DroidedHostClient {
    constructor(source: OscSubscriptionSource);
    request(op: string, params?: unknown): Promise<unknown>;
    subscribe(event: string, handler: (data: unknown) => void): () => void;
    close(): void;
  }
}
