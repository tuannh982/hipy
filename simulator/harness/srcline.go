package harness

import (
	"bytes"
	"debug/dwarf"
	"debug/elf"
	"encoding/binary"
	"io"
	"sort"
	"strings"
	"sync"

	"github.com/sarchlab/mgpusim/v5/amd/insts"
)

// Source locations for a code object's instructions, from its DWARF line table. Not
// elf.File.DWARF: the browser's relocatable output leaves .debug_line unapplied.

// The AMDGPU relocation types applied here: the value is the symbol's value plus the
// addend. See llvm/include/llvm/BinaryFormat/ELFRelocs/AMDGPU.def.
const (
	relAMDGPU64 = 1
	relAMDGPU32 = 2
)

// The header MGPUSim strips from a COV2/V3 kernel before executing it, so an offset
// reported for such a kernel is this far below its symbol's address.
const coV2V3HeaderBytes = 256

// SourceLine is one resolved source location.
type SourceLine struct {
	File string
	Line int
}

// sourceTable maps a code object's ELF addresses to source lines, sorted for bisection.
type sourceTable struct {
	addresses []uint64
	lines     []SourceLine
}

// lookup returns the line covering addr. Rows are ranges, so this is the last row at
// or before addr: it searches for the first row strictly above, not at or after.
func (t *sourceTable) lookup(addr uint64) (SourceLine, bool) {
	if t == nil || len(t.addresses) == 0 {
		return SourceLine{}, false
	}
	at := sort.Search(len(t.addresses), func(i int) bool { return t.addresses[i] > addr })
	if at == 0 {
		return SourceLine{}, false
	}
	return t.lines[at-1], true
}

// codeAddress converts an offset within a kernel's instruction block into the ELF
// address of that instruction, accounting for the header MGPUSim strips.
func codeAddress(co *insts.KernelCodeObject, offset uint64) (uint64, bool) {
	if co == nil || co.Symbol == nil || co.Symbol.Section == elf.SHN_UNDEF {
		return 0, false
	}
	header := uint64(0)
	if co.Version != insts.CodeObjectV5 {
		header = coV2V3HeaderBytes
	}
	return co.Symbol.Value + header + offset, true
}

// The DWARF sections dwarf.New wants. Missing ones are passed as nil, which it tolerates.
func dwarfSections(f *elf.File) map[string][]byte {
	out := make(map[string][]byte)
	for _, name := range []string{
		".debug_abbrev", ".debug_aranges", ".debug_frame", ".debug_info",
		".debug_line", ".debug_pubnames", ".debug_ranges", ".debug_str",
		".debug_addr", ".debug_line_str", ".debug_loclists", ".debug_rnglists",
		".debug_str_offsets",
	} {
		if section := f.Section(name); section != nil {
			if data, err := section.Data(); err == nil {
				out[name] = data
			}
		}
	}
	return out
}

// applyDebugLineRelocations writes each .rela.debug_line addend into .debug_line.
// Unknown relocation types are left alone: a half-applied table is worse than none.
func applyDebugLineRelocations(f *elf.File, sections map[string][]byte) {
	line := f.Section(".debug_line")
	if line == nil {
		return
	}
	lineIndex := -1
	for i, section := range f.Sections {
		if section == line {
			lineIndex = i
		}
	}
	if lineIndex < 0 {
		return
	}
	symbols, err := f.Symbols()
	if err != nil {
		return
	}
	lineData := sections[".debug_line"]
	for _, section := range f.Sections {
		if section.Type != elf.SHT_RELA || int(section.Info) != lineIndex {
			continue
		}
		data, err := section.Data()
		if err != nil {
			return
		}
		for offset := 0; offset+24 <= len(data); offset += 24 {
			where := binary.LittleEndian.Uint64(data[offset:])
			info := binary.LittleEndian.Uint64(data[offset+8:])
			addend := int64(binary.LittleEndian.Uint64(data[offset+16:]))
			symbolIndex := info >> 32
			kind := info & 0xffffffff

			var width int
			switch kind {
			case relAMDGPU64:
				width = 8
			case relAMDGPU32:
				width = 4
			default:
				// R_AMDGPU_64_NONE carries no symbol and needs no width.
				continue
			}
			if where+uint64(width) > uint64(len(lineData)) {
				continue
			}
			value := addend
			if int(symbolIndex) < len(symbols) {
				value += int64(symbols[symbolIndex].Value)
			}
			if width == 8 {
				binary.LittleEndian.PutUint64(lineData[where:], uint64(value))
			} else {
				binary.LittleEndian.PutUint32(lineData[where:], uint32(value))
			}
		}
	}
}

