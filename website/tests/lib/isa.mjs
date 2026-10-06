// Just enough of an AMDGCN code object to check that one instruction is in it.
//
// This exists because a fixture can depend on a compiler decision without failing
// when that decision changes. website/tests/fixtures/cdna3-mov-b64.cu needs clang to
// emit `v_mov_b64_e32 v[0:1], v[2:3]` for the pair copy; a clang that coalesced the
// wide copy into two 32-bit moves would emit a program that computes the right
// answer, so the test would go on passing while testing nothing. The dependency has
// to be checked on the emitted bytes rather than noted in the fixture's header.
//
// The encoding is read off MGPUSim's own decoder (amd/insts/format.go and
// disassembler.go's decodeVOP1), not off a mnemonic: VOP1 is Encoding 0x7E000000
// under Mask 0xFE000000, with the opcode in bits 16..9, the source operand in bits
// 8..0 (256 or above meaning a VGPR, below that a literal constant) and the
// destination in bits 24..17. The project's own disassembler is
// simulator/cmd/instdump, which is the tool to reach for when a word's meaning is in
// question; this is the narrower check a test needs on every run.

/** The bytes of the code object's .text section, or throws if there is not one. */
export function codeObjectText(co) {
  const bytes = Buffer.isBuffer(co) ? new Uint8Array(co.buffer, co.byteOffset, co.byteLength) : new Uint8Array(co);
  if (bytes.length < 64 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new Error("not an ELF file");
  }
  if (bytes[4] !== 2) throw new Error(`ELF class ${bytes[4]} is not the 64-bit form a device code object uses`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shoff = Number(view.getBigUint64(0x28, true));
  const shentsize = view.getUint16(0x3a, true);
  const shnum = view.getUint16(0x3c, true);
  const shstrndx = view.getUint16(0x3e, true);
  if (shoff === 0 || shnum === 0) throw new Error("the code object has no section headers, so its code cannot be located");
  const header = (index) => {
    const at = shoff + index * shentsize;
    return {
      nameOffset: view.getUint32(at, true),
      offset: Number(view.getBigUint64(at + 0x18, true)),
      size: Number(view.getBigUint64(at + 0x20, true)),
    };
  };
  const names = header(shstrndx);
  const name = (section) => {
    let end = names.offset + section.nameOffset;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return Buffer.from(bytes.subarray(names.offset + section.nameOffset, end)).toString();
  };
  for (let index = 0; index < shnum; index++) {
    const section = header(index);
    if (name(section) === ".text") return bytes.subarray(section.offset, section.offset + section.size);
  }
  throw new Error("the code object has no .text section");
}

const VOP1_ENCODING = 0x7e000000;
const VOP1_MASK = 0xfe000000;

/**
 * How many VOP1 opcode-56 words in `text` copy a VGPR pair.
 *
 * Opcode 56 is two instructions on different ISAs -- v_movrelsd_b32, a DS-relative
 * store, on gfx9, and v_mov_b64, a register move, on gfx940+, which is where LLVM
 * gates it -- and MGPUSim's decode table resolves it as v_mov_b64, so on gfx942 the
 * word cannot mean anything else. Bit 8 of the source operand separates the two
 * forms the fixture produces: a move that zeroes a register has a literal there, and
 * only the copy under test reads a VGPR.
 */
export function vop1Opcode56Copies(text) {
  const view = new DataView(text.buffer, text.byteOffset, text.byteLength);
  let copies = 0;
  for (let offset = 0; offset + 4 <= text.length; offset += 4) {
    const word = view.getUint32(offset, true);
    if ((word & VOP1_MASK) !== VOP1_ENCODING) continue;
    if (((word >>> 9) & 0xff) !== 56) continue;
    if ((word & 0x100) !== 0) copies++;
  }
  return copies;
}