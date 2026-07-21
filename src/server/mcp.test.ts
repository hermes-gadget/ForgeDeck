import assert from "node:assert/strict";
import test from "node:test";
import { runMcpTransport } from "./mcp.js";

test("MCP transport entrypoint can be imported without opening stdio", () => {
  assert.equal(typeof runMcpTransport, "function");
});
