import { Composition } from "remotion";
import { BankViz } from "./BankViz";

// The bank formula is stated once per frame, not once per thread: WORD_SIZE = 4 bytes
// per bank word, N_BANKS = 32 banks, so bank = (byte address / 4) mod 32.
const FORMULA = "Bank = (byte address / WORD_SIZE) mod N_BANKS,  WORD_SIZE = 4,  N_BANKS = 32";

// A 32-wide tile: reading down a column steps 32 floats = 128 bytes = one whole
// bank row, so every lane of the phase wants the same bank.
const conflictAccesses = Array.from({ length: 8 }).map((_, r) => ({
  t: r,
  bank: 0,
  text: `Thread ${r}: tile[${r}][0] @byte ${r * 128} → bank 0`,
}));

// One extra float per row: row r now starts at word 33 * r, and 33 * r mod 32 = r.
const noConflictAccesses = Array.from({ length: 8 }).map((_, r) => ({
  t: r,
  bank: r,
  text: `Thread ${r}: tile[${r}][0] @byte ${r * 132} → bank ${r}`,
}));

const sameAddressAccesses = Array.from({ length: 8 }).map((_, i) => ({
  t: i,
  bank: 0,
  text: `Thread ${i}: tile[0][0] @byte 0 → bank 0`,
}));

export const RemotionRoot = () => (
  <>
    <Composition id="BankConflict" component={BankViz} durationInFrames={120} fps={30} width={640} height={360}
      defaultProps={{ title: "Bank Conflict", dataShape: "float tile[32][32], address = row*32 + col", code: "out[y*w+x] = tile[x][y]", formula: FORMULA, accesses: conflictAccesses, banks: [0], conflictBanks: [0] }} />
    <Composition id="BankNoConflict" component={BankViz} durationInFrames={120} fps={30} width={640} height={360}
      defaultProps={{ title: "No Bank Conflict", dataShape: "float tile[32][33] (padded), address = row*33 + col", code: "out[y*w+x] = tile[x][y]", formula: FORMULA, accesses: noConflictAccesses, banks: [0, 1, 2, 3, 4, 5, 6, 7], conflictBanks: [] }} />
    <Composition id="BankSameAddress" component={BankViz} durationInFrames={120} fps={30} width={640} height={360}
      defaultProps={{ title: "Same Address (no conflict)", dataShape: "float tile[32][32], all read tile[0][0]", code: "x = tile[0][0];", formula: FORMULA, accesses: sameAddressAccesses, banks: [0], conflictBanks: [] }} />
  </>
);
