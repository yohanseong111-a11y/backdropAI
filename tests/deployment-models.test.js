import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("deployed workers prefer same-origin models with a recoverable remote fallback",async()=>{
  const worker=await readFile(new URL("../src/removal-worker.js",import.meta.url),"utf8");
  const workflow=await readFile(new URL("../.github/workflows/deploy-pages.yml",import.meta.url),"utf8");
  const packageJson=await readFile(new URL("../package.json",import.meta.url),"utf8");
  const prepare=await readFile(new URL("../scripts/prepare-models.mjs",import.meta.url),"utf8");
  assert.match(worker,/env\.allowLocalModels=true/);
  assert.match(worker,/env\.allowRemoteModels=true/);
  assert.match(worker,/env\.localModelPath=new URL\("\.\.\/models\/",self\.location\.href\)\.href/);
  assert.match(packageJson,/node scripts\/prepare-models\.mjs && vite build/);
  assert.match(prepare,/process\.env\.CI!=="true"/);
  assert.match(prepare,/model_quantized\.onnx/);
  assert.match(prepare,/model_fp16\.onnx/);
  assert.match(workflow,/model_quantized\.onnx/);
  assert.match(workflow,/model_fp16\.onnx/);
  assert.match(workflow,/sha256sum --check/);
});

test("heavy GPU and preload paths are gated away from constrained devices",async()=>{
  const worker=await readFile(new URL("../src/removal-worker.js",import.meta.url),"utf8");
  const main=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
  assert.match(worker,/memory>=8&&cores>=8/);
  assert.match(main,/connection\?\.saveData/);
  assert.match(main,/memory>0&&memory<6/);
  assert.match(main,/if\(!constrained\)/);
});

test("phones use compact inference masks instead of allocating full-resolution worker masks",async()=>{
  const worker=await readFile(new URL("../src/removal-worker.js",import.meta.url),"utf8");
  assert.match(worker,/profile==="fast"\?256:profile==="best"\?512:\(IS_MOBILE\?320:512\)/);
  assert.match(worker,/RawImage\.fromTensor\(converted\.mul\(255\)\.to\("uint8"\)\)/);
  assert.doesNotMatch(worker,/fromTensor\([^\n]+\)\.resize\(width,height\)/);
  assert.match(worker,/width:mask\.width,height:mask\.height/);
  assert.match(worker,/Macintosh.*maxTouchPoints/s);
  assert.match(worker,/userAgentData\?\.mobile===true/);
});
