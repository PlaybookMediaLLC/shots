/**
 * The collaboration server's hooks (RFC 013). Every decision is the Go
 * backend's: it authorizes each connection from the user's draft-scoped token,
 * and it loads and stores the Yjs state when that token is presented again.
 * This process holds no database credential and cannot open a draft by itself.
 */
import type {
  beforeHandleMessagePayload,
  connectedPayload,
  onAuthenticatePayload,
  onLoadDocumentPayload,
  onRequestPayload,
  onStoreDocumentPayload,
} from "@hocuspocus/server";
import { IncomingMessage, MessageType } from "@hocuspocus/server";
import * as Y from "yjs";
import { z } from "zod";
import { protectConnection } from "./access.ts";

/** Validated backend authority for one document and user. */
export const collabGrantSchema = z.object({
  kind: z.enum(["content-draft", "creative-set"]).optional(),
  access: z.enum(["read", "write"]),
  draftId: z.string().min(1),
  organizationId: z.string().min(1),
  user: z.object({ id: z.string().min(1), name: z.string() }),
});

/** What the backend grants a connection. */
export type CollabGrant = z.infer<typeof collabGrantSchema>;

/** The backend's counts of changes that can alter collaboration access. */
export const collabEpochsSchema = z.object({
  global: z.number(),
  organizations: z.record(z.string(), z.number()),
});

/** Access counts: one for every workspace, and one per workspace asked for. */
export type CollabEpochs = z.infer<typeof collabEpochsSchema>;

/** The Go backend's collaboration routes. */
export type CollabBackend = {
  authorize: (token: string, documentName: string) => Promise<CollabGrant>;
  epochs: (organizationIds: string[]) => Promise<CollabEpochs>;
  load: (draftId: string, token: string) => Promise<Uint8Array | null>;
  store: (draftId: string, token: string, state: Uint8Array) => Promise<void>;
};

/** A refused call, with the backend's status. */
export class CollabBackendError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CollabBackendError";
    this.status = status;
  }
}

const DOCUMENT_PREFIX = "content-draft:";

/** The draft a document name is for, or null for any other name. */
export function draftIdOf(documentName: string): string | null {
  const id = documentName.startsWith(DOCUMENT_PREFIX)
    ? documentName.slice(DOCUMENT_PREFIX.length)
    : "";
  const match = /^([a-z0-9-]{10,40})(?::[1-9][0-9]{0,9})?$/i.exec(id);
  return match?.[1] ?? null;
}

/** A client for the backend, authenticated with the collaboration credential. */
export function backendClient(
  baseUrl: string,
  serviceToken: string,
  fetchImpl: typeof fetch = fetch
): CollabBackend {
  const call = async (path: string, init: RequestInit & { token?: string }) => {
    const response = await fetchImpl(new URL(path, baseUrl), {
      ...init,
      signal: AbortSignal.timeout(5_000),
      headers: {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
        ...(init.token ? { "x-collab-token": init.token } : {}),
      },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new CollabBackendError(
        "Collaboration access is unavailable.",
        response.status
      );
    }
    return body ?? {};
  };
  return {
    authorize: async (token, documentName) =>
      collabGrantSchema.parse(
        await call("/v1/collab/authorize", {
          body: JSON.stringify({ documentName, token }),
          method: "POST",
        })
      ),
    epochs: async (organizationIds) =>
      collabEpochsSchema.parse(
        await call(
          `/v1/collab/epochs?${new URLSearchParams(
            organizationIds.map((id) => ["organizationId", id])
          )}`,
          { method: "GET" }
        )
      ),
    load: async (draftId, token) => {
      const { state } = z.object({ state: z.string().nullable() }).parse(
        await call(`/v1/collab/documents/${encodeURIComponent(draftId)}`, {
          method: "GET",
          token,
        })
      );
      return typeof state === "string" ? Buffer.from(state, "base64") : null;
    },
    store: async (draftId, token, state) => {
      await call(`/v1/collab/documents/${encodeURIComponent(draftId)}`, {
        body: JSON.stringify({ state: Buffer.from(state).toString("base64") }),
        method: "PUT",
        token,
      });
    },
  };
}

type Log = (event: string, fields: Record<string, unknown>) => void;

/**
 * The newest read-write token per document. A store runs after a debounce,
 * possibly after its connection left, so it uses the last writer's token.
 * With several replicas the store can run on any of them (the Redis
 * extension picks one by lock), so the tokens must be shared too.
 */
export type WriterTokens = {
  get: (documentName: string) => Promise<string | undefined>;
  set: (documentName: string, token: string) => Promise<void>;
};

/** How long a writer token is kept: the backend's store grace for a token. */
const WRITER_TOKEN_TTL_SECONDS = 12 * 60 * 60;
const WRITER_TOKEN_TTL_MS = WRITER_TOKEN_TTL_SECONDS * 1_000;
const MEMORY_WRITER_TOKEN_LIMIT = 5_000;
const KNOWN_ORG_EPOCH_LIMIT = 5_000;
const MAX_EPOCH_QUERY_ORGS = 500;
const MAX_CONCURRENT_RECHECKS = 10;

/** Redis Pub/Sub channel carrying epoch bump notifications from the Go backend. */
export const COLLAB_EPOCH_CHANNEL = "shots-collab:epoch:events";

/** Writer tokens for a single replica, bounded by LRU capacity and TTL. */
export function memoryWriterTokens(
  maxEntries = MEMORY_WRITER_TOKEN_LIMIT
): WriterTokens {
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  return {
    get: async (documentName) => {
      const entry = tokens.get(documentName);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        tokens.delete(documentName);
        return undefined;
      }
      // Refresh LRU position.
      tokens.delete(documentName);
      tokens.set(documentName, entry);
      return entry.token;
    },
    set: async (documentName, token) => {
      tokens.delete(documentName);
      tokens.set(documentName, {
        token,
        expiresAt: Date.now() + WRITER_TOKEN_TTL_MS,
      });
      while (tokens.size > maxEntries) {
        const oldest = tokens.keys().next().value;
        if (oldest === undefined) break;
        tokens.delete(oldest);
      }
    },
  };
}

