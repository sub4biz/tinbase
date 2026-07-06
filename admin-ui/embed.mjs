/** Wraps the built single-file dashboard into src/admin/ui.ts (a TS string export). */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, 'dist', 'index.html'), 'utf8')
const escaped = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

const out = `/**
 * tinbase studio — the dashboard served at /_/.
 *
 * GENERATED FILE. Do not edit by hand.
 * Source: admin-ui/ (React + Radix + Tailwind v4), built to one self-contained
 * HTML file so it ships inside the tinbase single binary.
 * Rebuild: cd admin-ui && npm run build
 */
export const ADMIN_HTML = \`${escaped}\`
`
writeFileSync(join(here, '..', 'src', 'admin', 'ui.ts'), out)
console.log(`embedded ${(html.length / 1024).toFixed(0)} kB into src/admin/ui.ts`)
