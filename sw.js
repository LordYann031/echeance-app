// Service worker d'Échéance : permet d'ouvrir l'application sans connexion.
// - Fichiers de l'application : réseau d'abord (toujours à jour), cache en secours hors connexion.
// - Polices, icônes et bibliothèques externes : mises en cache à la première visite.
// Les données (dépenses, paiements) ne passent jamais par ici : elles restent dans le navigateur.
const CACHE = "echeance-v1";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "script.js",
  "data-sdk.js",
  "manifest.webmanifest",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!/^https?:$/.test(url.protocol)) return;

  if (url.origin === self.location.origin) {
    // Réseau d'abord, cache en secours.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((hit) => hit || caches.match("index.html"))
        )
    );
    return;
  }

  // Ressources externes (polices, Tailwind, Lucide) : cache d'abord.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response && (response.ok || response.type === "opaque")) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      });
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("./index.html");
    })
  );
});
