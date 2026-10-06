import { goMemoryBytes } from "./libcudart";
import type { Metrics } from "./protocol";

// The env.pushMetrics import, and the one place a Go pointer arrives from inside a
// running simulation. It must be on the import object at instantiation and before
// go.run() begins: wasm resolves imports at instantiation, so a missing one is a
// hard failure there rather than a nil call later.
//
// Built here rather than inline at each supply site so a test can drive it.

export type MetricsStreamSink = {
  /**
   * The instance's memory, read per call rather than captured: growing Go's heap
   * detaches the previous ArrayBuffer.
   */
  memory: () => WebAssembly.Memory | null;
  onMetrics: (metrics: Metrics) => void;
  onUnreadable: (message: string) => void;
};

/**
 * Build the import callback.
 *
 * The pointer is sign-extended: //go:wasmimport lowers its parameters to i32 and
 * wasm sign-extends an i32 into JavaScript, so an address at or above 0x80000000
 * arrives negative and is rejected as an out-of-range index. The MI300X platform's
 * heap grows past 2 GiB and the R9 Nano's stays near 0.3 GB. goMemoryBytes coerces
 * the offset.
 *
 * A body that cannot be read is REPORTED and the run continues: the finished
 * telemetry body is authoritative, so failing a run over a dropped sample would
 * trade a real result for a cosmetic one.
 */
export function createMetricsStream(sink: MetricsStreamSink): (ptr: number, length: number) => void {
  const decoder = new TextDecoder();
  return (ptr, length) => {
    const memory = sink.memory();
    if (length <= 0 || !memory) return;
    try {
      sink.onMetrics(JSON.parse(decoder.decode(goMemoryBytes(memory, ptr, length))) as Metrics);
    } catch (error: unknown) {
      sink.onUnreadable(`metrics sample dropped: offset 0x${(ptr >>> 0).toString(16)} length ${length}: ${String(error)}`);
    }
  };
}