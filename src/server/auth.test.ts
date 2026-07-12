import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthManager } from "./auth.js";

test("AuthManager accepts the configured password and rejects another value", () => {
  const previous = process.env.FORGEDECK_PASSWORD;
  const previousAuth = process.env.FORGEDECK_AUTH;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-auth-"));
  delete process.env.FORGEDECK_AUTH;
  process.env.FORGEDECK_PASSWORD = "a-secure-test-password";
  try {
    const auth = new AuthManager(directory);
    assert.equal(auth.login("client-a", "incorrect").ok, false);
    const result = auth.login("client-a", "a-secure-test-password");
    assert.equal(result.ok, true);
    assert.ok(result.sessionId);
  } finally {
    if (previous === undefined) delete process.env.FORGEDECK_PASSWORD;
    else process.env.FORGEDECK_PASSWORD = previous;
    if (previousAuth === undefined) delete process.env.FORGEDECK_AUTH;
    else process.env.FORGEDECK_AUTH = previousAuth;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AuthManager generates a private persistent token when no password is configured", () => {
  const previous = process.env.FORGEDECK_PASSWORD;
  const previousAuth = process.env.FORGEDECK_AUTH;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-token-"));
  delete process.env.FORGEDECK_PASSWORD;
  delete process.env.FORGEDECK_AUTH;
  try {
    const first = new AuthManager(directory);
    assert.ok(first.generatedTokenPath);
    assert.equal(fs.statSync(first.generatedTokenPath!).mode & 0o777, 0o600);
    const token = fs.readFileSync(first.generatedTokenPath!, "utf8").trim();
    const second = new AuthManager(directory);
    assert.equal(second.login("client-b", token).ok, true);
  } finally {
    if (previous !== undefined) process.env.FORGEDECK_PASSWORD = previous;
    if (previousAuth !== undefined) process.env.FORGEDECK_AUTH = previousAuth;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AuthManager permits requests without a key when authentication is disabled", () => {
  const previous = process.env.FORGEDECK_AUTH;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-no-auth-"));
  process.env.FORGEDECK_AUTH = "off";
  try {
    const auth = new AuthManager(directory);
    assert.equal(auth.enabled, false);
    assert.equal(auth.generatedTokenPath, null);
    assert.equal(auth.isAuthenticated({ headers: {} } as never), true);
    assert.equal(fs.existsSync(path.join(directory, "access-token")), false);
  } finally {
    if (previous === undefined) delete process.env.FORGEDECK_AUTH;
    else process.env.FORGEDECK_AUTH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
