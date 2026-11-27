import type { Connection } from "@hocuspocus/server";

const protectedConnections = new WeakSet<Connection>();
const MAX_PENDING_BYTES = 8 << 20;
const MAX_GLOBAL_PENDING_BYTES = 64 << 20;
const MAX_PENDING_MESSAGES = 256;

let globalPendingBytes = 0;

/**
 * Gate every outgoing frame, including Redis broadcasts, on current access.
 * Hocuspocus's incoming-message hooks alone cannot protect an idle recipient.
 * The public send method remains synchronous; a bounded queue preserves order
 * while authorization runs, and failure closes the document without sending it.
 */
export function protectConnection(
  connection: Connection,
  authorize: () => Promise<void>
): void {
  if (protectedConnections.has(connection)) return;
  protectedConnections.add(connection);
  const send = connection.send.bind(connection);
  const close = connection.close.bind(connection);
  const pending: Uint8Array[] = [];
  let bytes = 0;
  let messages = 0;
  let draining = false;
  let stopped = false;
  const stop = () => {
    stopped = true;
    globalPendingBytes = Math.max(0, globalPendingBytes - bytes);
    pending.length = 0;
    bytes = 0;
    messages = 0;
  };
  connection.onClose(stop);
  connection.close = (event) => {
    if (stopped) return;
    stop();
    // Only the protocol close frame bypasses the authorization queue.
    connection.send = send;
    close(event);
    connection.send = () => {};
  };
  const refuse = () =>
    connection.close({
      code: 4403,
      reason: "Document access is no longer available.",
    });
  const busy = () =>
    connection.close({
      code: 1013,
      reason: "Collaboration server is busy. Reconnect to retry.",
    });
  const drain = async () => {
    if (draining || stopped) return;
    draining = true;
    try {
      // Frames sent in one turn (an update's echo and its sync acknowledgement)
      // share one decision, which begins only once they are all queued.
      await Promise.resolve();
      while (pending.length && !stopped) {
        // A decision may only release frames that existed when it began.
        // New frames need their own check, even while this one is in flight.
        const batch = pending.splice(0);
        await authorize();
        if (stopped) return;
        for (const message of batch) {
          if (stopped) return;
          bytes -= message.byteLength;
          globalPendingBytes = Math.max(
            0,
            globalPendingBytes - message.byteLength
          );
          messages--;
          send(message);
        }
      }
    } catch {
      refuse();
    } finally {
      draining = false;
    }
  };
  connection.send = (message: unknown) => {
    if (stopped) return;
    if (!(message instanceof Uint8Array)) {
      refuse();
      return;
    }
    if (
      messages >= MAX_PENDING_MESSAGES ||
      bytes + message.byteLength > MAX_PENDING_BYTES ||
      globalPendingBytes + message.byteLength > MAX_GLOBAL_PENDING_BYTES
    ) {
      busy();
      return;
    }
    pending.push(new Uint8Array(message));
    bytes += message.byteLength;
    globalPendingBytes += message.byteLength;
    messages++;
    void drain();
  };
}
