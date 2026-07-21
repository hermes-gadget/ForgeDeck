import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseHttpResponse } from "../shared/contracts.js";
import { logger } from "./logger.js";

type JsonObject = Record<string, unknown>;

export const MCP_API_TIMEOUT_MS = 45_000;
export const MCP_HEALTH_TIMEOUT_MS = 10_000;

type Actor = {
  actorId: string;
  token: string;
  credentialIssuedAt: number;
  credentialExpiresAt: number;
};

type StoredActorCredential = Actor & {
  version: 1;
  installation: string;
  clientId: string;
};

export type ForgeDeckRequestOptions = {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  idempotencyKey?: string;
};

export interface ForgeDeckApiClient {
  get<T>(endpoint: string): Promise<T>;
  request<T = unknown>(endpoint: string, options?: ForgeDeckRequestOptions): Promise<T>;
}

export type ForgeDeckApiOptions = {
  clientId?: string;
  credentialFile?: string;
  refreshBeforeMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
};

/** Authenticated, contract-validating client for the ForgeDeck HTTP API. */
export class ForgeDeckApi implements ForgeDeckApiClient {
  private actorPromise: Promise<Actor> | null = null;
  private recoveryPromise: Promise<Actor> | null = null;
  private currentActor: Actor | null = null;
  private readonly inFlightGets = new Map<string, Promise<unknown>>();
  private readonly url: URL;
  private readonly installation: string;
  private readonly clientId: string;
  private readonly refreshBeforeMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  readonly actorCredentialPath: string;

  constructor(url: string, private readonly bootstrapTokenFile: string, options: ForgeDeckApiOptions = {}) {
    this.url = new URL(url.endsWith("/") ? url : `${url}/`);
    this.installation = this.url.toString();
    this.clientId = options.clientId || "forgedeck-stdio";
    if (!validMcpClientId(this.clientId)) throw new Error("FORGEDECK_MCP_CLIENT_ID must contain 1-128 letters, numbers, dots, colons, underscores, or hyphens");
    this.refreshBeforeMs = options.refreshBeforeMs ?? 5 * 60_000;
    if (!Number.isFinite(this.refreshBeforeMs) || this.refreshBeforeMs < 0) throw new RangeError("MCP credential refresh window must not be negative");
    this.fetchFn = options.fetch || fetch;
    this.now = options.now || Date.now;
    this.actorCredentialPath = options.credentialFile || defaultActorCredentialPath(bootstrapTokenFile, this.installation, this.clientId);
  }

  get<T>(endpoint: string): Promise<T> {
    const existing = this.inFlightGets.get(endpoint);
    if (existing) return existing as Promise<T>;
    let request: Promise<T>;
    // The promise is referenced by its own cleanup callback, so it cannot be a const initializer.
    // eslint-disable-next-line prefer-const
    request = this.request<T>(endpoint).finally(() => {
      if (this.inFlightGets.get(endpoint) === request) this.inFlightGets.delete(endpoint);
    });
    this.inFlightGets.set(endpoint, request);
    return request;
  }

