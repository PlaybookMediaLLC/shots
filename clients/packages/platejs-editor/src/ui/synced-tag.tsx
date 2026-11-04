"use client";

import { useElement } from "platejs/react";

type SyncedElement = {
  syncedRefId?: string;
};

/**
 * SyncedTag - A placeholder component for synced block indicators.
 *
 * This is a basic implementation. For full synced block functionality
 * (refresh, update, unlink operations), override this component in your
 * application with proper tRPC/API integration.
 *
 * The full implementation requires:
 * - tRPC client for synced block operations
 * - Locale handling for links
 * - App-specific routes
 */
export function SyncedTag() {
  const element = useElement() as SyncedElement;
  const id: string | undefined = element?.syncedRefId;

  // If no syncedRefId, don't render anything
  if (!id) return null;

  // Basic indicator showing this is a synced block
  // Applications should override this component for full functionality
  return (
    <div className="pointer-events-none absolute -top-2 left-0 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <span className="pointer-events-auto h-5 truncate rounded-md bg-muted px-1.5 text-label text-muted-foreground">
        Synced • {id.slice(0, 6)}
      </span>
    </div>
  );
}
