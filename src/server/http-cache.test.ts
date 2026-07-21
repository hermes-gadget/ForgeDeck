import assert from "node:assert/strict";
import test from "node:test";
import { jsonRevision, matchesIfNoneMatch } from "./http-cache.js";

test("JSON revisions are stable for unchanged payloads and change with content", () => {
  const first = jsonRevision({ usage: 12, available: true });
  const repeated = jsonRevision({ usage: 12, available: true });
  const changed = jsonRevision({ usage: 13, available: true });

  assert.equal(first.body, repeated.body);
  assert.equal(first.etag, repeated.etag);
  assert.notEqual(first.etag, changed.etag);
});

test("If-None-Match accepts lists, weak validators, and wildcards", () => {
  const etag = jsonRevision({ revision: 1 }).etag;
  assert.equal(matchesIfNoneMatch(etag, etag), true);
  assert.equal(matchesIfNoneMatch(`"old", W/${etag}`, etag), true);
  assert.equal(matchesIfNoneMatch("*", etag), true);
  assert.equal(matchesIfNoneMatch('"different"', etag), false);
});
