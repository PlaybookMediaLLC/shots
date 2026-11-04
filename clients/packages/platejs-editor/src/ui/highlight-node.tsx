"use client";

import { PlateLeaf, type PlateLeafProps } from "platejs/react";

export function HighlightLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf {...props} as="mark" className="bg-primary/30 text-inherit">
      {props.children}
    </PlateLeaf>
  );
}
