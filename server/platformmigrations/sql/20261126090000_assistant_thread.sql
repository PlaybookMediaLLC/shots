-- Saved assistant chats, private to one person in one workspace.
CREATE TABLE "assistant_thread" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "entries" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistant_thread_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_thread_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "assistant_thread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "assistant_thread_organizationId_userId_updatedAt_idx"
  ON "assistant_thread" ("organizationId", "userId", "updatedAt");
