import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const comps = [
  { id: "BankConflict", out: "out/bank-conflict/bank-conflict.mp4" },
  { id: "BankNoConflict", out: "out/bank-conflict/bank-no-conflict.mp4" },
  { id: "BankSameAddress", out: "out/bank-conflict/bank-same-address.mp4" },
];

mkdirSync("out/bank-conflict", { recursive: true });
for (const c of comps) {
  console.log("Rendering", c.id);
  execSync(`npx remotion render src/index.tsx ${c.id} ${c.out}`, { stdio: "inherit" });
}
