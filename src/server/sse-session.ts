import { isSseEventName, serializeSseEnvelope } from "../shared/contracts.js";
import type { Response } from "express";
import type { SessionInvalidationReason } from "./auth.js";

type SseClient = {
  response: Response;
  sessionId: string;
  clientId: string;
  heartbeat: NodeJS.Timeout;
  threadIds: Set<string>;
};

/** Formats every data-bearing SSE message with the stream revision in both the SSE id and JSON envelope. */
export function formatRevisionedSseEvent<T>(event: string, payload: T, eventId: number, threadId: string | null = null): string {
  if (!Number.isSafeInteger(eventId) || eventId < 0) throw new Error("SSE event id must be a non-negative safe integer");
  if (!isSseEventName(event)) throw new Error(`Unknown SSE event contract: ${event}`);
  const envelope = serializeSseEnvelope(event, payload, eventId, threadId);
  return `id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** Tracks every event stream by the exact browser authentication session that opened it. */
export class SseSessionRegistry {
  private readonly clients = new Map<Response, SseClient>();
  private readonly clientsBySession = new Map<string, Set<Response>>();
  private readonly clientsBySessionAndId = new Map<string, Map<string, Response>>();
  private readonly clientsByThread = new Map<string, Set<Response>>();
  private legacyClientSequence = 0;

  constructor(
    private readonly maxConnections: number,
    private readonly maxConnectionsPerSession: number,
    private readonly currentEventId: () => number = () => 0
  ) {
    if (!Number.isInteger(maxConnections) || maxConnections <= 0) throw new Error("SSE connection limit must be positive");
    if (!Number.isInteger(maxConnectionsPerSession) || maxConnectionsPerSession <= 0) throw new Error("Per-session SSE connection limit must be positive");
  }

  canAccept(sessionId: string, clientId?: string): boolean {
    const existing = clientId ? this.clientsBySessionAndId.get(sessionId)?.has(clientId) === true : false;
    return (existing || this.clients.size < this.maxConnections)
      && (existing || (this.clientsBySession.get(sessionId)?.size || 0) < this.maxConnectionsPerSession);
  }

  add(
    response: Response,
    sessionId: string,
    heartbeat: NodeJS.Timeout,
    clientId = `legacy-${++this.legacyClientSequence}`,
    threadIds: Iterable<string> = []
  ): void {
    if (!this.canAccept(sessionId, clientId)) throw new Error("SSE connection capacity exhausted");
    const existing = this.clientsBySessionAndId.get(sessionId)?.get(clientId);
    if (existing) this.close(existing);
    const client = { response, sessionId, clientId, heartbeat, threadIds: new Set(threadIds) };
    this.clients.set(response, client);
    const sessionClients = this.clientsBySession.get(sessionId) || new Set<Response>();
    sessionClients.add(response);
    this.clientsBySession.set(sessionId, sessionClients);
    const identifiedClients = this.clientsBySessionAndId.get(sessionId) || new Map<string, Response>();
    identifiedClients.set(clientId, response);
    this.clientsBySessionAndId.set(sessionId, identifiedClients);
    for (const threadId of client.threadIds) this.addThreadClient(threadId, response);
  }

  close(response: Response): void {
    const client = this.clients.get(response);
    if (!client) return;
    this.clients.delete(response);
    clearInterval(client.heartbeat);
    const sessionClients = this.clientsBySession.get(client.sessionId);
    sessionClients?.delete(response);
    if (!sessionClients?.size) this.clientsBySession.delete(client.sessionId);
    const identifiedClients = this.clientsBySessionAndId.get(client.sessionId);
    if (identifiedClients?.get(client.clientId) === response) identifiedClients.delete(client.clientId);
    if (!identifiedClients?.size) this.clientsBySessionAndId.delete(client.sessionId);
    for (const threadId of client.threadIds) {
      const threadClients = this.clientsByThread.get(threadId);
      threadClients?.delete(response);
      if (!threadClients?.size) this.clientsByThread.delete(threadId);
    }
    if (!response.writableEnded) response.end();
  }

  /** Atomically replaces the thread streams selected by one browser connection. */
  setSubscriptions(sessionId: string, clientId: string, threadIds: Iterable<string>): boolean {
    const response = this.clientsBySessionAndId.get(sessionId)?.get(clientId);
    const client = response ? this.clients.get(response) : undefined;
    if (!response || !client) return false;
    const next = new Set(threadIds);
    for (const threadId of client.threadIds) {
      if (next.has(threadId)) continue;
      const threadClients = this.clientsByThread.get(threadId);
      threadClients?.delete(response);
      if (!threadClients?.size) this.clientsByThread.delete(threadId);
    }
    for (const threadId of next) {
      if (!client.threadIds.has(threadId)) this.addThreadClient(threadId, response);
    }
    client.threadIds = next;
    return true;
  }

  closeSession(sessionId: string, reason: SessionInvalidationReason): void {
    const responses = [...(this.clientsBySession.get(sessionId) || [])];
    const message = formatRevisionedSseEvent("session-ended", { reason }, this.currentEventId());
    for (const response of responses) {
      try {
        if (!response.writableEnded) response.write(message);
      } catch {
        // The stream is already unusable; removal and end still happen below.
      } finally {
        this.close(response);
      }
    }
  }

  closeAll(): void {
    for (const response of [...this.clients.keys()]) this.close(response);
  }

  /** Global events use null; thread events return only explicitly subscribed clients. */
  responses(threadId: string | null = null): IterableIterator<Response> {
    return threadId === null ? this.clients.keys() : (this.clientsByThread.get(threadId) || new Set<Response>()).values();
  }

  get size(): number {
    return this.clients.size;
  }

  private addThreadClient(threadId: string, response: Response): void {
    const threadClients = this.clientsByThread.get(threadId) || new Set<Response>();
    threadClients.add(response);
    this.clientsByThread.set(threadId, threadClients);
  }
}
