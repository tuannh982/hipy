import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/editor/contrib/find/browser/findController";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition";
import "monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch";
import "monaco-editor/editor/contrib/links/browser/links";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/editor/contrib/comment/browser/comment";
import "monaco-editor/editor/contrib/folding/browser/folding";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import type { CompilerDiagnostic } from "../lib/compilerDiagnostics";
import type { LintRule } from "../lib/cudaLanguage";
import {
  CUDA_RUNTIME_URI,
  cudaRuntimeSource,
  indexRuntime,
  indexSource,
} from "../lib/cudaSymbols";
import {
  CUDA_BOUNDARIES,
  CUDA_DOCS,
  CUDA_ERROR_CODES,
  CUDA_KEYWORDS,
  CUDA_MEMCPY_KINDS,
  CUDA_RUNTIME,
  CUDA_SNIPPETS,
  CUDA_TYPES,
  cudaIdentifiers,
  isCudaRuntimeDeclaredOnly,
  isCudaRuntimeImplemented,
  isCudaRuntimeUnimplemented,
  lintCuda,
} from "../lib/cudaLanguage";
import { cudaMonarch } from "../lib/cudaMonarch";

const languageId = "cuda";
let languageRegistered = false;

function registerCudaLanguage(): void {
  if (languageRegistered) return;
  monaco.languages.register({ id: languageId, extensions: [".cu", ".cuh"] });
  // Without these tokens the toggle-comment actions are registered but do nothing:
  // they read the comment strings off the language configuration.
  monaco.languages.setLanguageConfiguration(languageId, {
    comments: {
      lineComment: "//",
      blockComment: ["/*", "*/"],
    },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
  monaco.languages.setMonarchTokensProvider(languageId, cudaMonarch);
  registerCompletionItemProvider();
  registerHoverProvider();
  registerSignatureHelpProvider();
  registerDefinitionProvider();

  monaco.editor.defineTheme("cuda-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "C792EA", fontStyle: "bold" },
      // The one keyword set the theme separates, so `__global__` and `return` do
      // not look alike.
      { token: "keyword.cuda", foreground: "FF5370", fontStyle: "bold" },
      { token: "type", foreground: "FFCB6B" },
      { token: "type.identifier", foreground: "FFCB6B" },
      { token: "keyword.control", foreground: "89DDFF" },
      { token: "support.function", foreground: "82AAFF" },
      { token: "identifier", foreground: "cccccc" },
      { token: "string.escape", foreground: "F78C6C" },
      { token: "string.invalid", foreground: "FF5370", fontStyle: "underline" },
      { token: "comment", foreground: "6a9955" },
      { token: "number", foreground: "F78C6C" },
      { token: "number.float", foreground: "F78C6C" },
      { token: "number.hex", foreground: "F78C6C" },
    ],
    // Monaco paints the surface itself, so these have to agree with styles.css.
    // A theme change is three places: here, the :root tokens, and LDS_PALETTE.
    colors: {
      "editor.background": "#1e1e1e",
      "editor.foreground": "#cccccc",
      "editorLineNumber.foreground": "#6e7681",
      "editorLineNumber.activeForeground": "#cccccc",
      "editor.selectionBackground": "#264f78",
      "editor.lineHighlightBackground": "#2a2d2e",
      "editorCursor.foreground": "#aeafad",
    },
  });
  languageRegistered = true;
}

const CUDA_VECTOR_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  // uint3. A CUDA thread has no fourth index, so .w is deliberately absent.
  threadIdx: ["x", "y", "z"],
  blockIdx: ["x", "y", "z"],
  blockDim: ["x", "y", "z"],
  gridDim: ["x", "y", "z"],
  float2: ["x", "y"],
  int2: ["x", "y"],
  uint2: ["x", "y"],
  double2: ["x", "y"],
  float4: ["x", "y", "z", "w"],
  int4: ["x", "y", "z", "w"],
  uint4: ["x", "y", "z", "w"],
};

