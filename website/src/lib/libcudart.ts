const decoder = new TextDecoder();
const encoder = new TextEncoder();

type WasmFunction = (...args: (number | bigint)[]) => number | bigint | void;
type NumberWasmFunction = (...args: number[]) => number;
type GoExports = { [name: string]: WebAssembly.ExportValue; mem: WebAssembly.Memory };
type GoInstance = WebAssembly.Instance & { exports: GoExports };
type HostInstance = { exports: { memory: WebAssembly.Memory | null } };
type GoRuntime = {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<unknown>;
            exit: (code: number) => void;
};
type OutputCallback = (bytes: Uint8Array) => void;
type WasmImport = { moduleName: string; importName: string; kind?: number; signature?: string };
type CallConfiguration = { grid: [number, number, number]; block: [number, number, number]; sharedMemBytes: number; stream: number };
type KernelRegistration = {
  handle: number;
  hostStub: number;
  name: string;
  mangledName: string;
  image: Uint8Array;
  sharedMemBytes: number;
  metadata0: number;
  metadata1: number;
  metadata2: number;
  metadata3: number;
  metadata4: number;
};
type FatBinaryRegistration = {
  wrapperPtr: number;
  wrapper: Uint8Array;
  image: Uint8Array;
  registrations?: Map<number, KernelRegistration>;
};
type LaunchedKernel = { name: string; grid: [number, number, number]; block: [number, number, number]; sharedMemBytes: number; stream: number };
type LibcudartOptions = { go: GoRuntime; goInstance: GoInstance; hostInstance: HostInstance; onStdout: OutputCallback };
type Libcudart = {
  cudaMalloc: NumberWasmFunction;
  cudaFree: NumberWasmFunction;
  cudaMemcpy: NumberWasmFunction;
  cudaMemset: NumberWasmFunction;
  cudaGetLastError: NumberWasmFunction;
  cudaDeviceSynchronize: NumberWasmFunction;
  hipLaunchKernel: NumberWasmFunction;
  __hipPushCallConfiguration: NumberWasmFunction;
  __hipPopCallConfiguration: NumberWasmFunction;
  __hipRegisterFatBinary: NumberWasmFunction;
  __hipRegisterFunction: NumberWasmFunction;
  __hipUnregisterFatBinary: NumberWasmFunction;
  atexit: NumberWasmFunction;
  printf: NumberWasmFunction;
  getInternalError(): string | null;
  getLaunchedKernels(): LaunchedKernel[];
  getKernelRegistrations(): Array<{ hostStub: number; name: string; mangledName: string }>;
};

function view(memory: WebAssembly.Memory | null): Uint8Array {
  if (!memory) throw new Error("WASM memory is not initialized");
  return new Uint8Array(memory.buffer);
}

function pointerText(ptr: number): string {
  return `0x${(ptr >>> 0).toString(16)}`;
}

function validateHostRange(memory: Uint8Array, ptr: number, length: number, operation: string): void {
  if (ptr < 0 || length < 0 || ptr > memory.length || length > memory.length - ptr) {
    throw new Error(`${operation} at pointer ${pointerText(ptr)} with length ${length} exceeds ${memory.length} bytes`);
  }
}

const MAX_KERNEL_ARGS = 32;

function kernelArgSlots(memory: Uint8Array, argsPtr: number, kernel: string): number[] {
  const slots: number[] = [];
  let step = 0;
  for (let index = 0; ; index++) {
    if (index >= MAX_KERNEL_ARGS) {
      throw new Error(
        `kernel ${kernel}: ${MAX_KERNEL_ARGS} argument slots with no terminator; ` +
          "take a single pointer to a struct of arguments instead",
      );
    }
    const slot = readU32(memory, argsPtr + index * 4);
    if (slot === 0) break;
    if (slot > memory.length || slot + 4 > memory.length) {
      throw new Error(
        `kernel ${kernel}: argument slot ${index} is ${pointerText(slot)}, outside the ` +
          `${memory.length}-byte host memory, so the argument count could not be recovered`,
      );
    }
    if (index > 0) {
      const observed = (slot - slots[index - 1]) as number;
      if (index === 1) {
        step = observed;
      } else if (observed !== step) {
        break;
      }
    }
    slots.push(slot);
  }
  return slots;
}

function getWasmFunction(exports: { [name: string]: WebAssembly.ExportValue | null }, name: string): WasmFunction {
  const value = exports[name];
  if (typeof value !== "function") throw new Error(`WASM export ${name} is not a function`);
  return value as WasmFunction;
}