/** Writer tokens shared by every replica through Redis. */
export function redisWriterTokens(redis: {
  get: (key: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    mode: "EX",
    seconds: number
  ) => Promise<unknown>;
}): WriterTokens {
  const key = (documentName: string) => `shots-collab:writer:${documentName}`;
  return {
    get: async (documentName) =>
      (await redis.get(key(documentName))) ?? undefined,
    set: async (documentName, token) => {
      await redis.set(key(documentName), token, "EX", WRITER_TOKEN_TTL_SECONDS);
    },
  };
}

/** The access counts a decision was made against, and when. */
const checkSchema = z.object({
  global: z.number(),
  organization: z.number(),
  at: z.number(),
});
type Check = z.infer<typeof checkSchema>;

const contextSchema = z.object({
  grant: collabGrantSchema,
  token: z.string().min(1),
  admitted: checkSchema.optional(),
  admittedSeq: z.number().optional(),
});
type Context = z.infer<typeof contextSchema>;

type Connection = connectedPayload["connection"];

/**
 * The Hocuspocus hooks that route every decision through the backend.
 *
 * A connection is authorized when it opens (onAuthenticate). When Redis Pub/Sub
 * epoch pushes are live (`isPushLive`), every frame verifies against the local
 * push-updated epoch map in O(1) with a non-overlapping fallback poll. Without
 * live push, concurrent frame checks coalesce per workspace into a single
 * backend epoch read. Any connection is re-checked after `recheckMs` regardless.
 */
