"use client";

import * as React from "react";
import { SectionWrapper } from "./SectionWrapper";
import { useImageStore } from "@/lib/store";
import { toast } from "sonner";
import { Button } from '@/components/ui/button'
import { EXPORT_SIZE_PRESETS, SIZE_GROUP_LABELS } from '@/lib/export/sizes'

/**
 * Resize the canvas to a published size. The sizes themselves belong to the
 * export pipeline (`lib/export/sizes.ts`), which the export panel's size
 * picker and the pre-publish handoff also read, so a platform's dimensions
 * are stated once.
 */
export function ExportPresetsSection() {
  return (
    <SectionWrapper title="Export Presets" defaultOpen={false}>
      <p className="mb-2 text-[10px] text-muted-foreground">Canvas size at 1×. Export scale multiplies these dimensions.</p>
      <div className="grid grid-cols-2 gap-1.5">
        {EXPORT_SIZE_PRESETS.map((preset) => (
          <Button variant="custom" size={null}
            key={preset.id}
            onClick={() => {
              useImageStore.getState().setCustomDimensions(preset.width, preset.height);
              toast.success(`${preset.label}: ${preset.width}×${preset.height} at 1×`);
            }}
            className="px-2.5 py-2 rounded-lg border border-border/30 hover:border-border/60 hover:bg-accent/50 transition-all text-left active:scale-[0.98]"
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                {SIZE_GROUP_LABELS[preset.group]}
              </span>
            </div>
            <p className="text-[11px] font-semibold text-foreground mt-0.5">
              {preset.label}
            </p>
            <p className="text-[9px] text-muted-foreground">{preset.width}×{preset.height}</p>
          </Button>
        ))}
      </div>
    </SectionWrapper>
  );
}
