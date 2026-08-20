import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("the general AI route receives the same final speck cleanup as the background-first route",async()=>{
  const source=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
  const generalRoute=source.slice(source.indexOf("async function chooseSafeCutout"),source.indexOf("function nextFrame"));
  assert.match(generalRoute,/let clean=await cleanupDisconnectedSpecks\(blob,file\)/);
  assert.match(generalRoute,/return clean/);
});

test("grass cleanup cannot erase confident jacket pixels and uses a smooth high-resolution matte",async()=>{
  const source=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
  assert.match(source,/alpha\[i\]>=176/);
  assert.match(source,/const grassLike=.*hueDistance<34/);
  assert.match(source,/const maxSide=720/);
  assert.match(source,/globalCompositeOperation="destination-in"/);
  assert.match(source,/imageSmoothingQuality="high"/);
});

test("batch inference cannot overlap one ONNX session and always releases UI state",async()=>{
  const source=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
  const queue=source.slice(source.indexOf("async function processRemovalQueue"),source.indexOf("async function removeSelectedBackgrounds"));
  assert.match(queue,/for\(const item of queue\)/);
  assert.doesNotMatch(queue,/Promise\.all\(chunk\.map/);
  assert.match(queue,/finally\{/);
  assert.match(queue,/state\.processing=false/);
});

test("mobile mask application cleans compact alpha and composites it only once",async()=>{
  const source=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
  const apply=source.slice(source.indexOf("async function applyDualMaskToFile"),source.indexOf("function warmBackshotEngine"));
  assert.match(apply,/removeTinyForegroundIslands\(protectedAlpha,maskWidth,maskHeight\)/);
  assert.match(apply,/globalCompositeOperation="destination-in"/);
  assert.doesNotMatch(apply,/scaled\.width=ow/);
  assert.doesNotMatch(apply,/getImageData\(0,0,ow,oh\)/);
});

test("Fast Mobile adaptively refines only suspicious residual edges",async()=>{
  const source=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
  const route=source.slice(source.indexOf("async function chooseSafeCutout"),source.indexOf("function nextFrame"));
  assert.match(route,/state\.quality==="fast"&&await suspiciousResidualRatio\(clean\)>\.00025/);
  assert.match(route,/removeWithBackshotEngine\(file,undefined,0,"auto"\)/);
  assert.match(route,/refineResidualBackground\(clean,evidence,file\)/);
});
