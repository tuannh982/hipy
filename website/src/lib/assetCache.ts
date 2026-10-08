import type { CompilerRuntime } from "./compilePipeline";

export type DownloadProgress = {
  loaded: number;
  total: number | null;
};

type Archive = {
  url: string;
  size: number;
  mount: string;
  fileCount?: number;
  uncompressedSize?: number;
};

type ToolchainAssets = {
  id: string;
  driver: string;
  driverSize: number;
  archives: Archive[];
};

// Version 3 is the per-toolchain shape. A cached body from another version has no
// meaning against this reader and is discarded.
type Manifest = {
  version: number;
  toolchains: ToolchainAssets[];
};

const CACHE_NAME = "hipy-toolchain-v3";

function toolchainUrls(): { driverUrls: Readonly<Record<string, string>>; archiveUrls: Readonly<Record<string, string>>; manifest: string } {
  if (typeof __HIPY_TOOLCHAIN_DRIVER_URLS__ !== "object" || typeof __HIPY_TOOLCHAIN_ARCHIVE_URLS__ !== "object" || typeof __HIPY_TOOLCHAIN_MANIFEST_URL__ !== "string") {
    throw new Error("toolchain URLs are build-time constants; call this through a Vite build");
  }
  return {
    driverUrls: __HIPY_TOOLCHAIN_DRIVER_URLS__,
    archiveUrls: __HIPY_TOOLCHAIN_ARCHIVE_URLS__,
    manifest: __HIPY_TOOLCHAIN_MANIFEST_URL__,
  };
}

// What one toolchain's assets add up to, resolved against the build-time URL
// constants before anything is fetched.
async function loadOne(
  entry: ToolchainAssets,
  cache: Cache,
  driverUrl: string,
  archiveUrls: Readonly<Record<string, string>>,
  onProgress: (progress: DownloadProgress) => void,
): Promise<{ driver: Uint8Array; files: Record<string, Uint8Array>; total: number }> {
        if (entry.driver !== driverUrl) throw new Error(`toolchain manifest driver mismatch for ${entry.id}`);
  const total = entry.driverSize + entry.archives.reduce((sum, archive) => sum + archive.size, 0);
  const driverResponse = await fetchWithCache(cache, entry.driver);
  const driver = await readResponse(driverResponse, entry.driverSize, (value) => onProgress({ loaded: value, total }));
  if (driver[0] !== 0x00 || driver[1] !== 0x61 || driver[2] !== 0x73 || driver[3] !== 0x6d) {
    throw new Error("toolchain driver is not decompressed WASM");
  }
  const files: Record<string, Uint8Array> = {};
  for (const archive of entry.archives) {
    if (archive.url !== archiveUrls[entry.id]) throw new Error(`toolchain manifest archive mismatch for ${entry.id}`);
    const response = await fetchWithCache(cache, archive.url);
    const compressed = await readResponse(response, archive.size, (value) => onProgress({ loaded: value, total }));
    const expanded = await expandToolchainArchive(compressed, archive.mount);
    if (archive.fileCount !== undefined && Object.keys(expanded).length !== archive.fileCount) {
      throw new Error(`toolchain archive file count mismatch: expected ${archive.fileCount}, got ${Object.keys(expanded).length}`);
    }
    for (const [path, bytes] of Object.entries(expanded)) files[path] = bytes;
  }
  return { driver, files, total };
}

export async function loadToolchainAssets(toolchainId: string, onProgress: (progress: DownloadProgress) => void): Promise<{ driver: Uint8Array; files: Record<string, Uint8Array> }> {
  const { driverUrls, archiveUrls, manifest: MANIFEST_URL } = toolchainUrls();
  const driverUrl = driverUrls[toolchainId];
  const archiveUrl = archiveUrls[toolchainId];
  if (driverUrl === undefined || archiveUrl === undefined) {
    throw new Error(`this build stages no toolchain named "${toolchainId}"`);
  }
  const cache = await caches.open(CACHE_NAME);
  const manifestResponse = await fetchWithCache(cache, MANIFEST_URL);
  const manifest = (await manifestResponse.json()) as Manifest;
  if (manifest.version !== 3 || !Array.isArray(manifest.toolchains)) throw new Error("unsupported toolchain manifest");
  const entry = manifest.toolchains.find((candidate) => candidate.id === toolchainId);
  if (entry === undefined) throw new Error(`the staged manifest has no toolchain named "${toolchainId}"`);
  // Progress is this toolchain's own total: the bar is for this download.
  const { driver, files } = await loadOne(entry, cache, driverUrl, archiveUrls, onProgress);
  return { driver, files };
}

