import path from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeDeckApi } from "./mcp-client.js";
import { StdioServerTransport } from "./mcp-sdk.js";
import { createForgeDeckMcpServer, DEFAULT_LIST_SESSIONS_TTL_MS } from "./mcp-tools.js";
import { loadConfig, readProcessEnvironment } from "./config.js";

const modulePath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(modulePath), "../..");

/** Wires production dependencies and connects the MCP server to stdio. */
export async function runMcpTransport(): Promise<void> {
  const config = loadConfig(projectRoot, readProcessEnvironment());
  const api = new ForgeDeckApi(config.mcpBaseUrl, config.mcpTokenFile, { clientId: config.mcpClientId });
  const server = createForgeDeckMcpServer(api, {
    listSessionsCacheTtlMs: DEFAULT_LIST_SESSIONS_TTL_MS,
    mutationMaxConcurrency: config.operationMutationConcurrency
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) await runMcpTransport();