const MEMBER_DOCS: Readonly<Record<string, string>> = {
  x: "Component 0. Across lanes this is the one that varies fastest.",
  y: "Component 1.",
  z: "Component 2.",
  w: "Component 3. Only on the 4-component types.",
};

function completionContext(model: monaco.editor.ITextModel, position: monaco.Position): {
  word: monaco.editor.IWordAtPosition;
  afterDot: string | null;
} {
  const word = model.getWordUntilPosition(position);
  const before = model
    .getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: word.startColumn,
    })
    .replace(/[ \t]+$/, "");
  const dotted = /([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(before);
  return {
    word,
    afterDot: dotted === null ? null : dotted[1],
  };
}

function registerCompletionItemProvider(): void {
  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: [".", "_", ">", ":", "<", "(", ","],
    provideCompletionItems(model, position) {
      const { word, afterDot } = completionContext(model, position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const source = model.getValue();
      // Only the identifier's prefix, so `atomic` does not also suggest the `Add`
      // in something already written.
      const typed = source.slice(
        model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn }),
        model.getOffsetAt(position),
      );
      const suggest: monaco.languages.CompletionItem[] = [];
      let rank = 0;
      const next = (): string => String(rank++).padStart(4, "0");

                        const members = afterDot === null ? undefined : CUDA_VECTOR_MEMBERS[afterDot];
      if (members !== undefined) {
        for (const member of members) {
          suggest.push({
            label: member,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: member,
            detail: `${afterDot} member`,
            documentation: MEMBER_DOCS[member],
            sortText: next(),
            range,
          });
        }
        return { suggestions: suggest };
      }

      // An open `<<<`, where the geometry is about to be written and nothing
      // keyword-shaped is the right answer.
      const lineBefore = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      if (/<<<[^<>]*$/.test(lineBefore)) {
        for (const launch of LAUNCH_CONFIGS) {
          suggest.push({
            label: launch.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: "launch configuration",
            insertText: launch.insert,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            sortText: next(),
            range: {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: 1,
              endColumn: position.column,
            },
          });
        }
        return { suggestions: suggest };
      }

      for (const snippet of CUDA_SNIPPETS) {
        suggest.push({
          label: snippet.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: snippet.detail,
          insertText: snippet.insert,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          sortText: next(),
          range,
        });
      }
      for (const name of CUDA_KEYWORDS) {
        const docs = CUDA_DOCS[name];
        suggest.push({
          label: name,
          kind: name.startsWith("__") ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Constant,
          insertText: name,
          detail: docs ?? "HIP intrinsic",
          documentation: docs,
          sortText: next(),
          range,
        });
      }
                        for (const name of rankedRuntime()) {
        const docs = CUDA_DOCS[name];
        suggest.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: name,
          detail: runtimeDetail(name),
          documentation: docs,
          sortText: next(),
          range,
        });
      }
      for (const name of [...CUDA_MEMCPY_KINDS, ...CUDA_ERROR_CODES, "cudaSuccess"]) {
        suggest.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.EnumMember,
          insertText: name,
          detail: "enumerator — resolves at compile time",
          documentation: CUDA_DOCS[name],
          sortText: next(),
          range,
        });
      }
      for (const name of CUDA_TYPES) {
        suggest.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.TypeParameter,
          insertText: name,
          detail: "type",
          sortText: next(),
          range,
        });
      }
      for (const name of CUDA_BOUNDARIES) {
        suggest.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: name,
          detail: "host libc",
          sortText: next(),
          range,
        });
      }

                        const seen = new Set<string>([...typed]);
      for (const match of source.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
        const word = match[0];
        if (seen.has(word) || word.length < 2) continue;
        seen.add(word);
        suggest.push({
          label: word,
          kind: monaco.languages.CompletionItemKind.Text,
          insertText: word,
          detail: "in this file",
          sortText: `9${String(rank++).padStart(3, "0")}`,
          range,
        });
      }

      return { suggestions: suggest };
    },
  });
}

