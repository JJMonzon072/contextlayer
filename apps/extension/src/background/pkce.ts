/** Random values and PKCE S256 with WebCrypto (available in the service worker). */

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** 256 bits from the CSPRNG, base64url: 43 characters. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** RFC 7636 S256: BASE64URL(SHA-256(ASCII(verifier))). */
export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}
