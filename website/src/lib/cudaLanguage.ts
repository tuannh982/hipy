
export const CUDA_KEYWORDS = [
  // Address space and execution space qualifiers.
  "__global__", "__device__", "__host__", "__shared__", "__constant__", "__managed__",
  "__restrict__", "__launch_bounds__", "__forceinline__", "__noinline__", "__align__",
  "__declspec",
  // Synchronization and warp intrinsics.
  "__syncthreads", "__syncthreads_count", "__syncthreads_and", "__syncthreads_or",
  "__threadfence", "__threadfence_block", "__syncwarp", "__nanosleep",
  // Thread hierarchy.
  "threadIdx", "blockIdx", "blockDim", "gridDim", "warpSize", "warpIdx", "laneIdx",
        "__fadd_rn", "__fmul_rn", "__fsub_rn", "__fdiv_rn", "__fmaf_rn",
  "atomicAdd", "atomicSub", "atomicMin", "atomicMax", "atomicExch", "atomicCAS",
  "atomicInc", "atomicDec", "atomicAnd", "atomicOr", "atomicXor",
  "atomicAdd_system", "atomicCAS_system",
  "__ldg", "__stwb", "__stcg", "__stcs", "__stwt",
  "__shfl_sync", "__shfl_up_sync", "__shfl_down_sync", "__shfl_xor_sync",
  "__ballot_sync", "__all_sync", "__any_sync", "__popc", "__clz", "__ffs", "__brev",
  "fabsf", "fmaf", "fmaxf", "fminf", "floorf", "ceilf", "roundf", "truncf",
  "sqrtf", "rsqrtf", "expf", "exp2f", "logf", "log2f", "log10f", "powf",
  "sinf", "cosf", "tanf", "atanf", "atan2f", "asinf", "acosf", "sincosf",
  "fmodf", "fmaf_rn", "ldexpf", "frexpf", "modff", "min", "max", "abs",
  "isfinite", "isinf", "isnan", "signbit", "__int_as_float", "__float_as_int",
  "make_float2", "make_float4", "make_int2", "make_int4", "make_uint2",
  "clock", "clock64", "memcpy", "memset",
] as const;

export const CUDA_TYPES = [
  "void", "bool", "char", "short", "int", "long", "longlong", "unsigned",
  "signed", "float", "double", "size_t", "ptrdiff_t",
  "int8_t", "int16_t", "int32_t", "int64_t",
  "uint8_t", "uint16_t", "uint32_t", "uint64_t",
  "float2", "float4", "double2", "int2", "int4", "uint2", "uint4",
  "dim3", "cudaError_t", "cudaStream_t", "cudaMemcpyKind",
] as const;

export const CUDA_RUNTIME = [
  "cudaMalloc", "cudaMallocHost", "cudaMallocManaged", "cudaFree", "cudaHostAlloc",
  "cudaMemcpy", "cudaMemcpyAsync", "cudaMemset", "cudaMemsetAsync",
  "cudaMemGetInfo", "cudaDeviceSynchronize", "cudaStreamSynchronize",
  "cudaGetLastError", "cudaPeekAtLastError", "cudaGetErrorString", "cudaGetErrorName",
  "cudaLaunchKernel",
] as const;

export const CUDA_RUNTIME_IMPLEMENTED = [
  "cudaMalloc", "cudaFree", "cudaMemcpy", "cudaMemset",
  "cudaGetLastError", "cudaDeviceSynchronize",
] as const;

export const CUDA_MEMCPY_KINDS = [
  "cudaMemcpyHostToHost", "cudaMemcpyHostToDevice", "cudaMemcpyDeviceToHost",
  "cudaMemcpyDeviceToDevice", "cudaMemcpyDefault",
] as const;

export const CUDA_ERROR_CODES = [
  "cudaErrorInvalidValue", "cudaErrorMemoryAllocation", "cudaErrorLaunchFailure",
] as const;

export const CUDA_RUNTIME_DECLARED_ONLY = ["cudaLaunchKernel"] as const;