function rankedRuntime(): readonly string[] {
  const group = (test: (name: string) => boolean): readonly string[] =>
    CUDA_RUNTIME.filter(test);
  return [
    ...group(isCudaRuntimeImplemented),
    ...group((name) => !isCudaRuntimeImplemented(name) && !isCudaRuntimeUnimplemented(name)),
    ...group(isCudaRuntimeDeclaredOnly),
    ...group(isCudaRuntimeUnimplemented),
  ];
}

function runtimeDetail(name: string): string {
  if (isCudaRuntimeImplemented(name)) return "HIP runtime API";
  if (isCudaRuntimeUnimplemented(name)) return "HIP runtime API — not implemented here";
  if (isCudaRuntimeDeclaredOnly(name)) return "declared, but not callable here";
  return "HIP runtime type";
}

const LAUNCH_CONFIGS = [
  {
    label: "<<<blocks, threads>>>",
    detail: "One block per launch-size element",
    insert: "<<<${1:blocks}, ${2:threads}>>>",
  },
  {
    label: "<<<div-up grid, blockDim.x>>>",
    detail: "The derived grid that covers every element exactly once",
    insert: "<<<(${1:n} + blockDim.x - 1) / blockDim.x, ${2:blockDim.x}>>>\n",
  },
] as const;

function registerHoverProvider(): void {
  monaco.languages.registerHoverProvider(languageId, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (word === null) return null;
      const docs = CUDA_DOCS[word.word];
      const contents: monaco.IMarkdownString[] = [];
      if (docs !== undefined) {
        contents.push({ value: `**${word.word}** — HIP`, isTrusted: false });
        contents.push({ value: docs });
        return { contents, range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) };
      }
      if ((CUDA_RUNTIME as readonly string[]).includes(word.word)) {
                                        const runnable = isCudaRuntimeImplemented(word.word);
        const compilesOnly = !runnable && !isCudaRuntimeUnimplemented(word.word) && !isCudaRuntimeDeclaredOnly(word.word);
        const declaredOnly = isCudaRuntimeDeclaredOnly(word.word);
        const title = runnable
          ? `**${word.word}**(…) — HIP runtime`
          : compilesOnly
            ? `**${word.word}** — HIP runtime type`
            : declaredOnly
              ? `**${word.word}**(…) — declared, **not callable here**`
              : `**${word.word}**(…) — HIP runtime, **not implemented here**`;
        contents.push({ value: title, isTrusted: false });
        contents.push({
          value: runnable
            ? "Part of the HIP runtime API. Implemented by this Playground's shim."
            : compilesOnly
              ? "A type or enumerator rather than a call, so it resolves at compile time and needs no shim entry."
              : declaredOnly
                ? "The shim header declares it, so it resolves, but there is no implementation behind it. Calling it fails to load; `<<<>>>` does not go through it."
                : "Real CUDA, but this Playground's shim does not implement it. A program that calls it fails to load with `unsupported host imports`.",
        });
        return { contents, range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) };
      }
      const enumerators: readonly string[] = [...CUDA_MEMCPY_KINDS, ...CUDA_ERROR_CODES, "cudaSuccess"];
      if (enumerators.includes(word.word)) {
        contents.push({ value: `\`${word.word}\` — HIP enumerator`, isTrusted: false });
        contents.push({ value: docs ?? "A compile-time enumerator, so it resolves without a call into the shim." });
        return { contents, range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) };
      }
      if ((CUDA_KEYWORDS as readonly string[]).includes(word.word)) {
        contents.push({ value: `\`${word.word}\` — HIP`, isTrusted: false });
        contents.push({ value: "No note for this one yet." });
        return { contents, range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) };
      }
      return null;
    },
  });
}

let runtimeModel: monaco.editor.ITextModel | null = null;

