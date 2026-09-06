import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("./src", import.meta.url));

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findTests(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  }));
  return nested.flat();
}

const tests = (await findTests(sourceRoot)).sort();
if (tests.length === 0) {
  throw new Error("No test files were found under artifacts/api-server/src");
}

console.log(`Executing ${tests.length} test files`);
const child = spawn(process.execPath, ["--import", "tsx/esm", "--test", ...tests], {
  stdio: "inherit",
});
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});
