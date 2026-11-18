const CACHE_NAME = 'infoflex-mobile-shell-v1'
// The build step appends the content-hashed entry assets and derives CACHE_NAME from the shell
// content, so a rebuilt app replaces the previous cache instead of being masked by a stale one.
const SHELL_PATHS = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-180.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_PATHS)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (!(url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest')) return

  event.respondWith(caches.match(request).then((cached) => {
    if (cached) return cached
    const network = fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone()
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
      }
      return response
    })
    // Only page navigations may fall back to the cached HTML shell; an offline script/style/icon
    // request must fail instead of receiving HTML in place of the asset it asked for.
    return network.catch(() => {
      if (request.mode !== 'navigate') return Response.error()
      return caches.match('/').then((shell) => shell || Response.error())
    })
  }))
})
