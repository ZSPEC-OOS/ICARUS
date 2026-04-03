// ─── Shared base64 helpers ────────────────────────────────────────────────────
// Used by githubService, shadowContext, and agentExecutor.
// Centralised here so the decoding logic is not duplicated across three files.

// Decode GitHub API base64 content (which wraps at 60 chars with newlines).
export function decodeBase64(encoded) {
  return atob(encoded.replace(/\n/g, ''))
}

// UTF-8-safe base64 encode — handles non-ASCII characters correctly.
// btoa() alone only works on latin-1 strings, so we go through encodeURIComponent.
export function encodeBase64(str) {
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) =>
      String.fromCharCode(parseInt(p1, 16))
    )
  )
}
