// FitPunkte Service Worker: Offline-Start + Push-Nachrichten
const CACHE = "fitpunkte-v89";
const SHELL = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png", "firebase-config.js", "zxing.min.js", "bls.json", "zxingwasm.js", "zxing_reader.wasm"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  const lib = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  const font = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";

  if (same) {
    // Update-Prüfung (?v=…) immer frisch aus dem Netz
    if (url.searchParams.has("v")) return;
    // Sofort aus dem Cache starten, im Hintergrund aktualisieren (Update-Hinweis zeigt neue Version)
    e.respondWith(
      caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true }).then(hit => {
        const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; })
          .catch(() => hit || (req.mode === "navigate" ? c.match("index.html") : undefined));
        if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
        return net;
      }))
    );
  } else if (lib || font) {
    // Bibliotheken & Schrift: aus dem Cache, im Hintergrund aktualisieren
    e.respondWith(
      caches.open(CACHE).then(c => c.match(req).then(hit => {
        const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      }))
    );
  }
  // alles andere (Firebase-Datenbank, Login) geht direkt ins Netz
});

// ---------- Push ----------
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { notification: { title: "FitPunkte", body: e.data && e.data.text() } }; }
  const n = d.notification || {}, x = d.data || {};
  const title = n.title || x.title || "FitPunkte";
  const body = n.body || x.body || "";
  e.waitUntil(self.registration.showNotification(title, {
    body, icon: "icon-192.png", badge: "icon-192.png", tag: x.tag || undefined, data: { url: x.url || "./" }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    for (const c of cs) { if (c.url.startsWith(self.registration.scope)) { c.focus(); return; } }
    return self.clients.openWindow(target);
  }));
});
