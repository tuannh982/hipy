// The CUDA language: what the editor knows, and how it knows it.
//
// Monaco ships a `cpp` tokenizer, which is a syntax highlighter and nothing more.
// So what follows is a C++-complete tokenizer plus the four things a language
// service contributes that a highlighter cannot, each scoped to CUDA. Anything
// needing a type checker or a preprocessor is not attempted: a wrong diagnostic
// in an editor a learner trusts teaches them to ignore the squiggles.

/** The tables, as data. Every provider below reads these, so there is one list. */

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
  // Math and utility intrinsics. The f-suffixed float forms lead because those are
  // what a learner reaches for; the double forms are here so forgetting the suffix
  // is catchable in completion.
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
  "dim3", "cudaError_t", "cudaStream_t", "cudaEvent_t",
] as const;

export const CUDA_RUNTIME = [
  "cudaMalloc", "cudaMallocHost", "cudaMallocManaged", "cudaFree", "cudaHostAlloc",
  "cudaMemcpy", "cudaMemcpyAsync", "cudaMemcpyHostToDevice", "cudaMemcpyDeviceToHost",
  "cudaMemcpyDeviceToDevice", "cudaMemcpyHostToHost", "cudaMemset", "cudaMemsetAsync",
  "cudaMemGetInfo", "cudaDeviceSynchronize", "cudaStreamSynchronize",
  "cudaGetLastError", "cudaPeekAtLastError", "cudaGetErrorString", "cudaGetErrorName",
  "cudaSuccess",
] as const;

export const CUDA_BOUNDARIES = [
  "printf", "malloc", "free", "exit", "sqrt", "pow", "exp", "log", "sin", "cos",
] as const;

/**
 * One-line documentation per intrinsic, shown on hover.
 *
 * Deliberately short: a hover that opens a wall of text does not get read. A symbol
 * absent from the table has no note, and hover says so rather than inventing one.
 */
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
  cudaMemcpy: "Copies between host and device. Synchronous: the host blocks until it is done.",
  cudaDeviceSynchronize: "Blocks until every previously issued device work has completed.",
  cudaGetLastError: "Returns and CLEARS the last error. `cudaSuccess` means nothing has gone wrong yet.",
  cudaGetErrorString: "The human-readable form of a cudaError_t. The message a learner can act on.",
  __shared__: "Block-scoped memory, one copy per block, on the compute unit's own LDS. Fast, and banked.",
  __global__: "A kernel. Launched with <<<blocks, threads>>> and cannot return a value.",
  __device__: "A device function. Called from a kernel, not from the host.",
  __constant__: "Read-only device memory, copied from the host with cudaMemcpyToSymbol.",
  __launch_bounds__: "Tells the compiler how many threads a block will have, so it can budget registers.",
};

/**
 * Snippets offered as completion: whole shapes rather than bare keywords, because
 * the mistake they prevent is structural. Each compiles in this Playground.
 */
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

/**
 * The lint rules.
 *
 * Every rule is decidable from the text alone, which is the only acceptable bar
 * for a diagnostic shown to a learner.
 */
export type LintRule = {
  id: string;
  severity: "error" | "warning" | "hint";
  message: string;
  /** One-based, because that is what Monaco wants and what a reader counts by. */
  line: number;
  column: number;
  /** Span length in characters, for the squiggle's extent. */
  length: number;
};

const MAX_LINT_DEPTH = 64;

/**
 * Strip comments and string literals, preserving offsets exactly so a position
 * found here indexes the original text. Without it a barrier mentioned inside a
 * comment or a `__shared__` inside a printf format string is a false positive.
 */
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

/** Byte offset -> { line, column }, both one-based. */
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

/**
 * Lint one CUDA source.
 *
 * - unbalanced braces and parentheses. The compiler catches these, but with a
 *   message about a token the learner has not met.
 * - `__syncthreads()` inside an `if` or a loop: the barrier is a block-wide
 *   rendezvous, so threads that took the other branch never arrive and it
 *   deadlocks. Textual only -- it cannot see whether the branch is uniform -- so
 *   it is a warning and never an error.
 * - a `__syncthreads()` with no `__shared__` write or read anywhere in the file.
 *   Usually a leftover from a kernel that no longer needs it. Weak, so a hint.
 * - `warpSize`, which reads as portable but is 32 on both vendors.
 * - a `printf` in device code: legal in this Playground, but not in HIP, so it
 *   will not port.
 */
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

  // --- kernel and brace depth ------------------------------------------------
  // For each kernel, where its BODY's statements sit in the file's brace depth.
  //
  // The off-by-one is the whole rule: a barrier directly in the kernel body sits AT
  // the body's depth, so comparing against the braces' own depth flags every
  // correct block reduction. Flagged only when deeper than the statement depth,
  // which is inside an if, a loop, or any other brace.
  const kernelBodies: { start: number; statementDepth: number }[] = [];
  const kernelPattern = /__global__\s*(?:__device__\s*)?(?:void|[\w:<>]+)\s+\w+\s*\([^)]*\)\s*\{/g;
  for (let match = kernelPattern.exec(code); match !== null; match = kernelPattern.exec(code)) {
    const braceOffset = match.index + match[0].length - 1;
    kernelBodies.push({
      start: match.index + match[0].length,
      statementDepth: depthAt(code, braceOffset) + 1,
    });
  }

  // --- barrier rules ---------------------------------------------------------
  //
  // Conditional only -- an `if` or an `else`, never a loop: a barrier in a loop is
  // the inner step of every correct block reduction. See blockKindBefore.
  //
  // The wording is conditional for the same reason. This cannot see whether the
  // condition is uniform across the block, so it says what to check.
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

/** Brace depth immediately before `offset`. */
function depthAt(code: string, offset: number): number {
  let depth = 0;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") depth--;
  }
  return depth;
}

/**
 * What kind of block encloses each character.
 *
 * A barrier inside ANY brace looks identical whether the brace is a conditional
 * or a loop, and the two have opposite answers, so the barrier rule needs to know
 * which. Classified from the last keyword before the `{`, ignoring whitespace and
 * any intervening `)`, which is enough for `} else {`, `for (...) {`, `if (x) {`,
 * `__global__ void f(...) {`.
 */
export type BlockKind =
  | "if" | "else" | "for" | "while" | "do" | "switch" | "struct" | "function" | "block";

/** The kinds, in the order `enclosingBlockKinds` numbers them. */
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
    // The character before the keyword must not be a word character, or this is
    // the tail of a longer identifier: `myif` is not a conditional. A `\w` test
    // here, not `\W`, since the boundary case is a non-word character.
    const before = i - keyword.length;
    if (before < 0 || !/\w/.test(code[before])) return kind;
  }
  // Nothing recognisable, so this brace is a function body or a bare block.
  return "function";
}

/**
 * The innermost enclosing block kind at every offset. One pass, one array. A
 * function body and a bare block share a kind because nothing distinguishes them
 * textually and the rule that reads this only cares about the conditional kinds.
 */
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

/** Every CUDA identifier the editor knows, deduplicated and sorted for suggestions. */
export function cudaIdentifiers(): string[] {
  return [...new Set<string>([...CUDA_KEYWORDS, ...CUDA_TYPES, ...CUDA_RUNTIME])].sort();
}
