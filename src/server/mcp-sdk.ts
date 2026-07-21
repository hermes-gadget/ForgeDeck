// Keep the beta MCP SDK surface isolated so an SDK upgrade only changes this boundary.
export { InMemoryTransport, LATEST_PROTOCOL_VERSION, McpServer } from "@modelcontextprotocol/server";
export { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