export function collabHooks(
  backend: CollabBackend,
  log: Log,
  writers: WriterTokens = memoryWriterTokens(),
  {
    isPushLive,
    onShutdown,
    pollMs = isPushLive ? 5_000 : 1_000,
    recheckMs = 60_000,
  }: {
    isPushLive?: () => boolean;
    onShutdown?: () => Promise<void> | void;
    pollMs?: number;
    recheckMs?: number;
  } = {}
) {
  const known = {
    bumpSeq: 0,
    global: 0,
    organizations: new Map<string, number>(),
  };
  const setKnownOrg = (organizationId: string, epoch: number) => {
    known.organizations.delete(organizationId);
    known.organizations.set(organizationId, epoch);
    while (known.organizations.size > KNOWN_ORG_EPOCH_LIMIT) {
      const oldest = known.organizations.keys().next().value;
      if (oldest === undefined) break;
      if (open.has(oldest)) {
        // Keep active workspaces pinned in the map.
        const active = known.organizations.get(oldest)!;
        known.organizations.delete(oldest);
        known.organizations.set(oldest, active);
        if (known.organizations.size <= open.size) break;
        continue;
      }
      known.organizations.delete(oldest);
    }
  };
  const checks = new WeakMap<Connection, Check>();
  const inFlightChecks = new WeakMap<
    Connection,
    { key: string; promise: Promise<void> }
  >();
  type Open = {
    connection: Connection;
    context: unknown;
    documentName: string;
  };
  const open = new Map<string, Set<Open>>();
  const inFlightEpochs = new Map<string, Promise<CollabEpochs>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pollPromise: Promise<boolean> | null = null;
  let destroyed = false;

  const unchanged = (check: Check | undefined, next: Check) =>
    !!check &&
    check.global === next.global &&
    check.organization === next.organization &&
    Date.now() - check.at < recheckMs;

  const readEpochsCoalesced = (
    organizationId: string
  ): Promise<CollabEpochs> => {
    const existing = inFlightEpochs.get(organizationId);
    if (existing) return existing;
    const beforeSeq = known.bumpSeq;
    const promise = backend
      .epochs([organizationId])
      .then((counts) => {
        if (known.bumpSeq === beforeSeq) {
          if (counts.global !== known.global) {
            known.global = counts.global;
            known.bumpSeq += 1;
          }
          const orgCount = counts.organizations[organizationId] ?? 0;
          if (orgCount !== (known.organizations.get(organizationId) ?? 0)) {
            setKnownOrg(organizationId, orgCount);
            known.bumpSeq += 1;
          }
        }
        return counts;
      })
      .finally(() => {
        inFlightEpochs.delete(organizationId);
      });
    inFlightEpochs.set(organizationId, promise);
    return promise;
  };

  const currentAccess = async (
    value: unknown,
    documentName: string,
    connection: Connection
  ) => {
    const { grant: original, token } = contextSchema.parse(value);
    let next: Check;
    if (isPushLive?.()) {
      next = {
        global: known.global,
        organization: known.organizations.get(original.organizationId) ?? 0,
        at: Date.now(),
      };
    } else {
      const counts = await readEpochsCoalesced(original.organizationId);
      next = {
        global: counts.global,
        organization: counts.organizations[original.organizationId] ?? 0,
        at: Date.now(),
      };
    }
    if (unchanged(checks.get(connection), next)) return;
    const checkKey = `${next.global}:${next.organization}`;
    const existing = inFlightChecks.get(connection);
    if (existing && existing.key === checkKey) {
      return existing.promise;
    }
    const verify = (async () => {
      log("collab.recheck", {
        documentName,
        organizationId: original.organizationId,
      });
      const grant = await backend.authorize(token, documentName);
      if (
        grant.draftId !== original.draftId ||
        grant.organizationId !== original.organizationId ||
        grant.user.id !== original.user.id ||
        grant.kind !== original.kind
      ) {
        throw new CollabBackendError("Collaboration authority changed.", 403);
      }
      // A delayed grant must never undo an already observed demotion. A later
      // upgrade takes effect on a new connection with a newly issued token.
      connection.readOnly =
        connection.readOnly ||
        grant.kind === "creative-set" ||
        grant.access !== "write";
      checks.set(connection, next);
    })().finally(() => {
      if (inFlightChecks.get(connection)?.promise === verify) {
        inFlightChecks.delete(connection);
      }
    });
    inFlightChecks.set(connection, { key: checkKey, promise: verify });
    return verify;
  };

  const recheckEntries = (entries: Open[]) => {
    if (entries.length === 0) return;
    let index = 0;
    const workers = Math.min(MAX_CONCURRENT_RECHECKS, entries.length);
    const worker = async () => {
      while (index < entries.length && !destroyed) {
        const entry = entries[index++];
        if (!entry) break;
        try {
          await currentAccess(
            entry.context,
            entry.documentName,
            entry.connection
          );
        } catch (error: unknown) {
          log("collab.revoked", {
            documentName: entry.documentName,
            status: error instanceof CollabBackendError ? error.status : 0,
          });
          entry.connection.close({
            code: 4403,
            reason: "Document access is no longer available.",
          });
        }
      }
    };
    for (let i = 0; i < workers; i++) {
      void worker();
    }
  };

  const recheckOrgs = (moved: Set<string>) => {
    if (moved.size === 0) return;
    const toRecheck: Open[] = [];
    for (const id of moved) {
      for (const entry of open.get(id) ?? []) toRecheck.push(entry);
    }
    recheckEntries(toRecheck);
  };

  const applyEpoch = (organizationId: string, epoch: number) => {
    if (destroyed) return;
    const moved = new Set<string>();
    if (organizationId === "") {
      if (epoch !== known.global) {
        known.global = epoch;
        known.bumpSeq += 1;
        for (const id of open.keys()) moved.add(id);
      }
    } else {
      const current = known.organizations.get(organizationId) ?? 0;
      if (epoch !== current || !open.has(organizationId)) {
        // Always advance bumpSeq even when no connection is tracked yet so an
        // in-flight onAuthenticate/onLoadDocument for this org invalidates.
        known.bumpSeq += 1;
        setKnownOrg(organizationId, epoch);
        if (open.has(organizationId)) {
          moved.add(organizationId);
        }
      }
    }
    recheckOrgs(moved);
  };

  const schedulePoll = () => {
    if (destroyed || open.size === 0 || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, pollMs);
    timer.unref?.();
  };

  const poll = async (): Promise<boolean> => {
    if (destroyed) {
      if (timer) clearTimeout(timer);
      timer = null;
      return false;
    }
    if (open.size === 0) {
      if (timer) clearTimeout(timer);
      timer = null;
      return true;
    }
    if (pollPromise) return pollPromise;
    const run = (async (): Promise<boolean> => {
      let ok = true;
      try {
        const orgIds = [...open.keys()];
        const moved = new Set<string>();
        for (
          let start = 0;
          start < orgIds.length;
          start += MAX_EPOCH_QUERY_ORGS
        ) {
          const chunk = orgIds.slice(start, start + MAX_EPOCH_QUERY_ORGS);
          const beforeSeq = known.bumpSeq;
          const counts = await backend.epochs(chunk);
          // Skip regressing local epochs if a Pub/Sub push landed while this
          // HTTP poll was in flight.
          if (known.bumpSeq !== beforeSeq) continue;
          if (counts.global !== known.global) {
            known.global = counts.global;
            known.bumpSeq += 1;
            for (const id of open.keys()) moved.add(id);
          }
          for (const [id, count] of Object.entries(counts.organizations)) {
            if ((known.organizations.get(id) ?? 0) !== count) {
              moved.add(id);
              known.bumpSeq += 1;
            }
            if (open.has(id)) setKnownOrg(id, count);
          }
        }
        // Pushed revocation: an idle reader loses access without waiting for a frame.
        recheckOrgs(moved);
      } catch (error) {
        ok = false;
        log("collab.epochs_failed", {
          status: error instanceof CollabBackendError ? error.status : 0,
        });
      } finally {
        pollPromise = null;
        schedulePoll();
      }
      return ok;
    })();
    pollPromise = run;
    return run;
  };

  /** Runs a guaranteed fresh epoch sync after a Pub/Sub reconnect. */
  const syncEpochs = async (): Promise<boolean> => {
    if (destroyed) return false;
    if (pollPromise) await pollPromise;
    if (destroyed) return false;
    if (open.size === 0) {
      // Refresh global epoch even when no rooms are open yet so first
      // connections start from the backend's current global counter.
      try {
        const beforeSeq = known.bumpSeq;
        const counts = await backend.epochs([]);
        if (known.bumpSeq === beforeSeq) {
          known.global = counts.global;
        }
        return true;
      } catch (error) {
        log("collab.epochs_failed", {
          status: error instanceof CollabBackendError ? error.status : 0,
        });
        return false;
      }
    }
    return poll();
  };

  const track = (entry: Open, organizationId: string) => {
    const entries = open.get(organizationId) ?? new Set<Open>();
    entries.add(entry);
    open.set(organizationId, entries);
    entry.connection.onClose(() => {
      entries.delete(entry);
      if (entries.size === 0) {
        open.delete(organizationId);
      }
    });
    schedulePoll();
  };

  const protect = (
    value: unknown,
    documentName: string,
    connection: connectedPayload["connection"]
  ) => {
    protectConnection(connection, () =>
      currentAccess(value, documentName, connection)
    );
  };

  return {
    applyEpoch,
    syncEpochs,

    async onAuthenticate({
      connectionConfig,
      documentName,
      token,
    }: onAuthenticatePayload): Promise<Context> {
      if (
        !draftIdOf(documentName) &&
        !/^creative-set:[a-z0-9-]{10,40}$/i.test(documentName)
      ) {
        log("collab.refused", { documentName, reason: "unknown document" });
        throw new Error("Unknown document.");
      }
      try {
        // Snapshot a monotonic bump sequence before authorizing so any epoch
        // movement while authorize or onLoadDocument is in flight forces a
        // fresh re-check without cloning the entire organizations map.
        const beforeAt = Date.now();
        const beforeSeq = known.bumpSeq;
        const beforeGlobal = known.global;
        const grant = await backend.authorize(token, documentName);
        const admitted: Check =
          known.bumpSeq === beforeSeq
            ? {
                at: beforeAt,
                global: beforeGlobal,
                organization:
                  known.organizations.get(grant.organizationId) ?? 0,
              }
            : {
                at: 0,
                global: -1,
                organization: -1,
              };
        connectionConfig.readOnly =
          grant.kind === "creative-set" || grant.access !== "write";
        log("collab.admitted", {
          access: grant.access,
          documentName,
          organizationId: grant.organizationId,
          userId: grant.user.id,
        });
        return { grant, token, admitted, admittedSeq: beforeSeq };
      } catch (error) {
        log("collab.refused", {
          documentName,
          reason: error instanceof Error ? error.message : "unknown",
          status: error instanceof CollabBackendError ? error.status : 0,
        });
        throw error;
      }
    },

    async connected({ context, documentName, connection }: connectedPayload) {
      const { admitted, admittedSeq, grant } = contextSchema.parse(context);
      track({ connection, context, documentName }, grant.organizationId);
      if (admitted) {
        checks.set(
          connection,
          admittedSeq !== undefined && known.bumpSeq !== admittedSeq
            ? { at: 0, global: -1, organization: -1 }
            : admitted
        );
      }
      protect(context, documentName, connection);
    },

    async onDestroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await onShutdown?.();
    },

    async beforeHandleMessage({
      context,
      documentName,
      connection,
      update,
    }: beforeHandleMessagePayload) {
      protect(context, documentName, connection);
      await currentAccess(context, documentName, connection);
      if (connection.readOnly) return;
      // Hocuspocus 3 does not await beforeSync. Keep all async authority and
      // writer-token work in this awaited hook, before the update is applied.
      const message = new IncomingMessage(update);
      message.readVarString();
      const type = message.readVarUint();
      if (type !== MessageType.Sync && type !== MessageType.SyncReply) return;
      const syncType = message.readVarUint();
      if (syncType !== 1 && syncType !== 2) return;
      const { token } = contextSchema.parse(context);
      // Record the latest writer directly (single SET RTT; avoids stale
      // cross-replica cache suppression).
      await writers.set(documentName, token);
    },

    async onLoadDocument({
      context,
      document,
      documentName,
    }: onLoadDocumentPayload) {
      const { grant, token } = contextSchema.parse(context);
      if (grant.kind === "creative-set") return document;
      const state = await backend.load(grant.draftId, token);
      if (state) Y.applyUpdate(document, state);
      log("collab.loaded", { bytes: state?.byteLength ?? 0, documentName });
      return document;
    },

    async onStoreDocument({ document, documentName }: onStoreDocumentPayload) {
      const draftId = draftIdOf(documentName);
      if (!draftId) return;
      const retryDelays = [250, 750];
      let lastError: unknown;
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        try {
          const token = await writers.get(documentName);
          if (!token) return;
          await backend.store(draftId, token, Y.encodeStateAsUpdate(document));
          log("collab.stored", { documentName });
          return;
        } catch (error) {
          lastError = error;
          const status = error instanceof CollabBackendError ? error.status : 0;
          // Never retry definitive authorization refusals.
          if (
            status === 401 ||
            status === 403 ||
            status === 404 ||
            attempt === retryDelays.length
          ) {
            break;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelays[attempt])
          );
        }
      }
      log("collab.store_failed", {
        documentName,
        status: lastError instanceof CollabBackendError ? lastError.status : 0,
      });
      for (const connection of document.getConnections()) {
        connection.close({
          code: 1013,
          reason: "Document save unavailable. Reconnect to retry.",
        });
      }
      // Hocuspocus's debounced store does not handle rejected Error objects.
      // Its silent rejection convention skips afterStoreDocument without an
      // unhandled rejection taking down every room. The client's existing
      // local Yjs persistence resubmits pending edits after fresh admission.
      throw null;
    },

    async onRequest({ request, response }: onRequestPayload) {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
        // Hocuspocus treats a rejection as "handled": no default response.
        throw null;
      }
    },
  };
}
