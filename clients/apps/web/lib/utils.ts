import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// The type scale in app/globals.css: font sizes, which twMerge would otherwise read as colors.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["label", "caption", "ui", "ui-lg", "body", "heading"] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
