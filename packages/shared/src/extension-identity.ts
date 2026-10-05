/**
 * Identity of the ContextLayer extension.
 *
 * Chrome derives an extension id from the manifest `key`, a PUBLIC key: the
 * first 128 bits of SHA-256 over its DER bytes, hex digits mapped 0-f to a-p.
 * Committing the development public key gives every clone and CI run the same
 * id, which the dashboard needs to address the extension and the API records
 * on each connection. The matching private key was never kept: loading an
 * unpacked extension does not need it, and it is not a secret to protect.
 *
 * Production builds pass their own key and id (EXTENSION_PUBLIC_KEY and
 * EXTENSION_ID); the build checks that they match.
 */
export const DEVELOPMENT_EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApigyaz+tQLYjzeFuUxlWxxblzT92L3MKDAnMY4VBMTj8xAjBWe/SNMiuGCleGTaPlnWxgjdqleWQjYdshHJG9chDws8iMlKwdYlNsq1uTQ2T5W+Sy1xuAFYsmBe41odaaoEhtyYu2jVvrOGarjnA6kBwla2jMXGjjovV92jS7nY5J48fPZ113MTCeO0v+hH/emwEqAUU/v7gFEltQc1BmiKEi2aMD2PiOQyQ7zBjTkWuI6+PJNC400iaGY+tcG7KZUfyLXnMKn2O1DAmcXjuGsLa+g7ZjAJaSGRnejjNdrXTrqUDQRV8Oh1EN6OYmJS5d2kd0s1/H94GQh93veWg9QIDAQAB'

export const DEVELOPMENT_EXTENSION_ID = 'ebdclkadgcmjipockfofmlakcfijojko'

export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/

export function isExtensionId(value: string): boolean {
  return EXTENSION_ID_PATTERN.test(value)
}

/** Maps the hex SHA-256 digest of a DER public key to the id Chrome assigns. */
export function extensionIdFromDigestHex(digestHex: string): string {
  return digestHex
    .slice(0, 32)
    .toLowerCase()
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
}

/** `chrome-extension://<id>`, the Origin of requests sent by the extension's service worker. */
export function extensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}`
}
