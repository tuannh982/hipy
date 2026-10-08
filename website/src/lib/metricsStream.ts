import { goMemoryBytes } from "./libcudart";
import type { Metrics } from "./protocol";

export type MetricsStreamSink = {
    memory: () => WebAssembly.Memory | null;
  onMetrics: (metrics: Metrics) => void;
  onUnreadable: (message: string) => void;
};

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
