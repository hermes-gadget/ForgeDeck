#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(projectRoot, "build/server/index.js");
if (!fs.existsSync(entrypoint)) {
  console.error("ForgeDeck is not built. Run npm run build first.");
  process.exit(1);
}

let codexBin;
try {
  codexBin = execFileSync("bash", ["-lc", "command -v codex"], { encoding: "utf8" }).trim();
} catch {
  console.error("Could not find the codex executable on PATH.");
  process.exit(1);
}

const unitDir = path.join(os.homedir(), ".config/systemd/user");
const unitPath = path.join(unitDir, "forgedeck.service");
fs.mkdirSync(unitDir, { recursive: true });
const unit = `[Unit]
Description=ForgeDeck persistent Codex web dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdEscape(projectRoot)}
ExecStart=${systemdEscape(process.execPath)} --env-file-if-exists=${systemdEscape(path.join(projectRoot, ".env"))} ${systemdEscape(entrypoint)}
Environment=NODE_ENV=production
Environment=CODEX_BIN=${systemdEscape(codexBin)}
Environment=PATH=${systemdEscape(`${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`)}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
`;
fs.writeFileSync(unitPath, unit, { mode: 0o600 });
execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
execFileSync("systemctl", ["--user", "enable", "--now", "forgedeck.service"], { stdio: "inherit" });
console.log(`ForgeDeck service installed at ${unitPath}`);
console.log("View status with: systemctl --user status forgedeck");

function systemdEscape(value) {
  return value.replaceAll("%", "%%").replaceAll(" ", "\\x20");
}
