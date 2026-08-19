const CACHE = "backshotai-shell-v49";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if(event.request.method !== "GET")return;
  const url=new URL(event.request.url);
  if(url.origin !== self.location.origin){
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(response=>{
        // Transformers.js maintains its own model cache. Avoid storing a
        // second 44/88 MB copy in the service-worker shell cache.
        const isModel=url.pathname.includes("/models/");
        if(response.ok&&!isModel){
          const copy=response.clone();
          caches.open(CACHE).then(cache=>cache.put(event.request,copy)).catch(()=>{});
        }
        return response;
      })
      .catch(async()=>{
        const cached=await caches.match(event.request);
        if(cached)return cached;
        // An HTML fallback is valid only for page navigation. Returning HTML
        // for a missing script, worker, WASM file or image causes MIME errors.
        if(event.request.mode==="navigate")return caches.match("./index.html");
        return Response.error();
      })
  );
});
