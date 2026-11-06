import type { Metadata } from "next";

export const SITE_URL = "https://shots.playbookmedia.io";

export const OG_IMAGE = {
  url: `${SITE_URL}/og.jpg`,
  width: 1200,
  height: 630,
  type: "image/jpeg",
  alt: "Shots - Launch what you shipped.",
};

export const OG_DEFAULTS = {
  type: "website",
  locale: "en_US",
  siteName: "Shots",
  emails: ["team@playbookmedia.io"],
  // Social sites scrape again after 7 days, so new copy reaches link previews.
  ttl: 604800,
  images: [OG_IMAGE],
} satisfies Metadata["openGraph"];