function getNumberWasmFunction(exports: { [name: string]: WebAssembly.ExportValue | null }, name: string): NumberWasmFunction {
  const fn = getWasmFunction(exports, name);
  return (...args) => {
    const result = fn(...args);
    if (typeof result !== "number") throw new Error(`WASM export ${name} did not return a number`);
    return result;
  };
}

function wasmFunction<Args extends (number | bigint)[], Result extends number | bigint | void>(implementation: (...args: Args) => Result): WasmFunction {
  return (...args) => implementation(...args as Args);
}

function hostBytes(hostInstance: HostInstance, ptr: number, length: number): Uint8Array {
  if (length === 0) return new Uint8Array(0);
  const memory = view(hostInstance.exports.memory);
  validateHostRange(memory, ptr, length, "host memory access");
  return memory.slice(ptr, ptr + length);
}

// A Go pointer is a byte offset into the module's 32-bit linear memory, so it is
// unsigned. `
function goPointer(ptr: number): number {
  return ptr >>> 0;
}

// Read a range of Go memory as a copy, coercing the offset. Exported so the
// import direction coerces in the same place.
export function goMemoryBytes(memory: WebAssembly.Memory, ptr: number, length: number): Uint8Array {
  if (length === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(memory.buffer);
  const start = goPointer(ptr);
  validateHostRange(bytes, start, length, "Go memory access");
  return bytes.slice(start, start + length);
}

function goBytes(goInstance: GoInstance, ptr: number, length: number): Uint8Array {
  return goMemoryBytes(goInstance.exports.mem, ptr, length);
}

function goCall(goInstance: GoInstance, name: string, ...args: number[]): number {
  return getNumberWasmFunction(goInstance.exports, name)(...args);
}

function goWrite(goInstance: GoInstance, bytes: Uint8Array): number {
  const ptr = goPointer(goCall(goInstance, "alloc", bytes.length));
  if (!ptr) throw new Error(`Go alloc failed for ${bytes.length} bytes`);
  view(goInstance.exports.mem).set(bytes, ptr);
  return ptr;
}

function goRead(goInstance: GoInstance, ptr: number, length: number): Uint8Array {
  return goBytes(goInstance, ptr, length);
}

function createGoHelpers(goInstance: GoInstance): {
  goCall: (name: string, ...args: number[]) => number;
  goWrite: (bytes: Uint8Array) => number;
  goRead: (ptr: number, length: number) => Uint8Array;
} {
  return {
    goCall: (name: string, ...args: number[]) => goCall(goInstance, name, ...args),
    goWrite: (bytes: Uint8Array) => goWrite(goInstance, bytes),
    goRead: (ptr: number, length: number) => goRead(goInstance, ptr, length),
  };
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readCString(hostInstance: HostInstance, ptr: number): string {
  const memory = view(hostInstance.exports.memory);
  validateHostRange(memory, ptr, 0, "host string read");
  let end = ptr;
  while (end < memory.length && memory[end] !== 0) end++;
  return decoder.decode(memory.subarray(ptr, end));
}

function writeRecord(hostInstance: HostInstance, ptr: number, values: readonly number[]): void {
  const memory = view(hostInstance.exports.memory);
  for (let i = 0; i < values.length; i++) writeU32(memory, ptr + i * 4, values[i]);
}

function readRecord(hostInstance: HostInstance, ptr: number): [number, number, number] {
  const memory = view(hostInstance.exports.memory);
  return [readU32(memory, ptr), readU32(memory, ptr + 4), readU32(memory, ptr + 8)];
}

const hostImportSignatures: Record<string, string> = {
  cudaMalloc: "(param i32 i32) (result i32)",
  cudaFree: "(param i32) (result i32)",
  cudaMemcpy: "(param i32 i32 i32 i32) (result i32)",
  cudaMemset: "(param i32 i32 i32) (result i32)",
  cudaGetLastError: "(result i32)",
  cudaDeviceSynchronize: "(result i32)",
  hipLaunchKernel: "(param i32 i32 i32 i32 i32 i32) (result i32)",
  __hipPushCallConfiguration: "(param i32 i32 i32 i32) (result i32)",
  __hipPopCallConfiguration: "(param i32 i32 i32 i32) (result i32)",
  __hipRegisterFatBinary: "(param i32) (result i32)",
  __hipRegisterFunction: "(param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)",
  __hipUnregisterFatBinary: "(param i32)",
  atexit: "(param i32) (result i32)",
  printf: "(param i32 i32) (result i32)",
};

function readLeb(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
  }
  throw new Error("truncated WebAssembly LEB128 value");
}

function readWasmString(bytes: Uint8Array, offset: number): [string, number] {
  let length: number;
  [length, offset] = readLeb(bytes, offset);
  const end = offset + length;
  if (end > bytes.length) throw new Error("truncated WebAssembly string");
  return [decoder.decode(bytes.subarray(offset, end)), end];
}

function parseWasmFunctionImports(wasmBytes: ArrayBuffer | ArrayBufferView): WasmImport[] {
  const bytes = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes instanceof ArrayBuffer ? wasmBytes : wasmBytes.buffer, wasmBytes instanceof ArrayBuffer ? 0 : wasmBytes.byteOffset, wasmBytes instanceof ArrayBuffer ? wasmBytes.byteLength : wasmBytes.byteLength);
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("invalid WebAssembly module");
  }
  const types: string[] = [];
  const imports: WasmImport[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const section = bytes[offset++];
    let size: number;
    [size, offset] = readLeb(bytes, offset);
    const end = offset + size;
    if (end > bytes.length) throw new Error("truncated WebAssembly section");
    if (section === 1) {
      let count: number;
      [count, offset] = readLeb(bytes, offset);
      for (let index = 0; index < count; index++) {
        const form = bytes[offset++];
        if (form !== 0x60) throw new Error("unsupported WebAssembly type form");
        let paramCount: number;
        [paramCount, offset] = readLeb(bytes, offset);
        const params: number[] = [];
        for (let param = 0; param < paramCount; param++) params.push(bytes[offset++]);
        let resultCount: number;
        [resultCount, offset] = readLeb(bytes, offset);
        const results: number[] = [];
        for (let result = 0; result < resultCount; result++) results.push(bytes[offset++]);
        types.push(formatWasmType(params, results));
      }
    } else if (section === 2) {
      let count: number;
      [count, offset] = readLeb(bytes, offset);
      for (let index = 0; index < count; index++) {
        let moduleName: string;
        let importName: string;
        [moduleName, offset] = readWasmString(bytes, offset);
        [importName, offset] = readWasmString(bytes, offset);
        const kind = bytes[offset++];
        if (kind !== 0) {
          imports.push({ moduleName, importName, kind });
          continue;
        }
        let typeIndex: number;
        [typeIndex, offset] = readLeb(bytes, offset);
        imports.push({ moduleName, importName, signature: types[typeIndex] });
      }
    }
    offset = end;
  }
  return imports;
}

