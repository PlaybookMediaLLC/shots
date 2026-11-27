/**
 * Runs the collaboration server. Configuration comes from the environment:
 * PORT, COLLAB_BACKEND_URL (the Go backend), COLLAB_SERVICE_TOKEN (the
 * credential that opens only the backend's collaboration routes) and,
 * to run more than one replica, COLLAB_REDIS_URL.
 */
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import { Server } from "@hocuspocus/server";
import { Redis } from "ioredis";
import {
  backendClient,
  COLLAB_EPOCH_CHANNEL,
  collabHooks,
  memoryWriterTokens,
  redisWriterTokens,
} from "./collab.ts";
import { z } from "zod";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
};

const log = (event: string, fields: Record<string, unknown>) =>
  console.warn(
    JSON.stringify({ event, ...fields, time: new Date().toISOString() })
  );

const epochEventSchema = z.object({
  organizationId: z.string(),
  epoch: z.number(),
});

// With Redis, replicas relay document updates and awareness to each other,
// and one of them (by lock) stores each document. Redis carries live Yjs
// updates, epoch invalidation events, and writer tokens only; the backend still
// holds every draft.
const redisUrl = process.env.COLLAB_REDIS_URL;
const redis = redisUrl ? new Redis(redisUrl) : null;
const epochSub = redisUrl
  ? new Redis(redisUrl, { enableReadyCheck: false })
  : null;

if (redis) {
  redis.on("error", (error) => {
    log("collab.redis_error", { client: "writer", message: error.message });
  });
}

const closeRedis = async (client: Redis | null) => {
  if (!client) return;
  if (client.status !== "ready") {
    client.disconnect();
    return;
  }
  await Promise.race([
    client.quit().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  client.disconnect();
};

let pushSubscribed = false;
let subGen = 0;
const { applyEpoch, syncEpochs, ...hooks } = collabHooks(
  backendClient(
    required("COLLAB_BACKEND_URL"),
    required("COLLAB_SERVICE_TOKEN")
  ),
  log,
  redis ? redisWriterTokens(redis) : memoryWriterTokens(),
  {
    isPushLive: epochSub ? () => pushSubscribed : undefined,
    onShutdown: async () => {
      subGen += 1;
      pushSubscribed = false;
      await Promise.allSettled([closeRedis(epochSub), closeRedis(redis)]);
    },
  }
);

if (epochSub) {
  const dropPush = () => {
    subGen += 1;
    pushSubscribed = false;
  };
  epochSub.on("error", (error) => {
    dropPush();
    log("collab.redis_error", { client: "epoch_sub", message: error.message });
  });
  epochSub.on("close", dropPush);
  epochSub.on("end", dropPush);
  epochSub.on("ready", () => {
    const gen = ++subGen;
    pushSubscribed = false;
    void epochSub
      .subscribe(COLLAB_EPOCH_CHANNEL)
      .then(async () => {
        const synced = await syncEpochs();
        if (gen === subGen && epochSub.status === "ready" && synced) {
          pushSubscribed = true;
        }
      })
      .catch((error: unknown) => {
        if (gen === subGen) pushSubscribed = false;
        log("collab.epoch_subscribe_failed", {
          message: error instanceof Error ? error.message : "unknown",
        });
      });
  });
  epochSub.on("message", (channel, message) => {
    if (channel !== COLLAB_EPOCH_CHANNEL) return;
    try {
      const parsed = epochEventSchema.parse(JSON.parse(message));
      applyEpoch(parsed.organizationId, parsed.epoch);
    } catch {
      log("collab.epoch_message_invalid", { channel });
    }
  });
}

const server = new Server(
  {
    debounce: 2_000,
    maxDebounce: 10_000,
    name: "shots-collab",
    port: Number(process.env.PORT ?? 1234),
    quiet: true,
    extensions: redisUrl
      ? [
          new RedisExtension({
            // The extension subscribes at once; ioredis's ready check would
            // then send INFO on a subscriber connection, which Redis refuses.
            createClient: () => {
              const client = new Redis(redisUrl, { enableReadyCheck: false });
              client.on("error", (error) => {
                log("collab.redis_error", {
                  client: "hocuspocus",
                  message: error.message,
                });
              });
              return client;
            },
            prefix: "shots-collab",
          }),
        ]
      : [],
    ...hooks,
  },
  {
    maxPayload: 8 << 20,
    perMessageDeflate: {
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      threshold: 1024,
    },
  }
);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server.destroy().finally(() => process.exit(0));
  });
}

await server.listen();
log("collab.listening", { port: server.configuration.port });
