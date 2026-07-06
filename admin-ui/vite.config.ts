import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Emits one self-contained index.html (inlined JS+CSS) so the whole dashboard
// ships inside the tinbase single binary.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: 'dist',
    // no hashed asset filenames; everything inlines
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 5000,
  },
})
