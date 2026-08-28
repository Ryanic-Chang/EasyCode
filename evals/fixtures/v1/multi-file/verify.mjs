import { readFileSync } from "node:fs";

const calc = readFileSync("src/calc.ts", "utf8");
const format = readFileSync("src/format.ts", "utf8");
const checks = {
  calculationFixed: calc.includes("return left + right;"),
  unrelatedFileUntouched:
    format === "export function format(value: number): string {\n  return `result=$" + "{value}`;\n}\n",
};
const ok = Object.values(checks).every(Boolean);
process.stdout.write(`${JSON.stringify({ schemaVersion: "1", ok, checks })}\n`);
process.exitCode = ok ? 0 : 1;
