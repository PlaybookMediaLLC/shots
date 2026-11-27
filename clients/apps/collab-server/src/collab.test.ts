import assert from "node:assert/strict";
import test from "node:test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import {
  type CollabBackend,
  CollabBackendError,
  collabHooks,
  draftIdOf,
  memoryWriterTokens,
  redisWriterTokens,
} from "./collab.ts";

const DRAFT = "cdraft0000001";
const DOCUMENT = `content-draft:${DRAFT}`;

/** A backend that knows two tokens for the draft and one for another draft. */
function fakeBackend() {
  const stored: { state: Uint8Array; token: string }[] = [];
  const grants: Record<string, "read" | "write"> = {
    "editor-token": "write",
    "second-editor-token": "write",
    "viewer-token": "read",
  };
  const backend: CollabBackend = {
    authorize: async (token, documentName) => {
      const access = grants[token];
      if (!access || documentName !== DOCUMENT) {
        throw new CollabBackendError(
          "the collaboration token does not grant this document",
          403
        );
      }
      return {
        access,
        draftId: DRAFT,
        organizationId: "org",
        user: { id: token, name: token },
      };
    },
    epochs: async () => ({ global: 0, organizations: { org: published } }),
    load: async () => null,
    store: async (_draftId, token, state) => {
      stored.push({ state, token });
    },
  };
  let published = 0;
  /** What the backend does after a demotion or removal commits. */
  const publish = () => {
    published += 1;
  };
  return { backend, stored, grants, publish };
}

/** Polls the access counts quickly, so tests see a published change at once. */
const FAST = { pollMs: 10 };

