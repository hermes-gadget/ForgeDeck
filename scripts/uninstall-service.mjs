#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const unitPath = path.join(os.homedir(), ".config/systemd/user/forgedeck.service");
try { execFileSync("systemctl", ["--user", "disable", "--now", "forgedeck.service"], { stdio: "inherit" }); } catch { /* already stopped */ }
if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath);
execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
console.log("ForgeDeck service removed. Project data and Codex sessions were kept.");
