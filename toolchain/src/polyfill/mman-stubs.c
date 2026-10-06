// No-op polyfills for symbols the wasix-sysroot declares in <sys/mman.h> but does
// not compile into libc.a (LLVM's Unix/Memory.inc and Unix/Path.inc reference
// them). Real mmap/munmap/msync come from libwasi-emulated-mman.
#include <stddef.h>

int mprotect(void *addr, size_t len, int prot) {
  (void)addr;
  (void)len;
  (void)prot;
  return 0;
}

int posix_madvise(void *addr, size_t len, int advice) {
  (void)addr;
  (void)len;
  (void)advice;
  return 0;
}

int madvise(void *addr, size_t len, int advice) {
  (void)addr;
  (void)len;
  (void)advice;
  return 0;
}
