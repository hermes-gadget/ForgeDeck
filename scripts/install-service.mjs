#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(projectRoot, "build/server/index.js");
const clientEntrypoint = path.join(projectRoot, "dist/index.html");
if (!fs.existsSync(entrypoint) || !fs.existsSync(clientEntrypoint)) {
  console.error("ForgeDeck is not built. Run npm run build first.");
  process.exit(1);
}

try { process.loadEnvFile(path.join(projectRoot, ".env")); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

let codexBin;
try {
  const configured = process.env.CODEX_BIN?.trim() || "codex";
  if (path.isAbsolute(configured)) {
    fs.accessSync(configured, fs.constants.X_OK);
    codexBin = configured;
  } else {
    codexBin = execFileSync("which", [configured], { encoding: "utf8" }).trim();
  }
} catch {
  console.error("Could not find the configured Codex executable. Check CODEX_BIN or PATH.");
  process.exit(1);
}

const unitDir = path.join(os.homedir(), ".config/systemd/user");
const unitPath = path.join(unitDir, "forgedeck.service");
const runtimeUnitPath = path.join(unitDir, "forgedeck-codex.service");
const runtimeUrl = "ws://127.0.0.1:4174";
fs.mkdirSync(unitDir, { recursive: true });
const runtimeUnit = `[Unit]
Description=ForgeDeck durable Codex app-server runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdEscape(projectRoot)}
ExecStart=${systemdEscape(codexBin)} app-server --listen ${systemdEscape(runtimeUrl)}
Environment=PATH=${systemdEscape(`${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`)}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
`;
const unit = `[Unit]
Description=ForgeDeck persistent Codex web dashboard
After=network-online.target
Wants=network-online.target
Wants=forgedeck-codex.service
After=forgedeck-codex.service

[Service]
Type=simple
WorkingDirectory=${systemdEscape(projectRoot)}
ExecStart=${systemdEscape(process.execPath)} --env-file-if-exists=${systemdEscape(path.join(projectRoot, ".env"))} ${systemdEscape(entrypoint)}
Environment=NODE_ENV=production
Environment=CODEX_BIN=${systemdEscape(codexBin)}
Environment=CODEX_APP_SERVER_URL=${systemdEscape(runtimeUrl)}
Environment=PATH=${systemdEscape(`${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`)}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
fs.writeFileSync(runtimeUnitPath, runtimeUnit, { mode: 0o600 });
fs.writeFileSync(unitPath, unit, { mode: 0o600 });
execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
execFileSync("systemctl", ["--user", "enable", "--now", "forgedeck-codex.service"], { stdio: "inherit" });
execFileSync("systemctl", ["--user", "enable", "forgedeck.service"], { stdio: "inherit" });
let dashboardActive = false;
try { dashboardActive = execFileSync("systemctl", ["--user", "is-active", "forgedeck.service"], { encoding: "utf8" }).trim() === "active"; } catch { /* inactive */ }
if (!dashboardActive) execFileSync("systemctl", ["--user", "start", "forgedeck.service"], { stdio: "inherit" });
console.log(`ForgeDeck service installed at ${unitPath}`);
console.log(`Durable Codex runtime installed at ${runtimeUnitPath}`);
if (dashboardActive) console.log("ForgeDeck is already running. Restart the dashboard after its active turns finish to use the durable runtime.");
console.log("View status with: systemctl --user status forgedeck");

function systemdEscape(value) {
  return [...value].map((character) => {
    if (character === "%") return "%%";
    if (character === "\\" || character === "\"" || character === "'" || /\s/.test(character)) {
      const code = character.codePointAt(0);
      if (code <= 0xff) return `\\x${code.toString(16).padStart(2, "0")}`;
    }
    return character;
  }).join("");
}
