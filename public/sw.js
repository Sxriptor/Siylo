// Sylio Radio service worker.
//
// IMPORTANT: live API routes (terminal output, status, voice, desktop frames)
// must never be served from cache. v1 cached every same-origin GET with a
// cache-first strategy, so each terminal poll returned the *previous*
// response and the screen always lagged one update behind.
const CACHE_NAME = "siylo-radio-v3";
const CORE_ASSETS = ["/radio", "/manifest.webmanifest", "/radio-icon-192.png", "/radio-icon-512.png"];
const API_PREFIXES = ["/sessions/", "/desktop/", "/push/", "/health", "/voice", "/tts"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return API_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin || isApiRequest(requestUrl)) {
    // Let the network handle it directly - no caching for live data.
    return;
  }

  if (request.mode === "navigate") {
    // Network first so a fresh deploy is picked up immediately; fall back to
    // the cached shell when offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && requestUrl.pathname === "/radio") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/radio", copy));
          }
          return response;
        })
        .catch(() => caches.match("/radio").then((cached) => cached || Response.error()))
    );
    return;
  }

  const isImmutableAsset = requestUrl.pathname.startsWith("/_next/static/");
  if (isImmutableAsset) {
    // Hashed build assets never change: cache first.
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
      )
    );
    return;
  }

  // Everything else (icons, manifest): network first, cache as offline fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Response.error()))
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Siylo", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "Siylo";
  const options = {
    body: payload.body || "",
    tag: payload.tag || "siylo",
    renotify: true,
    icon: "/radio-icon-192.png",
    badge: "/radio-icon-192.png",
    vibrate: payload.kind === "input" ? [80, 60, 80, 60, 80] : [120, 60, 120],
    data: {
      sessionId: payload.sessionId || "",
      url: payload.url || "/radio"
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options).then(() => {
      if (self.navigator && "setAppBadge" in self.navigator) {
        return self.navigator.setAppBadge().catch(() => undefined);
      }
      return undefined;
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = new URL(data.url || "/radio", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          client.postMessage({ type: "open-session", sessionId: data.sessionId || "" });
          return client.focus();
        }
      }

      return self.clients.openWindow(targetUrl);
    })
  );
});
