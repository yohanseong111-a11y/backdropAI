import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("the general AI route receives the same final speck cleanup as the background-first route",async()=>{
  const source=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
  const generalRoute=source.slice(source.indexOf("async function chooseSafeCutout"),source.indexOf("function nextFrame"));
  assert.match(generalRoute,/return await cleanupDisconnectedSpecks\(blob\)/);
});
