import images from './public-images.json'

/** Immutable direct R2 CDN image URL (CORS-enabled for untainted canvas/video exports). */
export function publicImageUrl(src: string): string {
  const r2Base = process.env.NEXT_PUBLIC_R2_PUBLIC_URL?.replace(/\/+$/, '')
  if (!r2Base) return src
  const index = src.search(/[?#]/)
  const path = index < 0 ? src : src.slice(0, index)
  const suffix = index < 0 ? '' : src.slice(index)
  const key = images[path as keyof typeof images]
  return key ? `${r2Base}/${key.split('/').map(encodeURIComponent).join('/')}${suffix}` : src
}
