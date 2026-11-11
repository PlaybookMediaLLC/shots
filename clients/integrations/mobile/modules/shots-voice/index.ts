import { NativeModule, requireNativeModule } from 'expo'

import type { ShotsVoiceEvents, ShotsVoiceModule } from './src/ShotsVoice.types'

export * from './src/ShotsVoice.types'

declare class ShotsVoiceNative extends NativeModule<ShotsVoiceEvents> implements ShotsVoiceModule {
  getCapabilities: ShotsVoiceModule['getCapabilities']
  requestPermissions: ShotsVoiceModule['requestPermissions']
  start: ShotsVoiceModule['start']
  stop: ShotsVoiceModule['stop']
  cancel: ShotsVoiceModule['cancel']
  recoverInterrupted: ShotsVoiceModule['recoverInterrupted']
  deleteNoteAudio: ShotsVoiceModule['deleteNoteAudio']
}

/** The Swift recorder. Subscribe with `ShotsVoice.addListener('onState', ...)`. */
export default requireNativeModule<ShotsVoiceNative>('ShotsVoice')
