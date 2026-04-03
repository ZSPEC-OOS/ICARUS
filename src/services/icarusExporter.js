// ─── icarusExporter ────────────────────────────────────────────────────────────
// Triggers a browser download of the ICARUS standalone app ZIP.
// The zip is served as a static asset from /public/icarus-standalone.zip.

export function downloadIcarusZip() {
  const a = document.createElement('a')
  a.href = '/icarus-standalone.zip'
  a.download = 'icarus-standalone.zip'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
