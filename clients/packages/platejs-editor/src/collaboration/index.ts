import { YjsPlugin } from "@platejs/yjs/react";
import { IndexeddbPersistence } from "y-indexeddb";
import type * as Y from "yjs";

import { RemoteCursorOverlay } from "../ui/remote-cursor-overlay";

export interface CollaborationCursor {
  color: string;
  name: string;
  userId: string;
}

export interface CollaborationProviderConfig {
  // Mirrors @oppulence/core CollaborationAccess (this package doesn't depend on
  // @oppulence/core). "comment" and "read" keep webrtc off below and get no
  // loadLocalCopy — only "write" does both; comment/read go through the server.
  access: "read" | "comment" | "write";
  documentName: string;
  getToken: () => Promise<string>;
  hocuspocusUrl: string;
  webrtc: {
    iceServers: Array<{ urls: string[] }>;
    password: string;
    roomName: string;
    signaling: string[];
  } | null;
}

// y-webrtc falls back to these public servers when `signaling` is empty.
const PUBLIC_SIGNALING_HOSTS = new Set([
  "signaling.yjs.dev",
  "y-webrtc-signaling-eu.herokuapp.com",
  "y-webrtc-signaling-us.herokuapp.com",
]);

/**
 * WebRTC needs the host's own signaling (and TURN) servers. An empty list
 * would make y-webrtc use public servers, so it is refused, as are the
 * public hosts themselves.
 */
export const assertPrivateSignaling = (signaling: readonly string[]): void => {
  if (signaling.length === 0) {
    throw new Error("WebRTC collaboration needs explicit signaling servers.");
  }
  for (const url of signaling) {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "wss:" && protocol !== "ws:") {
      throw new Error(`Signaling server ${url} is not a WebSocket URL.`);
    }
    if (PUBLIC_SIGNALING_HOSTS.has(hostname)) {
      throw new Error(`Signaling server ${hostname} is public.`);
    }
  }
};

export const createYjsPlugin = (
  config: CollaborationProviderConfig,
  cursor: CollaborationCursor
) => {
  if (config.access === "write" && config.webrtc) {
    assertPrivateSignaling(config.webrtc.signaling);
  }
  return YjsPlugin.configure({
    render: { afterEditable: RemoteCursorOverlay },
    options: {
      cursors: {
        data: {
          color: cursor.color,
          name: cursor.name,
          style: { backgroundColor: cursor.color },
          // Any CSS color (hosts pass hsl()), at a fifth of its strength.
          selectionStyle: {
            backgroundColor: `color-mix(in srgb, ${cursor.color} 20%, transparent)`,
          },
          userId: cursor.userId,
        },
      },
      // A write session's browser copy is loaded with loadLocalCopy before
      // init, not as a provider here: see loadLocalCopy.
      providers: [
        {
          type: "hocuspocus",
          options: {
            name: config.documentName,
            token: config.getToken,
            url: config.hocuspocusUrl,
          },
        },
        // Only write sessions may join the WebRTC P2P mesh. y-webrtc has no
        // per-peer read-only enforcement, so a read-only client handed the
        // room/password/signaling config could broadcast Yjs updates directly,
        // bypassing the authorized hocuspocus server path. Gate it on access.
        ...(config.access === "write" && config.webrtc
          ? [
              {
                type: "webrtc" as const,
                options: {
                  password: config.webrtc.password,
                  peerOpts: {
                    config: { iceServers: config.webrtc.iceServers },
                  },
                  roomName: config.webrtc.roomName,
                  signaling: config.webrtc.signaling,
                },
              },
            ]
          : []),
      ],
    },
  });
};

/**
 * The browser's copy of a write session's document, loaded into `doc` before
 * the live session starts. Plate seeds a never-opened document from the stored
 * draft only when no local copy is still loading, and it never retries. As one
 * of its providers, an IndexedDB copy that finished loading after the server
 * sync left a new draft's editor empty. Loaded first, any unsynced local edits
 * are in the document before Plate decides, and it keeps persisting them.
 */
export const loadLocalCopy = (
  documentName: string,
  doc: Y.Doc
): { destroy: () => void; ready: Promise<void> } => {
  const persistence = new IndexeddbPersistence(documentName, doc);
  return {
    destroy: () => {
      persistence.destroy().catch(() => {});
    },
    // Without IndexedDB (some private modes) the session uses the server alone.
    ready: Promise.race([
      persistence.whenSynced.then(() => undefined),
      persistence._db.then(
        () => new Promise<void>(() => {}),
        () => undefined
      ),
    ]),
  };
};

/**
 * Sends the local cursor at most once every `wait` ms: the first move at once,
 * the last one always. Every awareness update is a message the collaboration
 * server authorizes, and typing moves the cursor on each keystroke; other
 * fields (name, colour) still go out at once. Returns a function that restores
 * the awareness and drops a pending send.
 */
export const throttleCursor = (
  awareness: { setLocalStateField: (field: string, value: unknown) => void },
  wait = 200
): (() => void) => {
  const set = awareness.setLocalStateField;
  let last = 0;
  let pending: unknown;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (value: unknown) => {
    last = Date.now();
    set.call(awareness, "selection", value);
  };
  awareness.setLocalStateField = (field, value) => {
    if (field !== "selection") {
      set.call(awareness, field, value);
      return;
    }
    pending = value;
    if (timer) return;
    const elapsed = Date.now() - last;
    if (elapsed >= wait) {
      send(value);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      send(pending);
    }, wait - elapsed);
  };
  return () => {
    if (timer) clearTimeout(timer);
    awareness.setLocalStateField = set;
  };
};

export { YjsPlugin };
export { HocuspocusProviderWrapper } from "@platejs/yjs";
