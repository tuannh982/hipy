import { Composition } from "remotion";
import { BankViz } from "./BankViz";

const conflictAccesses = [
  { t: 0, bank: 0, text: "Thread 0 accesses tile[0][0], bank 0" },
  { t: 1, bank: 16, text: "Thread 1 accesses tile[1][0], bank 16" },
  { t: 2, bank: 0, text: "Thread 2 accesses tile[2][0], bank 0" },
  { t: 3, bank: 16, text: "Thread 3 accesses tile[3][0], bank 16" },
  { t: 4, bank: 0, text: "Thread 4 accesses tile[4][0], bank 0" },
  { t: 5, bank: 16, text: "Thread 5 accesses tile[5][0], bank 16" },
  { t: 6, bank: 0, text: "Thread 6 accesses tile[6][0], bank 0" },
  { t: 7, bank: 16, text: "Thread 7 accesses tile[7][0], bank 16" },
];

const noConflictAccesses = [
  { t: 0, bank: 0, text: "Thread 0 accesses tile[0][0], bank (0*17+0)%32 = 0" },
  { t: 1, bank: 17, text: "Thread 1 accesses tile[1][0], bank (1*17+0)%32 = 17" },
  { t: 2, bank: 2, text: "Thread 2 accesses tile[2][0], bank (2*17+0)%32 = 2" },
  { t: 3, bank: 19, text: "Thread 3 accesses tile[3][0], bank (3*17+0)%32 = 19" },
  { t: 4, bank: 4, text: "Thread 4 accesses tile[4][0], bank (4*17+0)%32 = 4" },
  { t: 5, bank: 21, text: "Thread 5 accesses tile[5][0], bank (5*17+0)%32 = 21" },
  { t: 6, bank: 6, text: "Thread 6 accesses tile[6][0], bank (6*17+0)%32 = 6" },
  { t: 7, bank: 23, text: "Thread 7 accesses tile[7][0], bank (7*17+0)%32 = 23" },
];

const sameAddressAccesses = Array.from({ length: 8 }).map((_, i) => ({ t: i, bank: 0, text: `Thread ${i} accesses tile[0][0], bank 0 (same address)` }));

export const RemotionRoot = () => (
  <>
    <Composition id="BankConflict" component={BankViz} durationInFrames={120} fps={30} width={640} height={360}
      defaultProps={{ title: "Bank Conflict", dataShape: "float tile[16][16], address = row*16 + col", code: "out[x*w+y] = tile[y][x]", accesses: conflictAccesses, banks: [0, 16], conflictBanks: [0, 16] }} />
    <Composition id="BankNoConflict" component={BankViz} durationInFrames={120} fps={30} width={640} height={360}
      defaultProps={{ title: "No Bank Conflict", dataShape: "float tile[16][17] (padded), address = row*17 + col", code: "out[x*w+y] = tile[y][x]", accesses: noConflictAccesses, banks: [0, 17, 2, 19, 4, 21, 6, 23], conflictBanks: [] }} />
    <Composition id="BankSameAddress" component={BankViz} durationInFrames={120} fps={30} width={640} height={360}
      defaultProps={{ title: "Same Address (no conflict)", dataShape: "float tile[16][16], all read tile[0][0]", code: "x = tile[0][0];", accesses: sameAddressAccesses, banks: [0], conflictBanks: [] }} />
  </>
);