  async request<T = unknown>(endpoint: string, options: ForgeDeckRequestOptions = {}): Promise<T> {
    let actor = await this.ensureActor();
    const requestUrl = new URL(endpoint.replace(/^\//, ""), this.url);
    const timeoutMs = options.timeoutMs ?? MCP_API_TIMEOUT_MS;
    let response: Response;
    try {
      response = await this.fetchWithActor(requestUrl, actor, options, timeoutMs);
      if (response.status === 401) {
        await response.body?.cancel();
        actor = await this.recoverActorAfterUnauthorized(actor);
        response = await this.fetchWithActor(requestUrl, actor, options, timeoutMs);
      }
    } catch (error) {
      if (error instanceof ForgeDeckApiError) throw error;
      throw transportError(error, requestUrl, timeoutMs, endpointMayUseAdapter(requestUrl.pathname));
    }
    const payload = await readResponse(response);
    if (!response.ok) {
      const errorBody = asObject(payload);
      throw new ForgeDeckApiError(
        errorMessage(payload, response.status),
        response.status,
        requestUrl.pathname,
        typeof errorBody.code === "string" ? errorBody.code : null,
        typeof errorBody.requestId === "string" ? errorBody.requestId : response.headers.get("x-request-id")
      );
    }
    if (requestUrl.pathname === "/api/mcp/actors/current" && (options.method || "GET") === "DELETE") {
      this.forgetActorCredential();
    }
    try {
      return parseHttpResponse(options.method || "GET", requestUrl.pathname, payload) as T;
    } catch (error) {
      throw new ForgeDeckApiError(
        "ForgeDeck returned a response that does not match its API contract",
        response.status,
        requestUrl.pathname,
        "INVALID_RESPONSE_CONTRACT",
        response.headers.get("x-request-id"),
        error
      );
    }
  }

  private ensureActor(): Promise<Actor> {
    if (!this.actorPromise) {
      this.actorPromise = this.loadOrCreateActor().then((actor) => {
        this.currentActor = actor;
        return actor;
      }).catch((error) => {
        this.actorPromise = null;
        throw error;
      });
    }
    return this.actorPromise;
  }

  private async loadOrCreateActor(): Promise<Actor> {
    const stored = this.loadActorCredential();
    if (!stored) return this.registerActor();
    if (!this.shouldRefresh(stored)) return stored;
    try {
      return await this.rotateActor(stored);
    } catch (error) {
      if (!(error instanceof ForgeDeckApiError) || error.status !== 401) throw error;
      return this.registerActor();
    }
  }

  private shouldRefresh(actor: Actor): boolean {
    const lifetime = Math.max(0, actor.credentialExpiresAt - actor.credentialIssuedAt);
    const refreshWindow = Math.min(this.refreshBeforeMs, Math.max(1_000, Math.floor(lifetime / 10)));
    return actor.credentialExpiresAt - this.now() <= refreshWindow;
  }

  private async rotateActor(actor: Actor): Promise<Actor> {
    const requestUrl = new URL("api/mcp/actors/current/rotate", this.url);
    const response = await this.fetchActorCredential(requestUrl, actor.token, {});
    return this.acceptActorCredential(response);
  }

  private async registerActor(): Promise<Actor> {
    let token: string;
    try {
      token = fs.readFileSync(this.bootstrapTokenFile, "utf8").trim();
    } catch {
      throw new Error("ForgeDeck MCP bootstrap token was not found. Verify ForgeDeck is running and FORGEDECK_MCP_TOKEN_FILE is configured correctly.");
    }
    const requestUrl = new URL("api/mcp/actors", this.url);
    const response = await this.fetchActorCredential(requestUrl, token, { clientId: this.clientId });
    return this.acceptActorCredential(response);
  }

  private async fetchActorCredential(requestUrl: URL, bearerToken: string, body: JsonObject): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(requestUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MCP_HEALTH_TIMEOUT_MS)
      });
    } catch (error) {
      throw transportError(error, requestUrl, MCP_HEALTH_TIMEOUT_MS, false);
    }
    const payload = await readResponse(response);
    if (!response.ok) {
      const errorBody = asObject(payload);
      throw new ForgeDeckApiError(
        errorMessage(payload, response.status),
        response.status,
        requestUrl.pathname,
        typeof errorBody.code === "string" ? errorBody.code : null,
        typeof errorBody.requestId === "string" ? errorBody.requestId : response.headers.get("x-request-id")
      );
    }
    return payload;
  }

  private acceptActorCredential(payload: unknown): Actor {
    const actor = asObject(payload);
    if (typeof actor.actorId !== "string"
      || typeof actor.token !== "string"
      || typeof actor.credentialIssuedAt !== "number"
      || typeof actor.credentialExpiresAt !== "number"
      || !Number.isFinite(actor.credentialIssuedAt)
      || !Number.isFinite(actor.credentialExpiresAt)
      || actor.credentialExpiresAt <= actor.credentialIssuedAt) {
      throw new Error("ForgeDeck returned an invalid MCP actor credential");
    }
    const credential: Actor = {
      actorId: actor.actorId,
      token: actor.token,
      credentialIssuedAt: actor.credentialIssuedAt,
      credentialExpiresAt: actor.credentialExpiresAt
    };
    this.persistActorCredential(credential);
    this.currentActor = credential;
    return credential;
  }

  private recoverActorAfterUnauthorized(failedActor: Actor): Promise<Actor> {
    if (this.currentActor && this.currentActor.token !== failedActor.token) return Promise.resolve(this.currentActor);
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.registerActor().then((actor) => {
        this.currentActor = actor;
        return actor;
      }).finally(() => {
        this.recoveryPromise = null;
      });
      this.actorPromise = this.recoveryPromise;
    }
    return this.recoveryPromise;
  }

  private fetchWithActor(requestUrl: URL, actor: Actor, options: ForgeDeckRequestOptions, timeoutMs: number): Promise<Response> {
    return this.fetchFn(requestUrl, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${actor.token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
    });
  }

  private loadActorCredential(): Actor | null {
    try {
      if (!fs.existsSync(this.actorCredentialPath)) return null;
      fs.chmodSync(this.actorCredentialPath, 0o600);
      const stored = JSON.parse(fs.readFileSync(this.actorCredentialPath, "utf8")) as Partial<StoredActorCredential>;
      if (stored.version !== 1
        || stored.installation !== this.installation
        || stored.clientId !== this.clientId
        || typeof stored.actorId !== "string"
        || typeof stored.token !== "string"
        || typeof stored.credentialIssuedAt !== "number"
        || typeof stored.credentialExpiresAt !== "number"
        || !Number.isFinite(stored.credentialIssuedAt)
        || !Number.isFinite(stored.credentialExpiresAt)) {
        logger.warn("Ignoring an invalid or differently scoped MCP actor credential", { credentialPath: this.actorCredentialPath });
        return null;
      }
      return {
        actorId: stored.actorId,
        token: stored.token,
        credentialIssuedAt: stored.credentialIssuedAt,
        credentialExpiresAt: stored.credentialExpiresAt
      };
    } catch (error) {
      logger.warn("Could not read the persisted MCP actor credential; recovering through the bootstrap credential", { error });
      return null;
    }
  }

  private persistActorCredential(actor: Actor): void {
    const directory = path.dirname(this.actorCredentialPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = `${this.actorCredentialPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const stored: StoredActorCredential = {
      version: 1,
      installation: this.installation,
      clientId: this.clientId,
      ...actor
    };
    fs.writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, this.actorCredentialPath);
    fs.chmodSync(this.actorCredentialPath, 0o600);
  }

  private forgetActorCredential(): void {
    this.currentActor = null;
    this.actorPromise = null;
    fs.rmSync(this.actorCredentialPath, { force: true });
  }
}

export class ForgeDeckApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly code: string | null = null,
    readonly requestId: string | null = null,
    readonly details: unknown = null
  ) {
    super(message);
    this.name = "ForgeDeckApiError";
  }
}

export function endpointMayUseAdapter(pathname: string): boolean {
  return pathname === "/api/bootstrap" || pathname === "/api/account/status" || pathname.startsWith("/api/threads");
}

export function isSessionActiveError(error: unknown): boolean {
  return error instanceof ForgeDeckApiError
    && error.status === 409
    && (error.code === null || error.code === "SESSION_ACTIVE");
}

function defaultActorCredentialPath(bootstrapTokenFile: string, installation: string, clientId: string): string {
  const scope = crypto.createHash("sha256").update(`${installation}\0${clientId}`).digest("hex").slice(0, 24);
  return path.join(path.dirname(bootstrapTokenFile), "mcp-actors", `${scope}.json`);
}

function validMcpClientId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(payload: unknown, status: number): string {
  const body = asObject(payload);
  const error = body.error;
  if (typeof error === "string") return error;
  const nestedMessage = asObject(error).message;
  if (typeof nestedMessage === "string") return nestedMessage;
  if (typeof body.message === "string") return body.message;
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return `ForgeDeck request failed with HTTP ${status}`;
}

function transportError(error: unknown, requestUrl: URL, timeoutMs: number, mayUseAdapter: boolean): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const timedOut = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
  if (timedOut) {
    const adapterHint = mayUseAdapter ? " The Codex adapter may be busy or reconnecting." : "";
    return new Error(`ForgeDeck request to ${requestUrl.pathname} timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.${adapterHint}`);
  }
  return new Error(`Could not reach ForgeDeck at ${requestUrl.origin} while requesting ${requestUrl.pathname}: ${detail}`);
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