function validateHostImports(wasmBytes: ArrayBuffer | ArrayBufferView): WasmImport[] {
  const actual = parseWasmFunctionImports(wasmBytes);
  const functionImports = actual.filter((item) => item.kind === undefined);
  const unknown = actual.filter((item) => item.kind !== undefined || (item.moduleName !== "env" && item.moduleName !== "wasi_snapshot_preview1") || (item.moduleName === "env" && !hostImportSignatures[item.importName]));
  if (unknown.length > 0) {
    throw new Error(`unsupported host imports: ${unknown.map((item) => `${item.moduleName}.${item.importName}`).join(", ")}`);
  }
  for (const item of functionImports) {
    if (item.moduleName !== "env") continue;
    const expectedSignature = hostImportSignatures[item.importName];
    if (item.signature !== expectedSignature) {
      throw new Error(`host import ${item.moduleName}.${item.importName} signature ${item.signature}, expected ${expectedSignature}`);
    }
  }
  return functionImports;
}

function formatWasmType(params: readonly number[], results: readonly number[]): string {
  const typeNames = new Map<number, string>([[0x7f, "i32"], [0x7e, "i64"], [0x7d, "f32"], [0x7c, "f64"]]);
  const names = (values: readonly number[]) => values.map((value) => typeNames.get(value) ?? `0x${value.toString(16)}`);
  const prefix = params.length > 0 ? `(param ${names(params).join(" ")}) ` : "";
  const resultNames = names(results);
  const suffix = resultNames.length === 1 ? `(result ${resultNames[0]})` : resultNames.length > 1 ? `(result ${resultNames.join(" ")})` : "";
  return `${prefix}${suffix}`.trim();
}

