import { readFileSync } from "node:fs";

const [file, startArg, endArg] = process.argv.slice(2);
const lines = readFileSync(file!, "utf8").split(/\r?\n/);
const start = Math.max(1, Number(startArg ?? 1));
const end = Math.min(lines.length, Number(endArg ?? lines.length));
for (let i = start; i <= end; i++) {
  console.log(String(i).padStart(5) + "|" + lines[i - 1]);
}