export function isCudaRuntimeImplemented(name: string): boolean {
  return (CUDA_RUNTIME_IMPLEMENTED as readonly string[]).includes(name);
}

export function isCudaRuntimeUnimplemented(name: string): boolean {
  if (!(CUDA_RUNTIME as readonly string[]).includes(name)) return false;
  return !isCudaRuntimeImplemented(name) && !isCudaRuntimeDeclaredOnly(name);
}

export function isCudaRuntimeDeclaredOnly(name: string): boolean {
  return (CUDA_RUNTIME_DECLARED_ONLY as readonly string[]).includes(name);
}

export const CUDA_BOUNDARIES = [
  "printf", "malloc", "free", "exit", "sqrt", "pow", "exp", "log", "sin", "cos",
] as const;

export const CUDA_DOCS: Readonly<Record<string, string>> = {
  __syncthreads: "Waits until every thread in the block has reached it. All __shared__ writes before it are visible after it.",
  __syncthreads_count: "Waits until `count` threads of the block have arrived, then releases them together.",
  __syncwarp: "Waits until every active thread of the warp has reached it, with a given mask.",
  __threadfence: "Orders this thread's memory writes so other threads observe them. Does not synchronise execution.",
  __shfl_sync: "Reads a value from a lane of the same warp. Register, not memory: the cheapest way to move data.",
  __shfl_down_sync: "Reads the lane `delta` below this one, wrapping at lane 31.",
  __ballot_sync: "Returns a 32-bit mask of which lanes in the mask are active.",
  __popc: "Number of set bits -- population count.",
  __ldg: "Read-only load through the texture path, which may use the read-only cache.",
  atomicAdd: "Adds to a location in global memory atomically, returning the OLD value. The usual bank-conflict-free accumulation.",
  atomicCAS: "Compare-and-swap. Returns `old` on success, so the idiom is a compare-and-retry loop.",
  atomicMax: "Atomically stores the larger of the current value and `val`, returning the old value.",
  warpSize: "32 on every AMD part and on NVIDIA. Included because it reads as portable and is not the thing to reason about.",
  threadIdx: "This thread's index inside its block: `.x` varies fastest across lanes.",
  blockIdx: "This block's index in the grid.",
  blockDim: "The block's shape in threads. With a 1-D launch it is `.x` threads wide.",
  gridDim: "The grid's shape in blocks. One wave per 64 threads of a 1-D block.",
  cudaMalloc: "Allocates device memory and returns a device pointer the host must not dereference.",
  cudaFree: "Releases a cudaMalloc allocation. Passing anything else is undefined, and the shim checks the pointer against what it handed out.",
  cudaMemcpy: "Copies between host and device. Synchronous: the host blocks until it's done. The direction is the `kind` argument -- a cudaMemcpyKind enumerator.",
  cudaMemset: "Fills device memory with a repeated byte value. Byte-granular, so it cannot set a float to anything but a repeated 8-bit pattern.",
  cudaDeviceSynchronize: "Blocks until every previously issued device work has completed.",
  cudaGetLastError: "Returns and CLEARS the last error. `cudaSuccess` means nothing has gone wrong yet.",
  cudaGetErrorString: "The human-readable form of a cudaError_t. The message a learner can act on.",
  cudaMallocHost: "Page-locked host memory. Not implemented in this Playground.",
  cudaMallocManaged: "Memory the host and device may both touch. Not implemented in this Playground.",
  cudaHostAlloc: "Page-locked host allocation, the host-side form of cudaMallocHost. Not implemented in this Playground.",
  cudaMemcpyAsync: "The asynchronous copy. Needs a stream. Not implemented in this Playground.",
  cudaMemcpyHostToDevice: "A `cudaMemcpyKind`: host to device. The fourth argument of cudaMemcpy, not a function.",
  cudaMemcpyDeviceToHost: "A `cudaMemcpyKind`: device to host, which is how results come back. The fourth argument of cudaMemcpy, not a function.",
  cudaMemcpyDeviceToDevice: "A `cudaMemcpyKind`: device to device. The fourth argument of cudaMemcpy, not a function.",
  cudaMemcpyHostToHost: "A `cudaMemcpyKind`: host to host. The fourth argument of cudaMemcpy, not a function.",
  cudaMemcpyDefault: "A `cudaMemcpyKind`: inferred from the pointers. The fourth argument of cudaMemcpy, not a function.",
  cudaMemsetAsync: "cudaMemset on a stream. Not implemented in this Playground.",
  cudaMemGetInfo: "Free and total device memory. Not implemented in this Playground; the live panel reads the same figure from the harness.",
  cudaStreamSynchronize: "Waits on one stream. Not implemented in this Playground; there is a single implicit stream, and cudaDeviceSynchronize waits for it.",
  cudaPeekAtLastError: "Reads the last error without clearing it. Not implemented in this Playground.",
  cudaGetErrorName: "The symbolic name of a cudaError_t. Not implemented in this Playground; cudaGetErrorString gives the message.",
  cudaSuccess: "Zero: the enumerator every runtime call returns on success. An enumerator, so it resolves at compile time rather than calling into the shim.",
  cudaErrorInvalidValue: "An argument was out of range, usually a pointer or a count.",
  cudaErrorMemoryAllocation: "A device allocation failed. The device is out of memory.",
  cudaErrorLaunchFailure: "The kernel launch itself failed. Compare with `cudaGetLastError` immediately after the launch, which is where the status is set.",
  cudaError_t: "The error type. An enumerator, so it needs no shim entry.",
  cudaMemcpyKind: "The direction argument to cudaMemcpy. An enumerator, so it needs no shim entry.",
  cudaStream_t: "A stream handle. A typedef of an opaque pointer here, so it compiles but no stream API is implemented.",
  cudaLaunchKernel: "Declared by the shim header and resolvable, but with nothing behind it here: taking its address compiles, calling it fails to load. `<<<>>>` compiles to the `hipLaunchKernel` call, which is why launches work.",
  __shared__: "Block-scoped memory, one copy per block, on the compute unit's own LDS. Fast, and banked.",
  __global__: "A kernel. Launched with <<<blocks, threads>>> and cannot return a value.",
  __device__: "A device function. Called from a kernel, not from the host.",
  __constant__: "Read-only device memory, copied from the host with cudaMemcpyToSymbol.",
  __launch_bounds__: "Tells the compiler how many threads a block will have, so it can budget registers.",
};