export async function expandToolchainArchive(archive: Uint8Array, mountPath: string): Promise<Record<string, Uint8Array>> {
  const archiveBytes = new Uint8Array(archive.byteLength);
  archiveBytes.set(archive);
  const stream = new Blob([archiveBytes.buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = new ByteReader(stream.getReader());
  const files: Record<string, Uint8Array> = {};
  const decoder = new TextDecoder();
  let overridePath: string | undefined;
  while (true) {
    const header = await reader.read(512);
    if (isZeroBlock(header)) break;
    const name = decodeTarString(header.subarray(0, 100));
    const size = parseTarNumber(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0);
    const data = size > 0 ? await reader.read(Math.ceil(size / 512) * 512).then((bytes) => bytes.subarray(0, size)) : new Uint8Array();
    if (type === "x" || type === "g") {
      if (type === "x") overridePath = parsePaxPath(decoder.decode(data)) ?? overridePath;
      continue;
    }
    if (type === "L") {
      overridePath = decoder.decode(data).replace(/\0+$/, "");
      continue;
    }
    if (type === "5") {
      overridePath = undefined;
      continue;
    }
    const archivePath = normalizeArchivePath(overridePath ?? name);
    overridePath = undefined;
    if (type !== "0" && type !== "\0") throw new Error(`unsupported toolchain archive entry type: ${type}`);
    files[`${mountPath.replace(/\/+$/, "")}/${archivePath}`] = data;
  }
  return files;
}

class ByteReader {
  private pending: Uint8Array | undefined;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async read(length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (!this.pending) {
        const next = await this.reader.read();
        if (next.done) throw new Error("toolchain archive ended unexpectedly");
        this.pending = next.value;
      }
      const take = Math.min(length - offset, this.pending.byteLength);
      result.set(this.pending.subarray(0, take), offset);
      offset += take;
      this.pending = take === this.pending.byteLength ? undefined : this.pending.subarray(take);
    }
    return result;
  }
}

function isZeroBlock(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function decodeTarString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0.*$/, "").trim();
}

function parseTarNumber(bytes: Uint8Array): number {
  const value = decodeTarString(bytes).replace(/[^0-7]/g, "");
  return value ? parseInt(value, 8) : 0;
}

function parsePaxPath(data: string): string | undefined {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(" ", offset);
    if (space < 0) break;
    const length = Number.parseInt(data.slice(offset, space), 10);
    const record = data.slice(space + 1, offset + length).replace(/\n$/, "");
    if (record.startsWith("path=")) return record.slice(5);
    offset += length;
  }
  return undefined;
}

function normalizeArchivePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => part === "..")) throw new Error(`unsafe toolchain archive path: ${path}`);
  return normalized;
}

async function fetchWithCache(cache: Cache, url: string): Promise<Response> {
  const request = new Request(new URL(url, globalThis.location?.origin ?? "http://localhost"));
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (!response.ok) throw new Error(`toolchain asset request failed: ${url} (${response.status})`);
  await cache.put(request, response.clone());
  return response;
}

async function readResponse(response: Response, expected: number, onProgress: (loaded: number) => void): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded);
  }
  if (expected !== loaded) throw new Error(`toolchain asset size mismatch: expected ${expected}, got ${loaded}`);
  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function createBrowserCompilerRuntime(): CompilerRuntime {
  return createRuntime(async () => {
    const { Wasmer } = await import("@wasmer/sdk/browser");
    return new Wasmer({ cache: false });
  });
}

function createRuntime(createWasmer: () => Promise<import("@wasmer/sdk/browser").Wasmer>): CompilerRuntime {
  let wasmer: import("@wasmer/sdk/browser").Wasmer | undefined;
  let sandbox: import("@wasmer/sdk/browser").Sandbox | undefined;
  return {
    async createSandbox(driver, files) {
      wasmer = await createWasmer();
      await wasmer.ready();
      const pkg = await wasmer.packages.create({
        modules: { llvm: driver },
        commands: {
          clang: { module: "llvm" },
          "clang++": { module: "llvm" },
          "clang-offload-bundler": { module: "llvm" },
          "wasm-ld": { module: "llvm" },
        },
        entrypoint: "clang++",
      });
      sandbox = await wasmer.sandboxes.create({ packages: [pkg], files });
      return {
        command(name, args) {
          const command = sandbox?.command(name, args);
          if (!command) throw new Error("compiler sandbox is not ready");
          return {
            async run(options) {
              const output = await command.run(options);
              return { exitCode: output.exitCode, stdout: output.stdout.bytes, stderr: output.stderr.bytes };
            },
          };
        },
        fs: sandbox.fs,
      };
    },
    async close() {
      await sandbox?.close().catch(() => {});
      await wasmer?.close().catch(() => {});
      sandbox = undefined;
      wasmer = undefined;
    },
  };
}
