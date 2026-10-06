# CMake toolchain for the LLVM wasm driver.
#
# This is an independent implementation of the public WASIX build contract.
# The compile and linker flags follow the linker guidance in:
#   https://wasmerio.github.io/wasmer/crates/doc/wasmer_wasix/state/linker/index.html
# The compiler is the pinned wasi-sdk 25.0 cross-clang, and the libc headers
# and libraries come from wasix-libc. The documented WASIX features and
# emulated interfaces must be enabled consistently by the compiler and linker.
#
# References:
#   wasi-sdk 25.0, Apache-2.0 WITH LLVM-exception
#   https://github.com/WebAssembly/wasi-sdk
#   wasix-libc, MIT OR Apache-2.0 OR Apache-2.0-LLVM
#   https://github.com/wasix-org/wasix-libc
#   Wasmer, MIT
#   https://github.com/wasmerio/wasmer

set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

get_filename_component(_WASIX_SYSROOT "${CMAKE_CURRENT_LIST_DIR}/../../artifacts/wasix-sysroot" ABSOLUTE)
set(CMAKE_SYSROOT "${_WASIX_SYSROOT}")

get_filename_component(_WASI_SDK "${CMAKE_CURRENT_LIST_DIR}/../../artifacts/wasi-sdk" ABSOLUTE)
set(triple wasm32-wasi)
set(CMAKE_C_COMPILER "${_WASI_SDK}/bin/clang")
set(CMAKE_CXX_COMPILER "${_WASI_SDK}/bin/clang++")
set(CMAKE_ASM_COMPILER "${_WASI_SDK}/bin/clang")
set(CMAKE_C_COMPILER_TARGET ${triple})
set(CMAKE_CXX_COMPILER_TARGET ${triple})

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

get_filename_component(_POLYFILL "${CMAKE_CURRENT_LIST_DIR}/../polyfill" ABSOLUTE)
set(_WASI_BIN "-B${_WASI_SDK}/bin")

set(_WASIX_COMPILE_FLAGS
    -g1
    -matomics
    -mbulk-memory
    -mmutable-globals
    -pthread
    "-mthread-model posix"
    -ftls-model=local-exec
    -fno-trapping-math
    -D_WASI_EMULATED_MMAN
    -D_WASI_EMULATED_SIGNAL
    -D_WASI_EMULATED_PROCESS_CLOCKS
    -D__HAIKU__
    -DSS_ONSTACK=1
    -I${_POLYFILL}
    ${_WASI_BIN}
)
string(JOIN " " _WASIX_COMPILE_FLAGS ${_WASIX_COMPILE_FLAGS})

set(CMAKE_C_FLAGS "${_WASIX_COMPILE_FLAGS}" CACHE STRING "" FORCE)
set(CMAKE_CXX_FLAGS "${_WASIX_COMPILE_FLAGS}" CACHE STRING "" FORCE)

set(_WASIX_LINK_FLAGS
    -Wl,--shared-memory
    -Wl,--max-memory=4294967296
    -Wl,--import-memory
    -Wl,--export-dynamic
    -Wl,--export=__stack_pointer
    -Wl,--export=__heap_base
    -Wl,--export=__data_end
    -Wl,--export=__wasm_init_tls
    -Wl,--export=__wasm_signal
    -Wl,--export=__tls_size
    -Wl,--export=__tls_align
    -Wl,--export=__tls_base
    -Wl,-z,stack-size=1048576
    -lwasi-emulated-mman
    -lwasi-emulated-process-clocks
    -L${CMAKE_CURRENT_LIST_DIR}/../../artifacts
    -lsetjmp-polyfill
    -lmman-polyfill
)
string(JOIN " " _WASIX_LINK_FLAGS ${_WASIX_LINK_FLAGS})

set(CMAKE_EXE_LINKER_FLAGS "${_WASIX_LINK_FLAGS}" CACHE STRING "" FORCE)
