import type { DesignChanges } from './document'

/** The model may restyle the design but never swap the user's images. */
export function withoutImageSources(changes: DesignChanges): DesignChanges {
  const { devices, image, ...rest } = changes
  const { src: _ignored, ...imageWithoutSource } = image ?? {}
  return {
    ...rest,
    ...(image ? { image: imageWithoutSource } : {}),
    ...(devices
      ? {
          devices: {
            ...devices,
            ...(devices.mockups
              ? {
                  mockups: devices.mockups.map((mockup) => ({
                    ...mockup,
                    screen: { ...mockup.screen, src: null },
                  })),
                }
              : {}),
          },
        }
      : {}),
  }
}
