// The Monarch definition for the CUDA language, kept out of the editor component
// so tests can compile it. Monarch validates every `next` state when the lexer is
// built, and it does that inside setMonarchTokensProvider, so a state referenced
// but never defined throws at registration and takes the whole editor down.
import type * as monaco from "monaco-editor/editor/editor.api";
import { CUDA_KEYWORDS, CUDA_RUNTIME, CUDA_TYPES } from "./cudaLanguage";

export const cudaMonarch: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  // CUDA's qualifiers plus the C++ a .cu file is actually read with.
  keywords: [
    ...CUDA_KEYWORDS,
    // C++ keywords, the subset a .cu file in this Playground can use.
    "alignas", "alignof", "and", "asm", "auto", "bool", "break", "case", "catch",
    "char", "class", "const", "constexpr", "const_cast", "continue", "decltype",
    "default", "delete", "do", "double", "dynamic_cast", "else", "enum", "explicit",
    "export", "extern", "false", "float", "for", "friend", "goto", "if", "inline",
    "int", "long", "mutable", "namespace", "new", "noexcept", "nullptr", "operator",
    "private", "protected", "public", "register", "reinterpret_cast", "return",
    "short", "signed", "sizeof", "static", "static_assert", "static_cast", "struct",
    "switch", "template", "this", "thread_local", "throw", "true", "try", "typedef",
    "typeid", "typename", "union", "unsigned", "using", "virtual", "void", "volatile",
    "wchar_t", "while",
  ],
  types: [...CUDA_TYPES],
  builtins: [
    // Runtime API listed apart from the intrinsics so completion can rank it.
    ...CUDA_RUNTIME,
    // Host libc names: ordinary host functions, so they take the identifier
    // colour and appear in completion only.
  ],
  tokenizer: {
    root: [
      // Preprocessor first: a #define carries the constants every launch size
      // comes from.
      [/^\s*#\s*(?:define|include|pragma|ifndef|ifdef|endif|if|else|elif|undef|error|line)\b/,
        "keyword.control"],
      // Its own token class so the theme can tint execution space apart from C++.
      [/@(?:global|device|host|shared|constant|managed|restrict|launch_bounds|forceinline|noinline|align)\b/, "keyword.cuda"],
      // Literals, above the identifier rule: `u8` is an identifier by that rule's
      // regex, and it has to win before the prefix can stay one token.
      //
      // A literal body runs in its own state, so an escaped quote does not end it.
      // The unterminated case is matched here instead of in that state, because
      // Monarch leaves its loop at the end of a line: a rule anchored on `$` inside
      // the string state would never run and the literal would colour the rest of
      // the file.
      [/u8"/, "string", "@string"],
      [/"(?:[^"\\\n]|\\.)*$/, "string.invalid"],
      [/'[^'\n]*$/, "string.invalid"],
      [/"/, "string", "@string"],
      [/'/, "string", "@stringChar"],
      [/(?:def|class|struct|namespace|template|typedef)\b/, { cases: { "@keywords": "keyword", "@default": "type.identifier" } }],
      [/[a-zA-Z_]\w*/, {
        cases: {
          "@types": "type",
          "@builtins": "support.function",
          "@keywords": { cases: { "@types": "type", "@default": "keyword" } },
          "@default": "identifier",
        },
      }],
      { include: "@whitespace" },
      [/[{}()[\]]/, "@brackets"],
      [/[<>]/, "operators"],
      // One token per literal, so `0xFFu` and `1.5e-3f` do not split in three.
      // These come before the delimiter and operator rules, or the integer rule
      // and the `.` both get there first and the literal is cut in half.
      [/0[xX][0-9a-fA-F']+[uUlL]*/, "number.hex"],
      [/0[bB][01']+[uUlL]*/, "number.hex"],
      [/\d[\d']*(?:\.\d*)?[eE][+-]?\d+[fFuUlL]*/, "number.float"],
      [/\d[\d']*\.\d*[fFuUlL]*/, "number.float"],
      [/\.\d+(?:[eE][+-]?\d+)?[fFuUlL]*/, "number.float"],
      [/\d[\d']*[fFuUlL]*/, "number"],
      [/[;,.]/, "delimiter"],
      [/[=><!~?:&|+\-*/^%]+/, "operators"],
      { include: "@whitespace" },
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
    ],
    // Inside a "..." literal. The terminator pops, so the state cannot leak into
    // the rest of the file.
    string: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],
    // Same, for a character literal.
    stringChar: [
      [/'/, "string", "@pop"],
      [/[^\\']+/, "string"],
      [/\\./, "string.escape"],
    ],
    comment: [
      [/[^*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/\*/, "comment"],
    ],
    whitespace: [
      [/[ \t\r\n]+/, "white"],
      [/\/\*/, "comment", "@comment"],
      [/\/\/.*$/, "comment"],
    ],
  },
};
