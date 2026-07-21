import crypto from "node:crypto";

export type JsonRevision = { body: string; etag: string };

/** Serialize once and derive a stable strong validator for a JSON resource. */
export function jsonRevision(value: unknown): JsonRevision {
  const body = JSON.stringify(value);
  const digest = crypto.createHash("sha256").update(body).digest("base64url");
  return { body, etag: `"${digest}"` };
}

/** Match strong or weak If-None-Match validators, including comma-separated values. */
export function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const normalizedEtag = etag.replace(/^W\//, "");
  return (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate.replace(/^W\//, "") === normalizedEtag);
}
