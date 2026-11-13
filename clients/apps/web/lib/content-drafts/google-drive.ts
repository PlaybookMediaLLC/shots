import 'server-only'
import { googleDriveConfigSchema, type GoogleDriveConfig } from '@/lib/write/google-drive'

/**
 * Google Picker's keys for Shots' Google Cloud project, or null while Drive
 * import is not set up. They reach the browser, so none of them is a secret:
 * the OAuth client is restricted to Shots' origins and the API key to Picker.
 */
export function googleDriveConfig(): GoogleDriveConfig | null {
  const values = {
    apiKey: process.env.GOOGLE_PICKER_API_KEY,
    appId: process.env.GOOGLE_PICKER_APP_ID,
    clientId: process.env.GOOGLE_PICKER_CLIENT_ID,
  }
  if (!values.apiKey && !values.appId && !values.clientId) return null
  const config = googleDriveConfigSchema.safeParse(values)
  if (!config.success) {
    // A half or wrong setup keeps Drive import unavailable, and says why.
    console.error(
      'Google Drive import is unavailable: set GOOGLE_PICKER_API_KEY, GOOGLE_PICKER_CLIENT_ID and GOOGLE_PICKER_APP_ID (the Cloud project number).'
    )
    return null
  }
  return config.data
}
