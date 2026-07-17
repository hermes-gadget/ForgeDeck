import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthManager } from "./auth.js";

test("AuthManager accepts the configured password and rejects another value", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-auth-"));
  const auth = new AuthManager(directory, { password: "a-secure-test-password" });
  try {
    assert.equal(auth.login("client-a", "incorrect").ok, false);
    const result = auth.login("client-a", "a-secure-test-password");
    assert.equal(result.ok, true);
    assert.ok(result.sessionId);
  } finally {
    auth.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AuthManager generates a private persistent token when no password is configured", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-token-"));
  const first = new AuthManager(directory, { enabled: true });
  let second: AuthManager | null = null;
  try {
    assert.ok(first.generatedTokenPath);
    assert.equal(fs.statSync(first.generatedTokenPath!).mode & 0o777, 0o600);
    const token = fs.readFileSync(first.generatedTokenPath!, "utf8").trim();
    second = new AuthManager(directory, { enabled: true });
    assert.equal(second.login("client-b", token).ok, true);
  } finally {
    first.close();
    second?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AuthManager permits requests without a key when authentication is disabled", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-no-auth-"));
  const auth = new AuthManager(directory, { enabled: false });
  try {
    assert.equal(auth.enabled, false);
    assert.equal(auth.generatedTokenPath, null);
    assert.equal(auth.isAuthenticated({ headers: {} } as never), true);
    assert.equal(fs.existsSync(path.join(directory, "access-token")), false);
  } finally {
    auth.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AuthManager applies secure cookies automatically for HTTPS requests", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-cookie-"));
  const auth = new AuthManager(directory, { password: "a-secure-test-password", cookieSecure: "auto" });
  try {
    let secure: boolean | undefined;
    auth.setCookie(
      { secure: true } as never,
      { cookie: (_name: string, _value: string, options: { secure?: boolean }) => { secure = options.secure; } } as never,
      "session-id"
    );
    assert.equal(secure, true);
  } finally {
    auth.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AuthManager treats malformed cookie encoding as unauthenticated", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-cookie-"));
  const auth = new AuthManager(directory, { password: "a-secure-test-password" });
  try {
    assert.equal(auth.isAuthenticated({ headers: { cookie: "forgedeck_session=%E0%A4%A" } } as never), false);
  } finally {
    auth.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AuthManager invalidates a token on logout", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-logout-"));
  const auth = new AuthManager(directory, { password: "a-secure-test-password", sessionTtlMs: 60_000 });
  try {
    const login = auth.login("client-a", "a-secure-test-password");
    assert.equal(login.ok, true);
    const request = { headers: { cookie: `forgedeck_session=${login.sessionId}` }, secure: false } as never;
    assert.equal(auth.isAuthenticated(request), true);
    let invalidated: unknown;
    auth.onSessionInvalidated((event) => { invalidated = event; });
    auth.logout(request, { clearCookie: () => undefined } as never);
    assert.equal(auth.isAuthenticated(request), false);
    assert.deepEqual(invalidated, { sessionId: login.sessionId, reason: "logout" });
  } finally {
    auth.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AuthManager gives session tokens an absolute expiry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-expiry-"));
  const auth = new AuthManager(directory, { password: "a-secure-test-password", sessionTtlMs: 25 });
  try {
    const login = auth.login("client-a", "a-secure-test-password");
    assert.equal(login.ok, true);
    const expired = new Promise((resolve) => auth.onSessionInvalidated(resolve));
    assert.deepEqual(await withTimeout(expired), { sessionId: login.sessionId, reason: "expired" });
    assert.equal(auth.isAuthenticated({ headers: { cookie: `forgedeck_session=${login.sessionId}` } } as never), false);
  } finally {
    auth.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Session did not expire")), 1_000);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

test("AuthManager caps concurrent sessions and login-attempt state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-auth-caps-"));
  const auth = new AuthManager(directory, {
    password: "a-secure-test-password",
    maxSessions: 1,
    loginMaxAttempts: 2,
    loginAttemptStateMax: 1,
    loginGlobalMaxAttempts: 10,
    loginWindowMs: 60_000
  });
  try {
    assert.equal(auth.login("session-a", "a-secure-test-password").ok, true);
    const capped = auth.login("session-b", "a-secure-test-password");
    assert.equal(capped.ok, false);
    assert.equal(capped.reason, "session_limit");

    assert.equal(auth.login("attacker-a", "wrong").reason, "invalid_credentials");
    const stateCapped = auth.login("attacker-b", "wrong");
    assert.equal(stateCapped.reason, "rate_limited");
    assert.ok(stateCapped.retryAfter);

    assert.equal(auth.login("attacker-a", "wrong").reason, "invalid_credentials");
    assert.equal(auth.login("attacker-a", "wrong").reason, "rate_limited");
  } finally {
    auth.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
