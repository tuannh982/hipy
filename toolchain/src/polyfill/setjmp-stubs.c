// No-op setjmp/longjmp for the WASIX LLVM driver.
//
// The sysroot's setjmp routes through the WASIX stack_checkpoint syscall, which
// needs the binaryen asyncify intrinsics; without them the driver exits 45 as soon
// as cc1 runs. The only caller is CrashRecoveryContext, whose longjmp is taken
// only on a cc1 crash, so setjmp always returns 0 and longjmp aborts.
//
// Link this archive BEFORE the sysroot libc so these stubs win over libc.a's
// setjmp objects (see -lsetjmp-polyfill in wasix_toolchain.cmake).
#include <stdlib.h>

// jmp_buf is opaque and never written: setjmp always reports the "direct return"
// case.
typedef struct {
  unsigned char opaque[64];
} polyfill_jmp_buf;

int setjmp(polyfill_jmp_buf *env) {
  (void)env;
  return 0;
}

int _setjmp(polyfill_jmp_buf *env) {
  (void)env;
  return 0;
}

int sigsetjmp(polyfill_jmp_buf *env, int savesigs) {
  (void)env;
  (void)savesigs;
  return 0;
}

int _sigsetjmp(polyfill_jmp_buf *env, int savesigs) {
  (void)env;
  (void)savesigs;
  return 0;
}

// Reaching longjmp means cc1 crashed inside a CrashRecoveryContext and there is no
// way to unwind here, so trap.
void longjmp(polyfill_jmp_buf *env, int val) {
  (void)env;
  (void)val;
  abort();
}

void _longjmp(polyfill_jmp_buf *env, int val) {
  (void)env;
  (void)val;
  abort();
}

void siglongjmp(polyfill_jmp_buf *env, int val) {
  (void)env;
  (void)val;
  abort();
}
