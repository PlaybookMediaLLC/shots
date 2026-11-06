const POSTER_WIDTH = 640
const POSTER_QUALITY = 0.8
const LOAD_TIMEOUT_MS = 10_000

/**
 * Grab a video's opening frame in the browser as a small JPEG; the server has
 * no video decoder. Null when this browser can't decode the video.
 */
export async function captureVideoPoster(video: Blob): Promise<Blob | null> {
  if (typeof document === 'undefined') return null
  const url = URL.createObjectURL(video)
  const element = document.createElement('video')
  element.muted = true
  element.playsInline = true
  element.preload = 'auto'
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The video took too long to load.')),
        LOAD_TIMEOUT_MS
      )
      element.onseeked = () => {
        clearTimeout(timer)
        resolve()
      }
      element.onerror = () => {
        clearTimeout(timer)
        reject(new Error('The browser could not read the video.'))
      }
      // Just past the start: many videos begin on black.
      element.onloadedmetadata = () => {
        element.currentTime = Math.min(0.1, element.duration || 0)
      }
      element.src = url
    })
    if (!element.videoWidth || !element.videoHeight) return null
    const scale = Math.min(1, POSTER_WIDTH / element.videoWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(element.videoWidth * scale)
    canvas.height = Math.round(element.videoHeight * scale)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(element, 0, 0, canvas.width, canvas.height)
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', POSTER_QUALITY))
  } finally {
    element.removeAttribute('src')
    URL.revokeObjectURL(url)
  }
}
