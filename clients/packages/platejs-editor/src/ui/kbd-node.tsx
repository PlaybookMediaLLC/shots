"use client";

import { PlateLeaf, type PlateLeafProps } from "platejs/react";

export function KbdLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      as="kbd"
      className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-sm shadow-sm"
    >
      {props.children}
    </PlateLeaf>
  );
}