export const CUDA_SNIPPETS = [
  {
    label: "__global__ kernel",
    detail: "A kernel launched with <<<blocks, threads>>>",
    insert: "__global__ void ${1:name}(${2:int index}) {\n\t${3}\n}\n",
  },
  {
    label: "__shared__ tile",
    detail: "Block-scoped memory on the compute unit's LDS",
    insert: "__shared__ float ${1:tile}[${2:TILE}];\n",
  },
  {
    label: "one thread per element",
    detail: "The canonical elementwise launch, with the bounds check",
    insert:
      "int i = blockIdx.x * blockDim.x + threadIdx.x;\n" +
      "if (i >= ${1:n}) return;\n" +
      "${2:in[i]} = ${3:in[i]} + ${4:value};\n",
  },
  {
    label: "block reduction",
    detail: "Shared-memory reduction, one partial per warp then one per block",
    insert:
      "__shared__ float partials[blockDim.x];\n" +
      "unsigned lane = threadIdx.x & 31u;\n" +
      "partials[threadIdx.x] = ${1:value};\n" +
      "__syncthreads();\n" +
      "for (unsigned stride = blockDim.x / 2; stride > 0; stride >>= 1) {\n" +
      "\tif (threadIdx.x < stride) partials[threadIdx.x] += partials[threadIdx.x + stride];\n" +
      "\t__syncthreads();\n" +
      "}\n" +
      "if (threadIdx.x == 0) ${2:out}[blockIdx.x] = partials[0];\n",
  },
  {
    label: "atomic accumulation",
    detail: "Conflict-free accumulation into global memory",
    insert: "atomicAdd(&${1:out}[0], ${2:value});\n",
  },
  {
    label: "cudaMalloc / check",
    detail: "Allocation with the error check a learner can act on",
    insert:
      "float* device${1:Buffer} = nullptr;\n" +
      "cudaError_t status = cudaMalloc(&device${1:Buffer}, ${2:count} * sizeof(float));\n" +
      'if (status != cudaSuccess) { printf("cudaMalloc failed: %s\\n", cudaGetErrorString(status)); return 1; }\n',
  },
] as const;

