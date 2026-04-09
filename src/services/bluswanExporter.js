// ─── bluswanExporter ────────────────────────────────────────────────────────────
// Triggers a browser download of the BLUSWAN standalone app ZIP.
// The zip is served as a static asset from /public/bluswan-standalone.zip.

export function downloadBluswanZip() {
  const a = document.createElement('a')
  a.href = '/bluswan-standalone.zip'
  a.download = 'bluswan-standalone.zip'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
