const C = "bitacora-v49";
const SHELL = ["./", "./index.html", "./app.js", "./firebase-config.js", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  const guardar = (r) => {
    const copia = r.clone();
    caches.open(C).then((c) => c.put(e.request, copia));
    return r;
  };
  if (u.origin === location.origin) {
    // Archivos de la app: primero red (para recibir cambios), si no hay internet usa la copia guardada
    e.respondWith(fetch(e.request).then(guardar).catch(() => caches.match(e.request)));
  } else if (u.hostname.endsWith("gstatic.com")) {
    // Librerías de Firebase: primero la copia guardada
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then(guardar)));
  }
});

// Recibe notificaciones push en segundo plano (FCM)
self.addEventListener("push", (e) => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch {}
  const notif = payload.notification || payload.data || {};
  const titulo = notif.title || "Bitácora de taller";
  const cuerpo = notif.body || "Tienes equipos sin movimiento.";
  e.waitUntil(
    self.registration.showNotification(titulo, {
      body: cuerpo,
      icon: "./icon.svg",
      tag: "bitacora-rezago",
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((lista) => {
      for (const c of lista) {
        if ("focus" in c) return c.focus();
      }
      return clients.openWindow("./");
    })
  );
});