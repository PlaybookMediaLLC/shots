import { z } from 'zod'

const encoded = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/)
export const privateActionKeySchema = encoded.length(88)
const envelopeSchema = z
  .object({
    publicKey: privateActionKeySchema,
    iv: encoded.length(16),
    ciphertext: encoded.min(24).max(200000),
  })
  .strict()
const responseSchema = envelopeSchema.omit({ publicKey: true })
const syncLogSchema = z.string().max(110_000)
export const autoFormatExamplesSchema = z.array(z.string().trim().min(1).max(12000)).min(1).max(3)
export const autoFormatResultSchema = z.string().trim().min(1).max(16000)
const context = new TextEncoder()

function encode(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
}
function decode(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}
export async function createPrivateActionIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveKey',
  ])
  return {
    privateKey: pair.privateKey,
    publicKey: encode(await crypto.subtle.exportKey('raw', pair.publicKey)),
  }
}
async function sharedKey(privateKey: CryptoKey, publicKey: string) {
  const peer = await crypto.subtle.importKey(
    'raw',
    decode(privateActionKeySchema.parse(publicKey)),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peer },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}
async function seal(
  key: CryptoKey,
  value: unknown,
  direction: 'request' | 'response',
  purpose: 'auto-format' | 'cloudsync-log' = 'auto-format'
) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: context.encode(`shots-founder-hub:${purpose}:${direction}`),
    },
    key,
    context.encode(JSON.stringify(value))
  )
  return { iv: encode(iv), ciphertext: encode(ciphertext) }
}
async function open(
  key: CryptoKey,
  value: z.infer<typeof responseSchema>,
  direction: 'request' | 'response',
  purpose: 'auto-format' | 'cloudsync-log' = 'auto-format'
) {
  const cleartext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decode(value.iv),
      additionalData: context.encode(`shots-founder-hub:${purpose}:${direction}`),
    },
    key,
    decode(value.ciphertext)
  )
  return JSON.parse(new TextDecoder().decode(cleartext))
}
/** Each request has a fresh in-memory key; Shots only transports ciphertext. */
export async function sealAutoFormatRequest(publicKey: string, examples: string[]) {
  const identity = await createPrivateActionIdentity()
  const key = await sharedKey(identity.privateKey, publicKey)
  return {
    argument: JSON.stringify({
      publicKey: identity.publicKey,
      ...(await seal(key, autoFormatExamplesSchema.parse(examples), 'request')),
    }),
    readResult: async (result: string) =>
      autoFormatResultSchema.parse(
        await open(key, responseSchema.parse(JSON.parse(result)), 'response')
      ),
  }
}
export async function openAutoFormatRequest(privateKey: CryptoKey, argument: string) {
  const envelope = envelopeSchema.parse(JSON.parse(argument))
  const key = await sharedKey(privateKey, envelope.publicKey)
  return {
    examples: autoFormatExamplesSchema.parse(await open(key, envelope, 'request')),
    sealResult: async (format: string) =>
      JSON.stringify(await seal(key, autoFormatResultSchema.parse(format), 'response')),
  }
}
/** Encrypts a sync-log request to the selected desktop; only its ephemeral key can read the response. */
export async function createCloudsyncLogRequest(devicePublicKey: string) {
  const identity = await createPrivateActionIdentity()
  const key = await sharedKey(identity.privateKey, devicePublicKey)
  return {
    argument: JSON.stringify({
      publicKey: identity.publicKey,
      ...(await seal(key, {}, 'request', 'cloudsync-log')),
    }),
    readResult: async (result: string) =>
      syncLogSchema.parse(
        await open(key, responseSchema.parse(JSON.parse(result)), 'response', 'cloudsync-log')
      ),
  }
}
