//go:build js && wasm

package main

import "hipy/simulator/wasmexec"

func main() {
	wasmexec.Run()
}