function registerDefinitionProvider(): void {
  if (runtimeModel === null) {
                runtimeModel = monaco.editor.createModel(
      cudaRuntimeSource(),
      languageId,
      monaco.Uri.parse(CUDA_RUNTIME_URI),
    );
    runtimeModel.updateOptions({ tabSize: 2 });
  }
  const api = runtimeModel;
  const apiIndex = indexRuntime(api.getValue());

  monaco.languages.registerDefinitionProvider(languageId, {
    provideDefinition(model, position) {
      const word = model.getWordAtPosition(position);
      // Null rather than an empty location: "nothing to jump to" and "jump to
      // nowhere" are different.
      if (word === null) return null;

      const local = indexSource(model.getValue()).get(word.word);
      if (local !== undefined) {
        return {
          uri: model.uri,
          range: new monaco.Range(local.line, local.column, local.line, local.endColumn),
        };
      }

      const remote = apiIndex.get(word.word);
      if (remote !== undefined) {
        return {
          uri: api.uri,
          range: new monaco.Range(remote.line, remote.column, remote.line, remote.endColumn),
        };
      }
      return null;
    },
  });

        monaco.languages.registerReferenceProvider(languageId, {
    provideReferences(model, position) {
      const word = model.getWordAtPosition(position);
      if (word === null) return [];
      const locations: monaco.languages.Location[] = [];
      const pattern = new RegExp(`\\b${escapeRegExp(word.word)}\\b`, "g");
      const source = model.getValue();
      for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
        const line = source.slice(0, match.index).split("\n").length;
        locations.push({
          uri: model.uri,
          range: new monaco.Range(line, match.index + 1, line, match.index + 1 + word.word.length),
        });
      }
      return locations;
    },
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SIGNATURES: Readonly<Record<string, { signature: string; doc: string }>> = {
  cudaMalloc: { signature: "cudaError_t cudaMalloc(void** devicePtr, size_t size)", doc: "The pointer is a DEVICE pointer; dereferencing it from the host faults." },
  cudaMallocHost: { signature: "cudaError_t cudaMallocHost(void** hostPtr, size_t size)", doc: "Page-locked host memory. Not implemented in this Playground." },
  cudaMemcpy: { signature: "cudaError_t cudaMemcpy(void* dst, const void* src, size_t count, cudaMemcpyKind kind)", doc: "Synchronous. The host blocks until the copy is done." },
  cudaMemcpyAsync: { signature: "cudaError_t cudaMemcpyAsync(void* dst, const void* src, size_t count, cudaMemcpyKind kind, cudaStream_t stream)", doc: "Needs a stream. Not implemented in this Playground." },
  cudaMemset: { signature: "cudaError_t cudaMemset(void* devicePtr, int value, size_t count)", doc: "Fills device memory with a byte value." },
  cudaFree: { signature: "cudaError_t cudaFree(void* devicePtr)", doc: "Passing anything but a cudaMalloc pointer is undefined." },
  cudaDeviceSynchronize: { signature: "cudaError_t cudaDeviceSynchronize()", doc: "Blocks until all previously issued device work completes. Where the run happens." },
  cudaGetLastError: { signature: "cudaError_t cudaGetLastError()", doc: "Returns AND CLEARS the last error." },
  cudaGetErrorString: { signature: "const char* cudaGetErrorString(cudaError_t error)", doc: "The message a learner can act on." },
  cudaMemGetInfo: { signature: "cudaError_t cudaMemGetInfo(size_t* free, size_t* total)", doc: "Not implemented in this Playground; the live panel reads the same figure from the harness." },
  // `dim3` is a type rather than a runtime call, but it is the one type whose
  // parameters are easy to get wrong, and signature help is where they are checked.
  dim3: { signature: "dim3 dim3(unsigned x = 1, unsigned y = 1, unsigned z = 1)", doc: "A launch shape. A one-argument dim3 is a 1-D block; the defaults make x the fast-varying index." },
};

function registerSignatureHelpProvider(): void {
  monaco.languages.registerSignatureHelpProvider(languageId, {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp(model, position) {
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const open = line.lastIndexOf("(");
      if (open === -1) return null;
      const before = line.slice(0, open);
      const name = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before)?.[1];
      if (name === undefined) return null;
      const entry = SIGNATURES[name];
      if (entry === undefined) return null;
      // Which parameter the caret is in, by counting commas at this level.
      const inside = line.slice(open + 1);
      let depth = 0;
      let parameter = 0;
      for (const char of inside) {
        if (char === "(" || char === "[") depth++;
        else if (char === ")" || char === "]") depth--;
        else if (char === "," && depth === 0) parameter++;
      }
      return {
        value: {
          signatures: [{
            label: entry.signature,
            documentation: entry.doc,
            parameters: parameterNames(entry.signature).map((p) => ({ label: p })),
          }],
          activeSignature: 0,
          activeParameter: Math.min(parameter, parameterNames(entry.signature).length - 1),
        },
        dispose: () => {},
      };
    },
  });
}

function parameterNames(signature: string): string[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open === -1 || close <= open) return [];
  return signature.slice(open + 1, close).split(",").map((part) => part.trim());
}

