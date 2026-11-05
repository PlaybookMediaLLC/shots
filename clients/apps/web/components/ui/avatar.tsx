"use client"

import * as React from "react"
import {
  Avatar as AvatarPrimitive,
  AvatarFallback as AvatarFallbackPrimitive,
  AvatarImage as AvatarImagePrimitive,
} from "facehash"

import { cn } from "@/lib/utils"

/** Face colours, picked from the name: 40% in light mode, 90% in dark, as Cossistant sets them. */
const FACE_COLORS = [
  "bg-pink-300/40 dark:bg-pink-300/90",
  "bg-yellow-200/40 dark:bg-yellow-200/90",
  "bg-blue-300/40 dark:bg-blue-300/90",
  "bg-orange-500/40 dark:bg-orange-500/90",
  "bg-emerald-300/40 dark:bg-emerald-300/90",
]

function Avatar({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive>) {
  return (
    <AvatarPrimitive
      data-slot="avatar"
      className={cn(
        "relative flex size-8 shrink-0 overflow-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    />
  )
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarImagePrimitive>) {
  return (
    <AvatarImagePrimitive
      data-slot="avatar-image"
      className={cn("aspect-square size-full", className)}
      {...props}
    />
  )
}

/**
 * Shows when there is no image or it fails to load: a face drawn from `name`,
 * so one name always gets the same face. Children replace the face. While an
 * image loads, the avatar shows its muted background.
 */
function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarFallbackPrimitive>) {
  return (
    <AvatarFallbackPrimitive
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full text-black",
        className
      )}
      facehashProps={{
        colorClasses: FACE_COLORS,
        enableBlink: true,
        intensity3d: "dramatic",
        interactive: false,
      }}
      {...props}
    />
  )
}

export { Avatar, AvatarImage, AvatarFallback }
