import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const sw = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

function registeredVersion() {
  const match = main.match(/serviceWorker\.register\("\.\/sw\.js\?v=(\d+)"\)/);
  assert.ok(match, "main.js must register sw.js with a cache-busting version");
  return match[1];
}

function cacheVersion() {
  const match = sw.match(/const CACHE = "backshotai-shell-v(\d+)"/);
  assert.ok(match, "sw.js must name the shell cache with a version");
  return match[1];
}

test("a new service worker activates immediately and claims open tabs", () => {
  assert.match(sw, /self\.skipWaiting\(\)/);
  assert.match(sw, /self\.clients\.claim\(\)/);
});

test("HTML and hashed bundles always come from the network, not a stale cache", () => {
  assert.match(sw, /cache:"reload"/);
  assert.match(sw, /event\.request\.mode==="navigate"/);
  assert.match(sw, /url\.pathname\.includes\("\/assets\/"\)/);
});

test("an already-controlled tab reloads when the new worker claims it", () => {
  const boot = main.slice(main.indexOf('if("serviceWorker" in navigator)'));
  assert.match(boot, /if\(navigator\.serviceWorker\.controller\)/);
  assert.match(boot, /addEventListener\("controllerchange"/);
  assert.match(boot, /window\.location\.reload\(\)/);
  assert.ok(
    boot.indexOf("navigator.serviceWorker.controller") < boot.indexOf("controllerchange"),
    "only already-controlled tabs should reload, so a first visit is not a double load"
  );
  assert.ok(
    boot.indexOf("controllerchange") < boot.indexOf("serviceWorker.register"),
    "listen for the claim before registering so an update cannot be missed"
  );
});

test("the registered worker URL and the shell cache share one version", () => {
  assert.equal(registeredVersion(), cacheVersion());
});