/** Long enough for the server to read a published change and re-check. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

function connect(port: number, token: string, document = DOCUMENT) {
  const doc = new Y.Doc();
  const events = { failed: "", synced: false, closed: false };
  const provider = new HocuspocusProvider({
    document: doc,
    name: document,
    onAuthenticationFailed: ({ reason }) => {
      events.failed = reason || "refused";
    },
    onClose: () => {
      events.closed = true;
    },
    onSynced: () => {
      events.synced = true;
    },
    token,
    url: `ws://127.0.0.1:${port}`,
  });
  return { doc, events, provider };
}

const until = async (check: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${label}`);
};

test("document names map to drafts only", () => {
  assert.equal(draftIdOf(DOCUMENT), DRAFT);
  assert.equal(draftIdOf("other:cdraft0000001"), null);
  assert.equal(draftIdOf("content-draft:../../etc"), null);
});

test("edits sync between editors, viewers stay read-only, strangers are refused", async () => {
  const { backend, stored } = fakeBackend();
  const log: string[] = [];
  const server = new Server({
    debounce: 50,
    port: 0,
    quiet: true,
    ...collabHooks(backend, (event) => log.push(event), undefined, FAST),
  });
  await server.listen();
  const port = server.address.port;
  const editor = connect(port, "editor-token");
  const viewer = connect(port, "viewer-token");
  const stranger = connect(port, "stranger-token");
  try {
    await until(() => editor.events.synced && viewer.events.synced, "sync");
    editor.doc.getText("t").insert(0, "hello");
    await until(
      () => viewer.doc.getText("t").toString() === "hello",
      "edit to reach the viewer"
    );

    viewer.doc.getText("t").insert(0, "nope ");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      editor.doc.getText("t").toString(),
      "hello",
      "a read-only edit reached the editor"
    );

    await until(
      () => stranger.events.failed !== "",
      "the stranger to be refused"
    );
    assert.equal(stranger.doc.getText("t").toString(), "");
    assert.ok(log.includes("collab.refused"));

    await until(() => stored.length > 0, "a store");
    const saved = new Y.Doc();
    Y.applyUpdate(saved, stored.at(-1)!.state);
    assert.equal(saved.getText("t").toString(), "hello");
    assert.ok(
      stored.every(({ token }) => token === "editor-token"),
      "stored with a non-writer token"
    );
  } finally {
    for (const client of [editor, viewer, stranger]) client.provider.destroy();
    await server.destroy();
  }
});

test("an open editor refuses demoted writes before the next access poll", async () => {
  const { backend, stored, grants, publish } = fakeBackend();
  const server = new Server({
    port: 0,
    quiet: true,
    debounce: 50,
    ...collabHooks(backend, () => {}, undefined, { pollMs: 60_000 }),
  });
  await server.listen();
  const owner = connect(server.address.port, "editor-token");
  const member = connect(server.address.port, "second-editor-token");
  try {
    await until(
      () => owner.events.synced && member.events.synced,
      "both editors"
    );
    owner.doc.getText("t").insert(0, "original");
    await until(
      () => member.doc.getText("t").toString() === "original",
      "initial edit"
    );
    grants["second-editor-token"] = "read";
    publish();
    member.doc.getText("t").insert(0, "forbidden ");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      owner.doc.getText("t").toString(),
      "original",
      "a demoted editor's update was broadcast"
    );
    owner.doc.getText("t").insert(8, " allowed");
    await until(
      () => member.doc.getText("t").toString().includes("allowed"),
      "read-only member's authorized updates"
    );
    await until(() => stored.length > 0, "stored authorized content");
    const saved = new Y.Doc();
    Y.applyUpdate(saved, stored.at(-1)!.state);
    assert.ok(!saved.getText("t").toString().includes("forbidden"));
    saved.destroy();
  } finally {
    for (const client of [owner, member]) {
      client.provider.destroy();
      client.doc.destroy();
    }
    await server.destroy();
  }
});

test("typing makes no authorization calls while access is unchanged", async () => {
  const { backend } = fakeBackend();
  const authorize = backend.authorize;
  let calls = 0;
  backend.authorize = async (token, documentName) => {
    calls += 1;
    return authorize(token, documentName);
  };
  const server = new Server({
    port: 0,
    quiet: true,
    ...collabHooks(backend, () => {}, undefined, FAST),
  });
  await server.listen();
  const owner = connect(server.address.port, "editor-token");
  try {
    await until(() => owner.events.synced, "sync");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const before = calls;
    for (let index = 0; index < 10; index += 1) {
      owner.doc.getText("t").insert(index, "x");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await until(
      () =>
        server.hocuspocus.documents.get(DOCUMENT)?.getText("t").length === 10,
      "ten updates"
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Unchanged access counts avoid full authorization queries while typing.
    assert.equal(calls - before, 0, `${calls - before} calls for ten updates`);
  } finally {
    owner.provider.destroy();
    owner.doc.destroy();
    await server.destroy();
  }
});

test("a removed idle recipient is closed once the removal is published", async () => {
  const { backend, grants, publish } = fakeBackend();
  const server = new Server({
    port: 0,
    quiet: true,
    ...collabHooks(backend, () => {}, undefined, FAST),
  });
  await server.listen();
  const owner = connect(server.address.port, "editor-token");
  const viewer = connect(server.address.port, "viewer-token");
  try {
    await until(
      () => owner.events.synced && viewer.events.synced,
      "initial sync"
    );
    delete grants["viewer-token"];
    publish();
    await until(() => viewer.events.closed, "removed idle recipient to close");
    owner.doc.getText("t").insert(0, "private after removal");
    owner.provider.setAwarenessField("user", { name: "Private presence" });
    await until(() => viewer.events.closed, "removed idle recipient to close");
    assert.equal(viewer.doc.getText("t").toString(), "");
    assert.ok(
      ![...viewer.provider.awareness!.getStates().values()].some(
        (state) => state.user?.name === "Private presence"
      )
    );
  } finally {
    for (const client of [owner, viewer]) {
      client.provider.destroy();
      client.doc.destroy();
    }
    await server.destroy();
  }
});

test("a demotion published while a connection is being admitted is re-checked", async () => {
  const { backend, grants, publish } = fakeBackend();
  const authorize = backend.authorize;
  const release = Promise.withResolvers<void>();
  let admitting = false;
  backend.authorize = async (token, documentName) => {
    // Reads the permission first, then answers late: the stale-grant race.
    const grant = await authorize(token, documentName);
    if (token === "second-editor-token" && !admitting) {
      admitting = true;
      await release.promise;
    }
    return grant;
  };
  const hooks = collabHooks(backend, () => {}, undefined, FAST);
  const server = new Server({ port: 0, quiet: true, ...hooks });
  await server.listen();
  const owner = connect(server.address.port, "editor-token");
  // A client that sends nothing until it is admitted, so no queued frame
  // re-checks it: only the counts recorded at admission can.
  const member = {
    readOnly: false,
    close: () => {},
    onClose: () => {},
    send: (_frame: Uint8Array) => {},
  };
  const connectionConfig = { readOnly: false, isAuthenticated: false };
  try {
    await until(() => owner.events.synced, "owner keeps the workspace polled");
    const admission = hooks.onAuthenticate({
      connectionConfig,
      documentName: DOCUMENT,
      token: "second-editor-token",
    } as unknown as Parameters<typeof hooks.onAuthenticate>[0]);
    await until(() => admitting, "admission read the old permission");
    grants["second-editor-token"] = "read";
    publish();
    await settle();
    release.resolve();
    const context = await admission;
    assert.equal(
      connectionConfig.readOnly,
      false,
      "admitted with the old grant"
    );
    await hooks.connected({
      connection: member,
      context,
      documentName: DOCUMENT,
    } as unknown as Parameters<typeof hooks.connected>[0]);
    // An outgoing frame is gated on current access, like an incoming one.
    member.send(new Uint8Array([0]));
    await settle();
    assert.equal(member.readOnly, true, "a stale grant was used");
  } finally {
    release.resolve();
    owner.provider.destroy();
    owner.doc.destroy();
    await server.destroy();
  }
});

test("a connection re-checks its access after recheckMs even with nothing published", async () => {
  const { backend, grants } = fakeBackend();
  const server = new Server({
    port: 0,
    quiet: true,
    ...collabHooks(backend, () => {}, undefined, { pollMs: 10, recheckMs: 50 }),
  });
  await server.listen();
  const owner = connect(server.address.port, "editor-token");
  const member = connect(server.address.port, "second-editor-token");
  try {
    await until(() => owner.events.synced && member.events.synced, "sync");
    // An ended session, say: nothing is published, the next check still sees it.
    delete grants["second-editor-token"];
    await new Promise((resolve) => setTimeout(resolve, 80));
    member.doc.getText("t").insert(0, "after the session ended");
    await until(
      () => member.events.closed,
      "the unpublished revocation to close it"
    );
    assert.equal(owner.doc.getText("t").toString(), "");
  } finally {
    for (const client of [owner, member]) {
      client.provider.destroy();
      client.doc.destroy();
    }
    await server.destroy();
  }
});

test("outgoing frames check a published removal before the next access poll", async () => {
  const { backend, grants, publish } = fakeBackend();
  const authorize = backend.authorize;
  const release = Promise.withResolvers<void>();
  let hold = false;
  let checking = false;
  backend.authorize = async (token, documentName) => {
    if (hold && token === "viewer-token") {
      hold = false;
      checking = true;
      await release.promise;
    }
    return authorize(token, documentName);
  };
  const server = new Server({
    port: 0,
    quiet: true,
    ...collabHooks(backend, () => {}, undefined, { pollMs: 60_000 }),
  });
  await server.listen();
  const owner = connect(server.address.port, "editor-token");
  const viewer = connect(server.address.port, "viewer-token");
  try {
    await until(() => owner.events.synced && viewer.events.synced, "sync");
    owner.doc.getText("t").insert(0, "before removal");
    await until(
      () => viewer.doc.getText("t").toString().includes("before removal"),
      "authorized edit"
    );
    hold = true;
    delete grants["viewer-token"];
    publish();
    owner.doc.getText("t").insert(14, " PRIVATE");
    await until(() => checking, "re-check of the published removal, held");
    await until(
      () =>
        server.hocuspocus.documents
          .get(DOCUMENT)
          ?.getText("t")
          .toString()
          .includes("PRIVATE") ?? false,
      "private update queued while authorization is held"
    );
    release.resolve();
    await until(() => viewer.events.closed, "removed viewer to close");
    assert.ok(!viewer.doc.getText("t").toString().includes("PRIVATE"));
  } finally {
    release.resolve();
    for (const client of [owner, viewer]) {
      client.provider.destroy();
      client.doc.destroy();
    }
    await server.destroy();
  }
});

test("unavailable access counts close a sender before applying its update", async () => {
  const { backend } = fakeBackend();
  const epochs = backend.epochs;
  let refuse = false;
  backend.epochs = async (organizations) => {
    if (refuse) throw new Error("access counts unavailable");
    return epochs(organizations);
  };
  const server = new Server({
    port: 0,
    quiet: true,
    ...collabHooks(backend, () => {}, undefined, { pollMs: 60_000 }),
  });
  await server.listen();
  const owner = connect(server.address.port, "editor-token");
  const member = connect(server.address.port, "second-editor-token");
  try {
    await until(() => owner.events.synced && member.events.synced, "sync");
    owner.doc.getText("t").insert(0, "original");
    await until(
      () => member.doc.getText("t").toString() === "original",
      "initial update"
    );
    const shared = server.hocuspocus.documents.get(DOCUMENT)?.getText("t");
    assert.ok(shared);
    refuse = true;
    member.doc.getText("t").insert(8, " must not be applied");
    await until(() => member.events.closed, "unverified sender to close");
    assert.equal(shared.toString(), "original");
    assert.equal(owner.doc.getText("t").toString(), "original");
  } finally {
    for (const client of [owner, member]) {
      client.provider.destroy();
      client.doc.destroy();
    }
    await server.destroy();
  }
});

test("a rejected document store closes its room without crashing the server", async () => {
  const { backend, stored } = fakeBackend();
  const store = backend.store;
  let refuse = true;
  backend.store = async (...args) => {
    if (refuse) throw new CollabBackendError("store refused", 403);
    await store(...args);
  };
  const log: string[] = [];
  const server = new Server({
    debounce: 10,
    port: 0,
    quiet: true,
    ...collabHooks(backend, (event) => log.push(event), undefined, FAST),
  });
  await server.listen();
  const owner = connect(server.address.port, "editor-token");
  let reconnected: HocuspocusProvider | undefined;
  try {
    await until(() => owner.events.synced, "sync");
    owner.doc.getText("t").insert(0, "pending client state");
    await until(
      () => owner.events.closed,
      "refused store to close its document"
    );
    assert.ok(log.includes("collab.store_failed"));
    assert.ok(!log.includes("collab.stored"));
    assert.equal(stored.length, 0);
    // Reopening with the retained client state requires a fresh admission.
    owner.provider.destroy();
    refuse = false;
    await until(
      () => server.hocuspocus.getDocumentsCount() === 0,
      "failed room to unload"
    );
    reconnected = new HocuspocusProvider({
      document: owner.doc,
      name: DOCUMENT,
      token: "editor-token",
      url: `ws://127.0.0.1:${server.address.port}`,
    });
    await until(
      () => stored.length > 0,
      "pending state to persist on reconnect"
    );
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, stored.at(-1)!.state);
      assert.equal(restored.getText("t").toString(), "pending client state");
    } finally {
      restored.destroy();
    }
  } finally {
    reconnected?.destroy();
    owner.provider.destroy();
    owner.doc.destroy();
    await server.destroy();
  }
});

test("a failed writer-token store refuses the update before broadcasting it", async () => {
  const { backend } = fakeBackend();
  const writers = memoryWriterTokens();
  const set = writers.set;
  let refuse = false;
  writers.set = async (documentName, token) => {
    if (refuse && token === "second-editor-token")
      throw new Error("writer store unavailable");
    await set(documentName, token);
  };
  const server = new Server({
    port: 0,
    quiet: true,
    ...collabHooks(backend, () => {}, writers, FAST),
  });
  await server.listen();
  const owner = connect(server.address.port, "editor-token");
  const member = connect(server.address.port, "second-editor-token");
  try {
    await until(
      () => owner.events.synced && member.events.synced,
      "both editors"
    );
    owner.doc.getText("t").insert(0, "original");
    await until(
      () => member.doc.getText("t").toString() === "original",
      "initial update"
    );
    refuse = true;
    member.doc.getText("t").insert(8, " must not broadcast");
    await until(() => member.events.closed, "failed writer to close");
    assert.equal(owner.doc.getText("t").toString(), "original");
    assert.equal(
      server.hocuspocus.documents.get(DOCUMENT)?.getText("t").toString(),
      "original"
    );
  } finally {
    for (const client of [owner, member]) {
      client.provider.destroy();
      client.doc.destroy();
    }
    await server.destroy();
  }
});

// Two replicas behind one Redis: an edit on one reaches a reader on the
// other, and the document is stored with the writer's token whichever
// replica wins the store lock. Needs a real Redis (COLLAB_TEST_REDIS_URL).
test(
  "replicas share edits and writer tokens through Redis",
  { skip: !process.env.COLLAB_TEST_REDIS_URL },
  async () => {
    const { Redis: RedisExtension } =
      await import("@hocuspocus/extension-redis");
    const { Redis } = await import("ioredis");
    const url = process.env.COLLAB_TEST_REDIS_URL ?? "";
    const { backend, stored, grants, publish } = fakeBackend();
    const clients: InstanceType<typeof Redis>[] = [];
    const replica = async () => {
      const redis = new Redis(url);
      clients.push(redis);
      const server = new Server({
        debounce: 50,
        extensions: [
          new RedisExtension({
            createClient: () => {
              const client = new Redis(url, { enableReadyCheck: false });
              clients.push(client);
              return client;
            },
            prefix: `shots-collab-test-${process.pid}`,
          }),
        ],
        port: 0,
        quiet: true,
        ...collabHooks(backend, () => {}, redisWriterTokens(redis), FAST),
      });
      await server.listen();
      return server;
    };
    const first = await replica();
    const second = await replica();
    const editor = connect(first.address.port, "editor-token");
    const viewer = connect(second.address.port, "viewer-token");
    try {
      await until(() => editor.events.synced && viewer.events.synced, "sync");
      editor.doc.getText("t").insert(0, "across replicas");
      await until(
        () => viewer.doc.getText("t").toString() === "across replicas",
        "the edit to cross replicas"
      );
      await until(() => stored.length > 0, "a store");
      assert.ok(stored.every(({ token }) => token === "editor-token"));
      delete grants["viewer-token"];
      publish();
      editor.doc.getText("t").insert(0, "private ");
      await until(
        () => viewer.events.closed,
        "removed remote recipient to close"
      );
      assert.equal(viewer.doc.getText("t").toString(), "across replicas");
    } finally {
      editor.provider.destroy();
      viewer.provider.destroy();
      await Promise.all([first.destroy(), second.destroy()]);
      for (const client of clients) client.disconnect();
    }
  }
);

test("Story Sets share presence only and drop a member once the removal is published", async () => {
  const name = "creative-set:cstory00000001";
  const admitted = new Set(["alice", "bob"]);
  let published = 0;
  const backend: CollabBackend = {
    epochs: async () => ({ global: 0, organizations: { org: published } }),
    authorize: async (token, documentName) => {
      if (!admitted.has(token) || documentName !== name)
        throw new CollabBackendError("Member removed", 403);
      return {
        kind: "creative-set",
        access: "write",
        draftId: "cstory00000001",
        organizationId: "org",
        user: { id: token, name: token },
      };
    },
    load: async () => {
      assert.fail("Story content must not load through Yjs");
    },
    store: async () => {
      assert.fail("Story content must not save through Yjs");
    },
  };
  const server = new Server({
    port: 0,
    quiet: true,
    debounce: 50,
    ...collabHooks(backend, () => {}, undefined, FAST),
  });
  await server.listen();
  const alice = connect(server.address.port, "alice", name);
  const bob = connect(server.address.port, "bob", name);
  const stranger = connect(
    server.address.port,
    "alice",
    "creative-set:another000001"
  );
  try {
    await until(
      () => alice.events.synced && bob.events.synced,
      "set presence sync"
    );
    alice.provider.setAwarenessField("user", { name: "Alice" });
    await until(
      () =>
        [...bob.provider.awareness!.getStates().values()].some(
          (state) => state.user?.name === "Alice"
        ),
      "peer presence"
    );
    alice.doc.getText("content").insert(0, "must not propagate");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(bob.doc.getText("content").toString(), "");
    await until(() => stranger.events.failed !== "", "wrong set refused");
    admitted.delete("alice");
    published += 1;
    await settle();
    alice.provider.setAwarenessField("user", { name: "Removed" });
    await until(() => alice.events.closed, "removed member disconnected");
    assert.ok(
      ![...bob.provider.awareness!.getStates().values()].some(
        (state) => state.user?.name === "Removed"
      )
    );
  } finally {
    for (const client of [alice, bob, stranger]) {
      client.provider.destroy();
      client.doc.destroy();
    }
    await server.destroy();
  }
});

test("push mode avoids per-frame epoch HTTP calls and revokes on applyEpoch", async () => {
  const { backend, grants } = fakeBackend();
  let epochCalls = 0;
  const origEpochs = backend.epochs;
  backend.epochs = async (orgs) => {
    epochCalls += 1;
    return origEpochs(orgs);
  };
  const hooks = collabHooks(backend, () => {}, undefined, {
    isPushLive: () => true,
    pollMs: 60_000,
  });
  const server = new Server({
    port: 0,
    quiet: true,
    debounce: 50,
    ...hooks,
  });
  await server.listen();
  const editor = connect(server.address.port, "editor-token");
  const viewer = connect(server.address.port, "viewer-token");
  try {
    await until(() => editor.events.synced && viewer.events.synced, "sync");
    const callsBefore = epochCalls;
    for (let i = 0; i < 5; i++) {
      editor.doc.getText("t").insert(i, "a");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await until(() => viewer.doc.getText("t").toString() === "aaaaa", "edits");
    assert.equal(
      epochCalls - callsBefore,
      0,
      "push mode must not poll epochs on frames"
    );

    delete grants["viewer-token"];
    hooks.applyEpoch("org", 1);
    await until(() => viewer.events.closed, "viewer closed via push");
  } finally {
    editor.provider.destroy();
    editor.doc.destroy();
    viewer.provider.destroy();
    viewer.doc.destroy();
    await server.destroy();
  }
});

test("memoryWriterTokens evicts least-recently-used entries at capacity", async () => {
  const tokens = memoryWriterTokens(2);
  await tokens.set("doc-1", "t1");
  await tokens.set("doc-2", "t2");
  // Touch doc-1 so doc-2 becomes LRU.
  assert.equal(await tokens.get("doc-1"), "t1");
  await tokens.set("doc-3", "t3");
  assert.equal(await tokens.get("doc-2"), undefined);
  assert.equal(await tokens.get("doc-1"), "t1");
  assert.equal(await tokens.get("doc-3"), "t3");
});

test("onStoreDocument retries transient 503 errors without closing connections", async () => {
  const { backend, stored } = fakeBackend();
  let attempts = 0;
  const origStore = backend.store;
  backend.store = async (draftId, token, state) => {
    attempts += 1;
    if (attempts === 1) {
      throw new CollabBackendError("Temporary outage", 503);
    }
    return origStore(draftId, token, state);
  };
  const server = new Server({
    port: 0,
    quiet: true,
    debounce: 50,
    ...collabHooks(backend, () => {}, undefined, {
      isPushLive: () => true,
      pollMs: 60_000,
    }),
  });
  await server.listen();
  const editor = connect(server.address.port, "editor-token");
  try {
    await until(() => editor.events.synced, "sync");
    editor.doc.getText("t").insert(0, "saved after retry");
    await until(() => stored.length === 1, "retry succeeded");
    assert.equal(attempts, 2);
    assert.equal(editor.events.closed, false);
  } finally {
    editor.provider.destroy();
    editor.doc.destroy();
    await server.destroy();
  }
});

test("push mode catches revocation pushed while the org's first connection is authenticating", async () => {
  const { backend, grants } = fakeBackend();
  const origAuthorize = backend.authorize;
  let releaseFirst!: () => void;
  let firstInFlight!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstInFlight = resolve;
  });
  let authorizeCalls = 0;
  backend.authorize = async (token, documentName) => {
    authorizeCalls += 1;
    const grant = await origAuthorize(token, documentName);
    if (authorizeCalls === 1) {
      firstInFlight();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return grant;
  };
  const hooks = collabHooks(backend, () => {}, undefined, {
    isPushLive: () => true,
    pollMs: 60_000,
  });
  const server = new Server({
    port: 0,
    quiet: true,
    ...hooks,
  });
  await server.listen();
  const viewer = connect(server.address.port, "viewer-token");
  try {
    await firstStarted;
    // Revoke and push while NO connection is tracked in `open` yet.
    delete grants["viewer-token"];
    hooks.applyEpoch("org", 1);
    releaseFirst();
    await until(() => viewer.events.closed, "first connection closed on race");
    assert.ok(authorizeCalls >= 2, "expected post-admission recheck");
  } finally {
    viewer.provider.destroy();
    viewer.doc.destroy();
    await server.destroy();
  }
});

test("syncEpochs returns false when backend epoch read fails", async () => {
  const { backend } = fakeBackend();
  backend.epochs = async () => {
    throw new CollabBackendError("Backend unavailable", 503);
  };
  const hooks = collabHooks(backend, () => {}, undefined, {
    isPushLive: () => false,
    pollMs: 60_000,
  });
  assert.equal(await hooks.syncEpochs(), false);
  await hooks.onDestroy();
});

test("onStoreDocument does not retry definitive 403 refusals", async () => {
  const { backend } = fakeBackend();
  let attempts = 0;
  backend.store = async () => {
    attempts += 1;
    throw new CollabBackendError("Forbidden", 403);
  };
  const server = new Server({
    port: 0,
    quiet: true,
    debounce: 50,
    ...collabHooks(backend, () => {}, undefined, {
      isPushLive: () => true,
      pollMs: 60_000,
    }),
  });
  await server.listen();
  const editor = connect(server.address.port, "editor-token");
  try {
    await until(() => editor.events.synced, "sync");
    editor.doc.getText("t").insert(0, "forbidden save");
    await until(() => editor.events.closed, "editor closed on 403 store");
    assert.equal(attempts, 1, "403 must not be retried");
  } finally {
    editor.provider.destroy();
    editor.doc.destroy();
    await server.destroy();
  }
});