export type LintRule = {
  id: string;
  severity: "error" | "warning" | "hint";
  message: string;
    line: number;
  column: number;
    length: number;
};

const MAX_LINT_DEPTH = 64;

function blankCommentsAndStrings(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      // Newlines survive: they carry the line index every position depends on.
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      blank(i, end === -1 ? source.length : end + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        // A backslash escapes the next character, so a quote inside a string is
        // not the end of it.
        j += source[j] === "\\" ? 2 : 1;
      }
      blank(i, Math.min(j + 1, source.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

function offsetToPosition(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function lintCuda(source: string): LintRule[] {
  const code = blankCommentsAndStrings(source);
  const found: LintRule[] = [];
  const report = (offset: number, length: number, rule: Omit<LintRule, "line" | "column" | "length">): void => {
    const at = offsetToPosition(source, offset);
    found.push({ ...rule, line: at.line, column: at.column, length });
  };

  // --- braces and parentheses -------------------------------------------------
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const closers = new Set(Object.values(pairs));
  const openStack: { char: string; offset: number }[] = [];
  let depth = 0;
  let minDepth = 0;
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (pairs[char] !== undefined) {
      if (depth < MAX_LINT_DEPTH) openStack.push({ char, offset: i });
      depth++;
    } else if (closers.has(char)) {
      const top = openStack.pop();
      if (top === undefined) {
        report(i, 1, {
          id: "unbalanced-closer",
          severity: "error",
          message: `\`${char}\` closes nothing that is open.`,
        });
      } else if (pairs[top.char] !== char) {
        report(i, 1, {
          id: "mismatched-bracket",
          severity: "error",
          message: `\`${char}\` closes a \`${top.char}\`.`,
        });
        report(top.offset, 1, {
          id: "mismatched-bracket",
          severity: "error",
          message: `\`${top.char}\` is closed by a \`${char}\`.`,
        });
      }
      depth--;
      if (depth < minDepth) minDepth = depth;
    }
  }
  for (const unclosed of openStack) {
    report(unclosed.offset, 1, {
      id: "unclosed-bracket",
      severity: "error",
      message: `\`${unclosed.char}\` is never closed.`,
    });
  }
  if (minDepth < 0) {
    // Already reported per-closer above; nothing to add.
  }

                const kernelBodies: { start: number; statementDepth: number }[] = [];
  const kernelPattern = /__global__\s*(?:__device__\s*)?(?:void|[\w:<>]+)\s+\w+\s*\([^)]*\)\s*\{/g;
  for (let match = kernelPattern.exec(code); match !== null; match = kernelPattern.exec(code)) {
    const braceOffset = match.index + match[0].length - 1;
    kernelBodies.push({
      start: match.index + match[0].length,
      statementDepth: depthAt(code, braceOffset) + 1,
    });
  }

                const enclosing = enclosingBlockKinds(code);
  const barrierPattern = /__syncthreads\s*\(\s*\)/g;
  const sawShared = /__shared__/.test(code);
  let barrierCount = 0;
  for (let match = barrierPattern.exec(code); match !== null; match = barrierPattern.exec(code)) {
    barrierCount++;
    const kernel = kernelBodies.find((entry) => match.index >= entry.start);
    if (kernel === undefined) continue;
    const kind = BLOCK_KINDS[enclosing[match.index]];
    if (kind !== "if" && kind !== "else") continue;
    report(match.index, match[0].length, {
      id: "divergent-barrier",
      severity: "warning",
      message:
        `\`__syncthreads()\` inside an \`${kind}\`. Every thread in the block must reach it, so if ` +
        "the condition is not the same for all of them the others never arrive and the block " +
        "deadlocks. Hoist the barrier out of the branch, or make the condition block-uniform.",
    });
  }
  if (barrierCount > 0 && !sawShared) {
    const first = code.indexOf("__syncthreads");
    report(first, "__syncthreads".length, {
      id: "barrier-without-shared",
      severity: "hint",
      message:
        "There is a `__syncthreads()` but no `__shared__` variable in this file. " +
        "A barrier with nothing to publish is usually a leftover.",
    });
  }

  // --- symbol-specific hints -------------------------------------------------
  for (const match of code.matchAll(/\bwarpSize\b/g)) {
    report(match.index, match[0].length, {
      id: "warpsize",
      severity: "hint",
      message:
        "`warpSize` is 32 on every part this simulator models and on NVIDIA. " +
        "The interesting unit here is the 64-thread wave.",
    });
  }
  for (const match of code.matchAll(/\bprintf\s*\(/g)) {
    // Only inside a kernel, where the host printf is not what the reader thinks.
    const insideKernel = kernelBodies.some((entry) => match.index >= entry.start);
    if (!insideKernel) continue;
    report(match.index, match[0].length, {
      id: "printf-in-kernel",
      severity: "hint",
      message:
        "`printf` in a kernel. This Playground's shim maps it to the host, but HIP itself does not, " +
        "so the code will not port. Use `printf` in host code and copy results back.",
    });
  }

  return found.sort((left, right) => left.line - right.line || left.column - right.column);
}

function depthAt(code: string, offset: number): number {
  let depth = 0;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") depth--;
  }
  return depth;
}

export type BlockKind =
  | "if" | "else" | "for" | "while" | "do" | "switch" | "struct" | "function" | "block";

export const BLOCK_KINDS: readonly BlockKind[] = [
  "block", "function", "struct", "if", "else", "for", "while", "do", "switch",
];

function blockKindBefore(code: string, braceOffset: number): BlockKind {
  let i = braceOffset - 1;
  // Skip whitespace and one balanced (...) group, so a for/while/if header does
  // not hide the keyword that opened it.
  while (i >= 0 && /\s/.test(code[i])) i--;
  if (i >= 0 && code[i] === ")") {
    let depth = 0;
    while (i >= 0) {
      if (code[i] === ")") depth++;
      else if (code[i] === "(") {
        depth--;
        if (depth === 0) break;
      }
      i--;
    }
    i--;
    while (i >= 0 && /\s/.test(code[i])) i--;
  }
  for (const [keyword, kind] of [["else", "else"], ["if", "if"], ["for", "for"], ["while", "while"], ["do", "do"], ["switch", "switch"], ["struct", "struct"]] as const) {
    if (!code.startsWith(keyword, i - keyword.length + 1)) continue;
                const before = i - keyword.length;
    if (before < 0 || !/\w/.test(code[before])) return kind;
  }
  // Nothing recognisable, so this brace is a function body or a bare block.
  return "function";
}

function enclosingBlockKinds(code: string): Uint8Array {
  const index = new Map(BLOCK_KINDS.map((kind, i) => [kind, i]));
  const kinds = new Uint8Array(code.length);
  const stack: number[] = [];
  for (let i = 0; i < code.length; i++) {
    kinds[i] = stack.length === 0 ? index.get("block")! : stack[stack.length - 1];
    if (code[i] === "{") stack.push(index.get(blockKindBefore(code, i))!);
    else if (code[i] === "}" && stack.length > 0) stack.pop();
  }
  return kinds;
}

export function cudaIdentifiers(): string[] {
  return [...new Set<string>([...CUDA_KEYWORDS, ...CUDA_TYPES, ...CUDA_RUNTIME])].sort();
}
