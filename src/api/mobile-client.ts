import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
}

/** Serves only build-output files from the mobile PWA directory; API paths remain separately routed. */
export function registerMobileClientRoutes(server: FastifyInstance, directory: string): void {
  const root = resolve(directory)
  const serve = async (requestedPath: string, reply: FastifyReply) => {
    const pathname = requestedPath === '/' ? '/index.html' : requestedPath
    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(pathname)
    } catch {
      return reply.code(400).send({ message: 'Invalid mobile app asset path.' })
    }
    if (decodedPath.includes('\\') || decodedPath.includes('\0')) return reply.code(400).send({ message: 'Invalid mobile app asset path.' })
    const path = resolve(root, `.${decodedPath}`)
    if (path !== root && !path.startsWith(`${root}${sep}`)) return reply.code(404).send({ message: 'Mobile app asset not found.' })

    let body: Buffer
    try {
      body = await readFile(path)
    } catch {
      return reply.code(404).send({ message: 'Mobile app asset not found.' })
    }
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
    const contentType = CONTENT_TYPES[extension]
    if (!contentType) return reply.code(404).send({ message: 'Mobile app asset not found.' })
    const isHtml = extension === '.html'
    const isWorker = path.endsWith('service-worker.js')
    return reply
      .header('content-type', contentType)
      .header('cache-control', isHtml || isWorker ? 'no-cache' : 'public, max-age=31536000, immutable')
      .header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'")
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY')
      .send(body)
  }

  server.get('/', async (_request, reply) => serve('/', reply))
  server.get('/*', async (request, reply) => {
    const pathname = new URL(request.url, 'https://mobile.local').pathname
    return serve(pathname, reply)
  })
}
