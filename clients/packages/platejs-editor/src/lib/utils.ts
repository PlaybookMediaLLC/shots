import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The host app's type scale (text-label, text-caption, text-ui, ...): font
// sizes, which twMerge would otherwise read as colors and drop.
const twMerge = extendTailwindMerge({
  extend: {
    theme: { text: ["label", "caption", "ui", "ui-lg", "body", "heading"] },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
