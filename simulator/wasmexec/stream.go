//go:build js && wasm

package wasmexec

import (
	"unsafe"

	"hipy/simulator/harness"
)

// pushMetrics is the live gauge stream: a few hundred bytes of JSON, several
// times a second, while the kernel is still running.
//
// It is an IMPORT, so it must be on the import object at instantiation and
// before go.run() begins: wasm resolves imports at instantiation, so a missing one
// is a hard failure there rather than a nil call later.
//
// The callback must copy anything it intends to keep, since the Go slice is
// collected as soon as this returns.
//
//go:wasmimport env pushMetrics
func pushMetrics(ptr, length int32)

// installStream points the harness's live stream at this import. Called from Run,
// because the sink is a package variable in package harness and only this layer may
// reach JavaScript.
func installStream() {
	harness.MetricsSink = func(payload []byte) {
		// int32(uintptr(...)) rather than a pointer: //go:wasmimport lowers its
		// parameters to i32, and the address is a Go pointer that has to cross as
		// a number. Same shape as every pointer this package hands back over an
		// export.
		pushMetrics(int32(uintptr(unsafe.Pointer(&payload[0]))), int32(len(payload)))
	}
}