// buildSourceTable reads a code object's line table into a sorted address table. A
// nil table with false ok means the object carries no usable debug info, which is normal.
func buildSourceTable(elfBytes []byte) (*sourceTable, bool) {
	if len(elfBytes) == 0 {
		return nil, false
	}
	file, err := elf.NewFile(bytes.NewReader(elfBytes))
	if err != nil {
		return nil, false
	}
	sections := dwarfSections(file)
	if len(sections[".debug_line"]) == 0 {
		return nil, false
	}
	applyDebugLineRelocations(file, sections)

	data, err := dwarf.New(
		sections[".debug_abbrev"], sections[".debug_aranges"], sections[".debug_frame"],
		sections[".debug_info"], sections[".debug_line"], sections[".debug_pubnames"],
		sections[".debug_ranges"], sections[".debug_str"],
	)
	if err != nil {
		return nil, false
	}
	for _, name := range []string{
		".debug_addr", ".debug_line_str", ".debug_loclists", ".debug_rnglists",
		".debug_str_offsets",
	} {
		if err := data.AddSection(name, sections[name]); err != nil {
			return nil, false
		}
	}

	table := &sourceTable{}
	reader := data.Reader()
	for {
		entry, err := reader.Next()
		if err != nil || entry == nil {
			break
		}
		if entry.Tag != dwarf.TagCompileUnit {
			continue
		}
		table.addUnit(data, entry)
		reader.SkipChildren()
	}
	if len(table.addresses) == 0 {
		return nil, false
	}
	sort.Sort(table)
	// Every row at address 0 means the relocations were never applied, so a lookup would
	// answer confidently and wrongly. Refuse the table.
	if table.addresses[len(table.addresses)-1] == 0 {
		return nil, false
	}
	return table, true
}

// addUnit appends one compilation unit's line rows, dropping rows that carry no
// location: end_sequence closes a sequence rather than naming a line.
func (t *sourceTable) addUnit(data *dwarf.Data, unit *dwarf.Entry) {
	lines, err := data.LineReader(unit)
	if err != nil || lines == nil {
		return
	}
	for {
		var row dwarf.LineEntry
		if err := lines.Next(&row); err != nil {
			// Any error ends this unit; the rows already collected stand.
			if err != io.EOF {
				return
			}
			return
		}
		// An address of 0 is kept: it is the first instruction of a kernel whose symbol
		// sits at the start of .text. buildSourceTable refuses a table where every
		// address is 0.
		if row.EndSequence || row.Line <= 0 || row.File == nil {
			continue
		}
		t.addresses = append(t.addresses, row.Address)
		t.lines = append(t.lines, SourceLine{File: row.File.Name, Line: row.Line})
	}
}

// Len implements sort.Interface.
func (t *sourceTable) Len() int { return len(t.addresses) }

// Less implements sort.Interface. The address is the whole key.
func (t *sourceTable) Less(i, j int) bool { return t.addresses[i] < t.addresses[j] }

// Swap implements sort.Interface.
func (t *sourceTable) Swap(i, j int) {
	t.addresses[i], t.addresses[j] = t.addresses[j], t.addresses[i]
	t.lines[i], t.lines[j] = t.lines[j], t.lines[i]
}

// basename trims a recorded file name to its last path element: the line table records
// the path as the compiler saw it, which is a sandbox path the reader cannot resolve.
func basename(path string) string {
	trimmed := strings.TrimRight(path, `/\`)
	if index := strings.LastIndexAny(trimmed, `/\`); index >= 0 {
		return trimmed[index+1:]
	}
	return trimmed
}

// sourceTables caches one line table per loaded code object. LoadCodeObject replaces
// the bytes and clears it rather than keying it.
type sourceCache struct {
	once  sync.Once
	table *sourceTable
	ok    bool
}

// resolveSource attaches the source location of each pattern's PC, called from the LDS
// drain because that is the first moment a PC is known.
func (h *Harness) resolveSource(report *LdsAnalysisReport) {
	table := h.sourceTables()
	if table == nil || h.codeObject == nil {
		return
	}
	// A PC from a build whose emulator patch is absent is a device address, orders of
	// magnitude past the end of the code, so refuse anything outside the block.
	span := uint64(len(h.codeObject.Data))
	for i := range report.Patterns {
		pattern := &report.Patterns[i]
		if pattern.PC >= span {
			continue
		}
		address, ok := codeAddress(h.codeObject, pattern.PC)
		if !ok {
			continue
		}
		line, ok := table.lookup(address)
		if !ok {
			continue
		}
		pattern.SourceFile = basename(line.File)
		pattern.SourceLine = line.Line
	}
}

// sourceTables reads the line table of the loaded code object once per ELF.
func (h *Harness) sourceTables() *sourceTable {
	h.sourceOnce.Do(func() {
		h.source.table, h.source.ok = buildSourceTable(h.elfBytes)
	})
	if !h.source.ok {
		return nil
	}
	return h.source.table
}
