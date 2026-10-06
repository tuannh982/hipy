#pragma once
#include_next <fcntl.h>

// Values 5/7/8 are the Linux/musl lock numbers LLVM's Path.inc expects; the
// wasix-sysroot exposes only the F_*64 aliases (12/13/14) in a disabled branch.
#ifndef F_GETLK
#define F_GETLK 5
#endif
#ifndef F_SETLK
#define F_SETLK 7
#endif
#ifndef F_SETLKW
#define F_SETLKW 8
#endif
#ifndef F_RDLCK
#define F_RDLCK 0
#endif
#ifndef F_WRLCK
#define F_WRLCK 1
#endif
#ifndef F_UNLCK
#define F_UNLCK 2
#endif
