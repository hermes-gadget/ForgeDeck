import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ForgeDeckApi, ForgeDeckApiError } from "./mcp-client.js";

test("MCP client reuses a scoped credential and recovers a stale token", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-mcp-client-"));
  const bootstrapTokenFile = path.join(directory, "mcp-token");
  fs.writeFileSync(bootstrapTokenFile, "bootstrap-secret\n", { mode: 0o600 });
  let registrations = 0;
  let currentToken = "";
  const actorId = "11111111-1111-4111-8111-111111111111";
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/api/mcp/actors" && init?.method === "POST") {
      assert.equal(authorization, "Bearer bootstrap-secret");
      assert.deepEqual(JSON.parse(String(init.body)), { clientId: "test-client" });
      registrations += 1;
      currentToken = `actor-token-${registrations}`;
      return jsonResponse(201, {
        actorId,
        token: currentToken,
        credentialIssuedAt: 1_000,
        credentialExpiresAt: 100_000
      });
    }
    if (url.pathname === "/api/mcp/owned-threads") {
      return authorization === `Bearer ${currentToken}`
        ? jsonResponse(200, { actorId, data: ["owned-thread"] })
        : jsonResponse(401, { error: "expired" });
    }
    throw new Error(`Unexpected test request ${init?.method || "GET"} ${url.pathname}`);
  };

  try {
    const first = new ForgeDeckApi("http://127.0.0.1:4173", bootstrapTokenFile, {
      clientId: "test-client",
      fetch: fakeFetch,
      now: () => 2_000
    });
    assert.deepEqual(await first.get("/api/mcp/owned-threads"), { actorId, data: ["owned-thread"] });
    assert.equal(registrations, 1);
    assert.equal(fs.statSync(first.actorCredentialPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(first.actorCredentialPath)).mode & 0o777, 0o700);

    const restarted = new ForgeDeckApi("http://127.0.0.1:4173", bootstrapTokenFile, {
      clientId: "test-client",
      fetch: fakeFetch,
      now: () => 2_000
    });
    assert.equal(restarted.actorCredentialPath, first.actorCredentialPath);
    assert.deepEqual(await restarted.get("/api/mcp/owned-threads"), { actorId, data: ["owned-thread"] });
    assert.equal(registrations, 1, "normal stdio restart does not mint a replacement actor");

    currentToken = "server-invalidated-token";
    assert.deepEqual(await restarted.request("/api/mcp/owned-threads"), { actorId, data: ["owned-thread"] });
    assert.equal(registrations, 2, "401 recovery refreshes through the installation bootstrap token");
    const persisted = JSON.parse(fs.readFileSync(restarted.actorCredentialPath, "utf8")) as { actorId: string; token: string };
    assert.equal(persisted.actorId, actorId);
    assert.equal(persisted.token, "actor-token-2");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP client rejects responses that violate the shared HTTP contract", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-mcp-contract-"));
  const bootstrapTokenFile = path.join(directory, "mcp-token");
  fs.writeFileSync(bootstrapTokenFile, "bootstrap-secret\n", { mode: 0o600 });
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.pathname === "/api/mcp/actors") {
      return jsonResponse(201, {
        actorId: "11111111-1111-4111-8111-111111111111",
        token: "actor-token",
        credentialIssuedAt: 1_000,
        credentialExpiresAt: 100_000
      });
    }
    assert.equal(init?.method, "GET");
    return jsonResponse(200, { thread: { id: 123 } });
  };

  try {
    const api = new ForgeDeckApi("http://127.0.0.1:4173", bootstrapTokenFile, {
      clientId: "contract-test",
      fetch: fakeFetch,
      now: () => 2_000
    });
    await assert.rejects(
      () => api.get("/api/threads/thread-12345678"),
      (error: unknown) => error instanceof ForgeDeckApiError && error.code === "INVALID_RESPONSE_CONTRACT"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
