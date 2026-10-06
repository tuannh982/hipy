//go:build js && wasm

package wasmexec

import "unsafe"

func inputBytes(ptr, length int32) []byte {
	if length <= 0 {
		return nil
	}
	return unsafe.Slice((*byte)(unsafe.Add(unsafe.Pointer(nil), uintptr(ptr))), int(length))
}

func bytePointer(buf []byte) *byte {
	if len(buf) == 0 {
		return nil
	}
	return &buf[0]
}
