import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderConfigReferenceMarkdown } from "../src/server/config.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const output = path.join(projectRoot, "docs", "CONFIGURATION.md");
fs.writeFileSync(output, renderConfigReferenceMarkdown(), "utf8");
