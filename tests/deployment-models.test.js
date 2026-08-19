import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("deployed workers use same-origin models instead of a filterable third-party host",async()=>{
  const worker=await readFile(new URL("../src/removal-worker.js",import.meta.url),"utf8");
  const workflow=await readFile(new URL("../.github/workflows/deploy-pages.yml",import.meta.url),"utf8");
  assert.match(worker,/env\.allowRemoteModels=false/);
  assert.match(worker,/env\.localModelPath=new URL\("\.\.\/models\/",self\.location\.href\)\.href/);
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