const FAT_BINARY_IMAGE_MAX_BYTES = 1024 * 1024;
const OFFLOAD_BINARY_HEADER_SIZE = 32;
const OFFLOAD_BINARY_ENTRY_SIZE = 40;

function readU64(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

function validateTable(available: number, offset: number, entrySize: number, count: number, minimumEntrySize: number, name: string): number {
  if (count === 0 && offset === 0) return 0;
  if (entrySize < minimumEntrySize || offset < 0 || offset > available || count < 0 || entrySize !== 0 && count > Math.floor((available - offset) / entrySize)) {
    throw new Error(`ELF ${name} table extent is invalid`);
  }
  return offset + entrySize * count;
}

function elfImageExtent(bytes: Uint8Array): number | null {
  try {
    if (!bytes || bytes.length < 5 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return null;
    const elfClass = bytes[4];
    if (elfClass !== 1 && elfClass !== 2) return null;
    const is64 = elfClass === 2;
    const headerSize = is64 ? 64 : 52;
    if (bytes.length < headerSize) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const littleEndian = bytes[5] === 1;
    if (bytes[5] !== 1 && bytes[5] !== 2) return null;
    const read16 = (offset: number) => view.getUint16(offset, littleEndian);
    const read32 = (offset: number) => view.getUint32(offset, littleEndian);
    const read64 = (offset: number) => view.getBigUint64(offset, littleEndian);
    const readOffset = (offset: number) => {
      const value = is64 ? read64(offset) : BigInt(read32(offset));
      return value <= BigInt(bytes.length) ? Number(value) : null;
    };
    const programOffset = readOffset(is64 ? 32 : 28);
    const sectionOffset = readOffset(is64 ? 40 : 32);
    if (programOffset === null || sectionOffset === null) return null;
    const programEntrySize = read16(is64 ? 54 : 42);
    const programCount = read16(is64 ? 56 : 44);
    const sectionEntrySize = read16(is64 ? 58 : 46);
    const sectionCount = read16(is64 ? 60 : 48);
    if (programCount === 0xffff || sectionCount === 0xffff) return null;
    const programTableEnd = validateTable(bytes.length, programOffset, programEntrySize, programCount, is64 ? 56 : 32, "program header");
    let programDataEnd = headerSize;
    for (let index = 0; index < programCount; index++) {
      const program = programOffset + index * programEntrySize;
      const fileOffset = is64 ? read64(program + 8) : BigInt(read32(program + 4));
      const fileSize = is64 ? read64(program + 32) : BigInt(read32(program + 16));
      const end = fileOffset + fileSize;
      if (end > BigInt(bytes.length)) return null;
      programDataEnd = Math.max(programDataEnd, Number(end));
    }
    if (sectionCount === 0) return Math.max(headerSize, programTableEnd, programDataEnd);
    const sectionTableEnd = validateTable(bytes.length, sectionOffset, sectionEntrySize, sectionCount, is64 ? 64 : 40, "section header");
    return Math.max(headerSize, programTableEnd, sectionTableEnd);
  } catch {
    return null;
  }
}

function fatBinaryImageLength(memory: Uint8Array, ptr: number): number {
  if (ptr <= 0 || ptr >= memory.length) throw new Error("fat-binary image pointer is outside host memory");
  const available = memory.length - ptr;
  const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
  const hasMagic = (magic: readonly number[]) => magic.every((value, index) => memory[ptr + index] === value);
  const isElf = hasMagic([0x7f, 0x45, 0x4c, 0x46]);

  if (isElf) {
    const length = elfImageExtent(memory.subarray(ptr));
    if (length === null) throw new Error("fat-binary ELF image extent is invalid");
    if (length > FAT_BINARY_IMAGE_MAX_BYTES) throw new Error(`fat-binary image length ${length} is outside the ${FAT_BINARY_IMAGE_MAX_BYTES}-byte cap`);
    return length;
  }

  if (!hasMagic([0x10, 0xff, 0x10, 0xad])) {
    throw new Error(`unable to determine fat-binary image extent for non-ELF data at ${ptr}`);
  }
  if (available < OFFLOAD_BINARY_HEADER_SIZE) throw new Error("HIP fat-binary header is truncated");
  const version = view.getUint32(ptr + 4, true);
  if (version !== 1) throw new Error(`unsupported HIP fat-binary version ${version}`);
  const size = readU64(view, ptr + 8);
  const entryOffset = readU64(view, ptr + 16);
  const entrySize = readU64(view, ptr + 24);
  if (size > BigInt(FAT_BINARY_IMAGE_MAX_BYTES)) throw new Error(`fat-binary image length ${size} is outside the ${FAT_BINARY_IMAGE_MAX_BYTES}-byte cap`);
  const imageSize = Number(size);
  if (imageSize < OFFLOAD_BINARY_HEADER_SIZE || entryOffset < BigInt(OFFLOAD_BINARY_HEADER_SIZE) || entrySize < BigInt(OFFLOAD_BINARY_ENTRY_SIZE) || entryOffset + entrySize > size) {
    throw new Error("HIP fat-binary entry extent is invalid");
  }
  const entry = Number(entryOffset);
  const imageOffset = readU64(view, ptr + entry + 24);
  const imageBytes = readU64(view, ptr + entry + 32);
  if (imageOffset > size || imageBytes > size - imageOffset) throw new Error("HIP fat-binary image extent is invalid");
  if (imageSize > available) throw new Error("fat-binary image extends past host memory");
  return imageSize;
}

function formatPrintf(hostInstance: HostInstance, formatPtr: number, varargsPtr: number, onStdout: OutputCallback): number {
  const format = readCString(hostInstance, formatPtr);
  const memory = view(hostInstance.exports.memory);
  let output = "";
  let argPtr = varargsPtr;
  for (let index = 0; index < format.length; index++) {
    if (format[index] !== "%") {
      output += format[index];
      continue;
    }
    index++;
    if (format[index] === "%") {
      output += "%";
      continue;
    }
    // Width and precision are read past, not applied, so "%.1f" prints toFixed(6); deferred, because nothing shipped uses them and a half-done width implementation is its own source of wrong numbers.
    while (index < format.length && "0123456789.-+ #l".includes(format[index])) index++;
    const conversion = format[index];
    if (conversion === "f" || conversion === "F" || conversion === "e" || conversion === "E" || conversion === "g" || conversion === "G") {
                                                      argPtr = (argPtr + 7) & ~7;
      const value = new DataView(memory.buffer, memory.byteOffset, memory.byteLength).getFloat64(argPtr, true);
      argPtr += 8;
      output += conversion === "f" || conversion === "F" ? value.toFixed(6) : String(value);
    } else if (conversion === "d" || conversion === "i" || conversion === "u" || conversion === "x" || conversion === "X" || conversion === "o" || conversion === "c") {
      const value = readU32(memory, argPtr);
      argPtr += 4;
      if (conversion === "c") output += String.fromCharCode(value);
      else if (conversion === "x") output += value.toString(16);
      else if (conversion === "X") output += value.toString(16).toUpperCase();
      else if (conversion === "o") output += value.toString(8);
      else if (conversion === "u") output += String(value);
      // d and i are signed; u, x, X and o are not.
      else output += String(value | 0);
    } else if (conversion === "s") {
      const value = readU32(memory, argPtr);
      argPtr += 4;
      output += readCString(hostInstance, value);
    } else if (conversion === "p") {
      argPtr += 4;
      output += "0x0";
    }
  }
  const bytes = encoder.encode(output);
  if (bytes.length > 0) onStdout(bytes);
  return bytes.length;
}

function createLibcudart({ go, goInstance, hostInstance, onStdout }: LibcudartOptions): Libcudart {
  const fatBinaries = new Map<number, FatBinaryRegistration>();
  const registrations = new Map<number, KernelRegistration>();
  const launchedKernels: LaunchedKernel[] = [];
  const devicePointers = new Set<number>();
  let nextHandle = 0x10000000;
  let lastError = 0;
  let internalError: string | null = null;
  let configuration: CallConfiguration | null = null;
  let atexitCallback = 0;

  const call = (name: string, ...args: number[]): number => goCall(goInstance, name, ...args);
  const resultError = (name: string): string => {
    const length = call("resultLen");
    return length > 0 ? decoder.decode(goRead(goInstance, call("resultPtr"), length)) : `Go export failed: ${name}`;
  };
  const recordInternalError = (error: unknown, fallback: string): void => {
    if (internalError === null) {
      const message = error instanceof Error ? error.message : String(error || fallback);
      internalError = fallback.includes("pointer") && !message.includes("pointer 0x") ? `${fallback}: ${message}` : message || fallback;
    }
    lastError = lastError || 1;
  };
  const checked = (name: string, ...args: number[]): number => {
    const status = call(name, ...args);
    if (status !== 0) {
      const message = resultError(name);
      recordInternalError(message, `${name} failed`);
      throw new Error(message);
    }
    return status;
  };

  const libcudart: Libcudart = {
    cudaMalloc: (ptrToSize, size) => {
      try {
        // malloc returns pointer data; mallocStatus is its independent status channel.
        const devicePtr = call("malloc", size);
        const mallocStatus = call("mallocStatus");
        if (mallocStatus !== 0) {
          const message = resultError("malloc");
          recordInternalError(message, `cudaMalloc failed at output pointer ${pointerText(ptrToSize)}`);
          return lastError || mallocStatus;
        }
        devicePointers.add(devicePtr >>> 0);
        writeU32(view(hostInstance.exports.memory), ptrToSize, devicePtr);
        return 0;
      } catch (error) {
        recordInternalError(error, `cudaMalloc failed at output pointer ${pointerText(ptrToSize)}`);
        return lastError || 1;
      }
    },
    cudaFree: (ptr) => {
      try {
        return checked("free", ptr);
      } catch (error) {
        recordInternalError(error, `cudaFree failed at pointer ${pointerText(ptr)}`);
        return lastError || 1;
      }
    },
    cudaMemcpy: (dst, src, count, kind) => {
      try {
        if (count < 0) throw new Error(`cudaMemcpy at destination pointer ${pointerText(dst)} and source pointer ${pointerText(src)} has negative length ${count}`);
        if (kind === 1) {
          const bytes = hostBytes(hostInstance, src, count);
          let goPtr: number;
          try {
            goPtr = goWrite(goInstance, bytes);
          } catch (error) {
            throw new Error(`cudaMemcpy to pointer ${pointerText(dst)} from host pointer ${pointerText(src)}: ${error instanceof Error ? error.message : String(error)}`);
          }
          return checked("memcpyH2D", dst, goPtr, count);
        }
        if (kind === 2) {
          const dstGo = goWrite(goInstance, new Uint8Array(count));
          const status = checked("memcpyD2H", src, dstGo, count);
          const hostMemory = view(hostInstance.exports.memory);
          validateHostRange(hostMemory, dst, count, "cudaMemcpy destination access");
          if (status === 0) hostMemory.set(goRead(goInstance, dstGo, count), dst);
          return status;
        }
        if (kind === 0) {
          const hostMemory = view(hostInstance.exports.memory);
          validateHostRange(hostMemory, dst, count, "cudaMemcpy destination access");
          hostMemory.set(hostBytes(hostInstance, src, count), dst);
          return 0;
        }
        throw new Error(`unsupported cudaMemcpy kind ${kind} at destination pointer ${pointerText(dst)} and source pointer ${pointerText(src)}`);
      } catch (error) {
        recordInternalError(error, `cudaMemcpy failed at destination pointer ${pointerText(dst)} and source pointer ${pointerText(src)}`);
        return lastError || 1;
      }
    },
    cudaMemset: (dst, value, count) => {
      try {
        if (count < 0) throw new Error(`cudaMemset at pointer ${pointerText(dst)} has negative length ${count}`);
        const bytes = new Uint8Array(count);
        bytes.fill(value & 0xff);
        let goPtr: number;
        try {
          goPtr = goWrite(goInstance, bytes);
        } catch (error) {
          throw new Error(`cudaMemset at pointer ${pointerText(dst)}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return checked("memcpyH2D", dst, goPtr, count);
      } catch (error) {
        recordInternalError(error, `cudaMemset failed at pointer ${pointerText(dst)}`);
        return lastError || 1;
      }
    },
    cudaGetLastError: () => {
      const error = lastError;
      lastError = 0;
      return error;
    },
    cudaDeviceSynchronize: () => {
      try {
        const status = call("drain");
        if (status !== 0) {
          lastError = status;
          internalError = internalError || resultError("drain");
        }
        return status !== 0 || internalError !== null ? lastError || 1 : 0;
      } catch (error) {
        recordInternalError(error, "cudaDeviceSynchronize failed");
        return 1;
      }
    },
    hipLaunchKernel: (hostStub, gridPtr, blockPtr, argsPtr, sharedMemBytes, stream) => {
      try {
        const registration = registrations.get(hostStub);
        if (!registration) throw new Error(`unknown host stub ${hostStub}`);
                                const grid = readRecord(hostInstance, gridPtr);
        const block = readRecord(hostInstance, blockPtr);
        const hostMemory = view(hostInstance.exports.memory);
        const argParts: Uint8Array[] = [];
        let argLength = 0;
        for (const argPtr of kernelArgSlots(hostMemory, argsPtr, registration.name)) {
          const value = readU32(hostMemory, argPtr);
          let part: Uint8Array;
          if (devicePointers.has(value >>> 0)) {
            part = new Uint8Array(8);
            new DataView(part.buffer).setBigUint64(0, BigInt(value), true);
          } else {
            part = hostMemory.slice(argPtr, argPtr + 4);
          }
          const padding = (part.length - (argLength % part.length)) % part.length;
          if (padding > 0) argParts.push(new Uint8Array(padding));
          argParts.push(part);
          argLength += padding + part.length;
        }
        const argBytes = new Uint8Array(argLength);
        let argOffset = 0;
        for (const part of argParts) {
          argBytes.set(part, argOffset);
          argOffset += part.length;
        }
        const namePtr = goWrite(goInstance, encoder.encode(registration.name));
        checked("setKernelArgs", goWrite(goInstance, argBytes), argBytes.length);
        const status = checked("launchKernel", namePtr, registration.name.length, grid[0] * block[0], grid[1] * block[1], grid[2] * block[2], block[0], block[1], block[2], sharedMemBytes);
        launchedKernels.push({ name: registration.name, grid, block, sharedMemBytes, stream });
        return status;
      } catch (error) {
        recordInternalError(error, "hipLaunchKernel failed");
        return 1;
      }
    },
    __hipPushCallConfiguration: (gridPtr, blockPtr, sharedMemBytes, stream) => {
      try {
        // Recorded, not overridden: the geometry belongs in the source.
        const record = {
          grid: readRecord(hostInstance, gridPtr),
          block: readRecord(hostInstance, blockPtr),
          sharedMemBytes,
          stream,
        };
        configuration = record;
        return 0;
      } catch {
        return 1;
      }
    },
    __hipPopCallConfiguration: (gridPtr, blockPtr, sharedMemPtr, streamPtr) => {
      try {
        const record = configuration;
        if (!record) return 1;
        writeRecord(hostInstance, gridPtr, record.grid);
        writeRecord(hostInstance, blockPtr, record.block);
        writeU32(view(hostInstance.exports.memory), sharedMemPtr, record.sharedMemBytes);
        writeU32(view(hostInstance.exports.memory), streamPtr, record.stream);
        configuration = null;
        return 0;
      } catch {
        return 1;
      }
    },
    __hipRegisterFatBinary: (wrapperPtr) => {
      try {
        const wrapper = hostBytes(hostInstance, wrapperPtr, 16);
        if (wrapper.length !== 16) throw new Error(`fat-binary wrapper at ${wrapperPtr} is truncated`);
        const dataPtr = readU32(wrapper, 8);
        const image = dataPtr === 0 ? new Uint8Array(0) : hostBytes(hostInstance, dataPtr, fatBinaryImageLength(view(hostInstance.exports.memory), dataPtr));
        const handle = nextHandle++;
        fatBinaries.set(handle, { wrapperPtr, wrapper, image });
        return handle;
      } catch (error) {
        recordInternalError(error, "fat-binary registration failed");
        return 1;
      }
    },
    __hipRegisterFunction: (handle, hostStub, namePtr, mangledNamePtr, offset, metadata0, metadata1, metadata2, metadata3, metadata4) => {
      const name = readCString(hostInstance, namePtr);
      const mangledName = readCString(hostInstance, mangledNamePtr);
      const fatbin = fatBinaries.get(handle);
      if (!fatbin) return 1;
      fatbin.registrations = fatbin.registrations || new Map();
      const registration = { handle, hostStub, name, mangledName, image: fatbin.image, sharedMemBytes: 0, metadata0, metadata1, metadata2, metadata3, metadata4 };
      registrations.set(hostStub, registration);
      fatbin.registrations.set(hostStub, registration);
      return 0;
    },
    __hipUnregisterFatBinary: (handle) => {
      const fatbin = fatBinaries.get(handle);
      if (fatbin?.registrations) for (const hostStub of fatbin.registrations.keys()) registrations.delete(hostStub);
      fatBinaries.delete(handle);
      return 0;
    },
    atexit: (callback) => {
      atexitCallback = callback;
      return 0;
    },
    getInternalError: () => internalError,
    getLaunchedKernels: () => launchedKernels.map(({ name, grid, block, sharedMemBytes, stream }) => ({ name, grid, block, sharedMemBytes, stream })),
    getKernelRegistrations: () => Array.from(registrations.values(), ({ hostStub, name, mangledName }) => ({ hostStub, name, mangledName })),
    printf: (formatPtr, varargsPtr) => formatPrintf(hostInstance, formatPtr, varargsPtr, onStdout),
  };

  return libcudart;
}

function createWasiImports(hostInstance: HostInstance, onStdout: OutputCallback): Record<string, WasmFunction> {
  const memory = (): Uint8Array => view(hostInstance.exports.memory);
  const fdWrite = wasmFunction((fd: number, iovs: number, iovsLen: number, nwrittenPtr: number): number => {
    const bytes = memory();
    let total = 0;
    for (let index = 0; index < iovsLen; index++) {
      const ptr = readU32(bytes, iovs + index * 8);
      const length = readU32(bytes, iovs + index * 8 + 4);
      const output = bytes.slice(ptr, ptr + length);
      total += output.length;
      if ((fd === 1 || fd === 2) && output.length > 0) onStdout(output);
    }
    writeU32(bytes, nwrittenPtr, total);
    return 0;
  });
  const names: Record<string, WasmFunction> = {
    args_get: wasmFunction(() => 0),
    args_sizes_get: wasmFunction((argcPtr: number, argvSizePtr: number) => {
      writeU32(memory(), argcPtr, 0);
      writeU32(memory(), argvSizePtr, 0);
      return 0;
    }),
    environ_get: wasmFunction(() => 0),
    environ_sizes_get: wasmFunction((countPtr: number, sizePtr: number) => {
      writeU32(memory(), countPtr, 0);
      writeU32(memory(), sizePtr, 0);
      return 0;
    }),
    clock_res_get: wasmFunction((_clockId: number, ptr: number) => {
      writeU64(memory(), ptr, 1n);
      return 0;
    }),
    clock_time_get: wasmFunction((_clockId: number, _precision: bigint, ptr: number) => {
      writeU64(memory(), ptr, 0n);
      return 0;
    }),
    fd_close: wasmFunction(() => 0),
    fd_fdstat_get: wasmFunction((_fd: number, ptr: number) => {
      const bytes = memory();
      bytes.fill(0, ptr, ptr + 24);
      return 0;
    }),
    fd_read: wasmFunction(() => 0),
    fd_seek: wasmFunction((_fd: number, _offset: bigint, _whence: number, ptr: number) => {
      writeU64(memory(), ptr, 0n);
      return 0;
    }),
    fd_write: fdWrite,
    path_open: wasmFunction(() => 44),
    poll_oneoff: wasmFunction(() => 0),
    proc_exit: wasmFunction((code: number) => {
      if (code !== 0) throw new Error(`host process exited with ${code}`);
      return 0;
    }),
    random_get: wasmFunction((ptr: number, length: number) => {
      memory().fill(0, ptr, ptr + length);
      return 0;
    }),
    sched_yield: wasmFunction(() => 0),
  };
  return names;
}

function writeU64(bytes: Uint8Array, ptr: number, value: bigint): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(ptr, value, true);
}

async function instantiateHostModule(wasmBytes: BufferSource, libcudart: Libcudart, hostInstance: HostInstance, onStdout: OutputCallback): Promise<WebAssembly.Instance> {
  const hostModule = await WebAssembly.compile(wasmBytes);
  validateHostImports(wasmBytes);
  const wasi = createWasiImports(hostInstance, onStdout);
  const imports: WebAssembly.Imports = { env: libcudart };
  for (const required of WebAssembly.Module.imports(hostModule)) {
    if (required.module === "env") continue;
    if (required.module === "wasi_snapshot_preview1") {
      imports[required.module] = wasi;
      continue;
    }
    throw new Error(`unsupported host import ${required.module}.${required.name}`);
  }
  const instance = await WebAssembly.instantiate(hostModule, imports);
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("host module does not export WASM memory");
  hostInstance.exports.memory = memory;
  return instance;
}

export { createGoHelpers, createLibcudart, createWasiImports, elfImageExtent, getNumberWasmFunction, getWasmFunction, goCall, goPointer, goWrite, goRead, instantiateHostModule, validateHostImports };
export type { GoInstance, GoRuntime, HostInstance, Libcudart, WasmFunction };
