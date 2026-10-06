import { loadToolchainAssets, createBrowserCompilerRuntime } from "../lib/assetCache";
import { compilePipeline } from "../lib/compilePipeline";
import type { CompileRequest, CompileResponse } from "../lib/protocol";

const worker = self as unknown as {
  postMessage: (message: CompileResponse, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

function post(message: CompileResponse, transfer?: Transferable[]): void {
  worker.postMessage(message, transfer);
}

worker.onmessage = (event) => {
  const request = event.data as CompileRequest;
  if (request.type !== "compile") {
    post({ type: "error", message: "unsupported worker request" });
    return;
  }
  run(request).catch((error) => post({ type: "error", message: String(error) }));
};

async function run(request: CompileRequest): Promise<void> {
  // One toolchain's driver and archive, the one this request named. The
  // manifest is the only shared fetch; every other toolchain's driver stays unfetched.
  const assets = await loadToolchainAssets(request.toolchainId, ({ loaded, total }) => post({ type: "download-progress", loaded, total }));
  const result = await compilePipeline({
    source: request.source,
    assets,
    runtime: createBrowserCompilerRuntime(),
    toolchainId: request.toolchainId,
    arch: request.arch,
    device: request.device,
    onEvent: (event) => post(event),
  });
  post({ type: "result", ...result }, [result.deviceCodeObject, result.hostWasm]);
}
