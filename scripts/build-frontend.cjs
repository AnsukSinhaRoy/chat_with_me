const { spawnSync } = require("node:child_process");
const path = require("node:path");

const frontendDir = path.join(__dirname, "..", "frontend");
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("npm_")) delete env[key];
}
env.NEXT_TELEMETRY_DISABLED = "1";
env.NEXT_PRIVATE_BUILD_WORKER = "0";

const result = spawnSync(
  process.execPath,
  ["./node_modules/next/dist/bin/next", "build", "--turbopack"],
  { cwd: frontendDir, stdio: "inherit", env },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
