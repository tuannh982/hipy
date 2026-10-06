//go:build !js

// Command instdump decodes a kernel out of an AMDGCN code object and prints it as a
// readable instruction stream, with each instruction's raw first and second words.
//
// It is a diagnosis tool, not part of the simulator: the playground never runs it.
// It exists for faults where every mnemonic decodes correctly and the answer is
// still wrong, which reading clang's assembly against MGPUSim's decode of the same
// word finds in one pass. Excluded from the js/wasm build for that reason.
//
// Usage:
//
//	instdump <device.co> <kernel> [arch]
//
// <kernel> is the unmangled symbol, e.g. movB64 or vectorAdd; an empty name asks
// MGPUSim to auto-detect, which only works for a single-kernel object. <arch> is
// advisory and only labels the output, which is otherwise identical for a given
// code object.
package main

import (
	"fmt"
	"os"
	"strconv"

	"github.com/sarchlab/mgpusim/v5/amd/insts"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: instdump <device.co> <kernel> [arch]")
		os.Exit(2)
	}
	path, kernel := os.Args[1], os.Args[2]
	arch := ""
	if len(os.Args) > 3 {
		arch = os.Args[3]
	}
	if arch == "" {
		arch = "unknown"
	}

	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "instdump: %v\n", err)
		os.Exit(1)
	}
	co := insts.LoadKernelCodeObjectFromBytes(data, kernel)
	d := insts.NewDisassembler()
	fmt.Printf("file=%s arch=%s kernel=%s v5=%v dataLen=%d\n", path, arch, kernel, co.Version == insts.CodeObjectV5, len(co.Data))
	// Instructions are 4 or 8 bytes depending on format, so advance by the
	// size the decoder reports rather than assuming a fixed width.
	for off := 0; off < len(co.Data); {
		end := off + 8
		if end > len(co.Data) {
			end = len(co.Data)
		}
		word := co.Data[off:end]
		inst, err := d.Decode(word)
		if err != nil {
			fmt.Printf("%04x  %-28s <decode error: %v>\n", off, "?", err)
			off += 8
			continue
		}
		name := ""
		if inst.InstType != nil {
			name = inst.InstType.InstName
		}
		lo := uint32(word[0]) | uint32(word[1])<<8 | uint32(word[2])<<16 | uint32(word[3])<<24
		hi := uint32(0)
		if len(word) >= 8 {
			hi = uint32(word[4]) | uint32(word[5])<<8 | uint32(word[6])<<16 | uint32(word[7])<<24
		}
		// DS and FLAT keep their operands in Addr/Data/Data1 and Base/Offset rather
		// than Src0/Src1, so print whichever set this format actually uses.
		src0, src1 := regStr(inst.Src0), regStr(inst.Src1)
		if inst.FormatType == insts.DS {
			src0, src1 = regStr(inst.Addr), regStr(inst.Data)
		} else if inst.FormatType == insts.FLAT {
			src0, src1 = regStr(inst.Base), regStr(inst.Offset)
		}
		fmt.Printf("%04x lo=%08x hi=%08x %-24s fmt=%d op=%s dst=%-8v src0=%-10v src1=%-8v dstw=%-3d src0w=%-3d\n",
			off, lo, hi, name, inst.FormatType, opcode(inst.Opcode), regStr(inst.Dst), src0, src1,
			inst.DSTWidth, inst.SRC0Width)
		if inst.ByteSize <= 0 {
			off += 8
		} else {
			off += inst.ByteSize
		}
	}
}

// opcode prints the opcode as a number, the field a decode-table entry is keyed on.
// The widths printed beside it decide two instructions that share an opcode, as
// V_mov_b64 and V_movrelsd_b32 do.
func opcode(op insts.Opcode) string {
	return strconv.Itoa(int(op))
}

func regStr(o *insts.Operand) string {
	if o == nil {
		return "-"
	}
	return o.String()
}
