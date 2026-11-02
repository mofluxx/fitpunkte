// Minimaler Service Worker: macht die App installierbar, lädt immer frisch aus dem Netz
self.addEventListener("install",e=>self.skipWaiting());
self.addEventListener("activate",e=>self.clients.claim());
self.addEventListener("fetch",()=>{});
