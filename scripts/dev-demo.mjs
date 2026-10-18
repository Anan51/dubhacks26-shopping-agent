import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "src/server.ts"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, WAITMATE_DEMO: "1" },
});
child.on("exit", (code) => {
  process.exit(code ?? 1);
});
