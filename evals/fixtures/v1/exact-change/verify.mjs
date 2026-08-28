import { readFileSync } from "node:fs";

const ok = readFileSync("src/value.txt", "utf8") === "DONE\n";
process.stdout.write(`${JSON.stringify({ schemaVersion: "1", ok, checks: { valueUpdated: ok } })}\n`);
process.exitCode = ok ? 0 : 1;