type MonacoEnvironment = { getWorker(_moduleId: string, _label: string): Worker };
const workerScope = self as typeof self & { MonacoEnvironment?: MonacoEnvironment };
workerScope.MonacoEnvironment = { getWorker: () => new EditorWorker() };

type CudaEditorProps = {
  value: string;
  diagnostics: CompilerDiagnostic[];
  onChange(value: string): void;
  revealLine?: { line: number; at: number } | null;
};

export function CudaEditor({ value, diagnostics, onChange, revealLine = null }: CudaEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    registerCudaLanguage();
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language: languageId,
      theme: "cuda-dark",
      automaticLayout: false,
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
      fontSize: 14,
      lineHeight: 22,
      minimap: { enabled: false },
      padding: { top: 14 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 4,
      wordWrap: "on",
    });
    editorRef.current = editor;

    editor.addAction({
      id: "hipy.findInCode",
      label: "Find in Code",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1,
      run: (target) => {
        target.getAction("actions.find")?.run();
      },
    });

    // Monaco binds line comment to Cmd/Ctrl+/ on its own once the comment
    // contribution is loaded, but block comment to Shift+Alt+A, which is not what
    // anyone expects from a code editor. Cmd/Ctrl+Shift+/ is the convention.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Slash, () => {
      editor.getAction("editor.action.blockComment")?.run();
    });

    applyLint(editor);
    const changeSubscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue());
      applyLint(editor);
    });
    const resizeObserver = new ResizeObserver(() => editor.layout());
    resizeObserver.observe(hostRef.current);
    return () => {
      resizeObserver.disconnect();
      changeSubscription.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) {
      editor.setValue(value);
      applyLint(editor);
    }
  }, [value]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(model, compilerOwner, diagnostics.map((diagnostic) => ({
      ...diagnostic,
      severity: diagnostic.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
    })));
    return () => monaco.editor.setModelMarkers(model, compilerOwner, []);
  }, [diagnostics]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null || revealLine === null) return;
    const position = { lineNumber: revealLine.line, column: 1 };
    editor.setPosition(position);
    editor.revealPositionInCenter(position, monaco.editor.ScrollType.Immediate);
    editor.focus();
  }, [revealLine]);

  return <div className="editor-host" ref={hostRef} aria-label="HIP source editor" />;
}

const compilerOwner = "clang";
const lintOwner = "cuda-lint";

const MARKER_SEVERITY: Record<LintRule["severity"], monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  hint: monaco.MarkerSeverity.Info,
};

function applyLint(editor: monaco.editor.IStandaloneCodeEditor): void {
  const model = editor.getModel();
  if (model === null) return;
  monaco.editor.setModelMarkers(
    model,
    lintOwner,
    lintCuda(model.getValue()).map((rule) => ({
      startLineNumber: rule.line,
      startColumn: rule.column,
      endLineNumber: rule.line,
      endColumn: rule.column + rule.length,
      message: rule.message,
      severity: MARKER_SEVERITY[rule.severity],
                        source: `cuda-lint:${rule.id}`,
    })),
  );
}
