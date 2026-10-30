import { defineConfig, type Plugin } from 'vite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Saved presets (presets/saved.json) and the working session, everything as
// last left (presets/session.json), live in the project while the dev server
// runs, so they survive rebuilds, reloads, ports and browsers. The page also
// keeps a copy in localStorage for builds without the dev server.
const FILES: Record<string, string> = {
  '/__presets': fileURLToPath(new URL('./presets/saved.json', import.meta.url)),
  '/__session': fileURLToPath(new URL('./presets/session.json', import.meta.url)),
}

function savedPresets(): Plugin {
  return {
    name: 'lyria-saved-presets',
    configureServer(server) {
      for (const [route, file] of Object.entries(FILES)) server.middlewares.use(route, async (req, res) => {
        if (req.method === 'GET') {
          const body = await readFile(file, 'utf8').catch(() => '{}')
          res.setHeader('Content-Type', 'application/json')
          res.end(body)
          return
        }
        if (req.method === 'PUT') {
          let body = ''
          for await (const chunk of req) body += chunk
          try {
            JSON.parse(body)
          } catch {
            res.statusCode = 400
            res.end('bad json')
            return
          }
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, body)
          res.end('ok')
          return
        }
        res.statusCode = 405
        res.end()
      })
    },
  }
}

export default defineConfig({
  build: { target: 'es2022' },
  plugins: [savedPresets()],
  // Writing the presets file shouldn't trigger a reload.
  server: { watch: { ignored: ['**/presets/**'] } },
})
