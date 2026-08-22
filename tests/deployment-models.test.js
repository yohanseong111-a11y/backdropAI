import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/removal-worker.js", import.meta.url), "utf8");
const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const prepare = await readFile(new URL("../scripts/prepare-models.mjs", import.meta.url), "utf8");

test("deployed workers prefer same-origin models with a recoverable remote fallback", () => {
  assert.match(worker, /env\.allowLocalModels=true/);
  assert.match(worker, /env\.allowRemoteModels=true/);
  assert.match(worker, /env\.localModelPath=new URL\("\.\.\/models\/",self\.location\.href\)\.href/);
  assert.equal(packageJson.scripts.build, "node scripts/prepare-models.mjs && vite build");
});

test("the model download step verifies what it fetched before publishing it", () => {
  assert.match(prepare, /process\.env\.CI!=="true"/);
  assert.match(prepare, /model_quantized\.onnx/);
  assert.match(prepare, /model_fp16\.onnx/);
  // Downloads land on a .part file, are hashed, and are only promoted on a match.
  assert.match(prepare, /createHash\("sha256"\)/);
  assert.match(prepare, /if\(actual!==expectedHash\)/);
  assert.match(prepare, /await rename\(partial,target\)/);
  // Hugging Face resets mid-download on GitHub-hosted runners; retry before failing CI.
  assert.match(prepare, /const downloadAttempts=4/);
  assert.match(prepare, /async function downloadVerified/);
});

test("the worker only loads models the deployment actually ships", () => {
  assert.match(worker, /const FALLBACK_MODEL_ID="briaai\/RMBG-1\.4"/);
  // BiRefNet is not published to public/models, so referencing it would make every
  // photo depend on a Hugging Face download that filtered networks block.
  assert.doesNotMatch(worker, /BiRefNet/);
  assert.doesNotMatch(worker, /loadPrimary/);
});

test("the engine warms the quantized graph immediately and keeps WebGPU gated", () => {
  assert.match(worker, /memory>=8&&cores>=8/);
  assert.match(worker, /dtype:"q8"/);
  assert.doesNotMatch(worker, /dtype:"fp16"/);
  assert.match(main, /warmBackshotEngine\(\);/);
  assert.doesNotMatch(main, /if\(!constrained\)/);
});

test("inference resolution scales with the device and the chosen profile", () => {
  assert.match(worker, /const inferenceSizeFor=profile=>/);
  const sizes = worker.match(/const inferenceSizeFor=profile=>(.+);/)[1];
  // RMBG-1.4 is a 1024px model. Small squares lose thin gaps such as the space
  // between two legs, so nothing may drop below the phone-friendly 320.
  for (const value of sizes.match(/\d+/g).map(Number)) {
    assert.ok(value >= 320, `inference size ${value} is too small to keep fine detail`);
    assert.ok(value <= 1024, `inference size ${value} exceeds the model's native resolution`);
    assert.equal(value % 32, 0, `inference size ${value} must be a multiple of 32`);
  }
});

test("phones use compact inference masks instead of allocating full-resolution worker masks", () => {
  assert.match(worker, /RawImage\.fromTensor\(tensor\.mul\(255\)\.to\("uint8"\)\)/);
  assert.doesNotMatch(worker, /fromTensor\([^\n]+\)\.resize\(width,height\)/);
  assert.match(worker, /width:mask\.width,height:mask\.height/);
  assert.match(worker, /Macintosh.*maxTouchPoints/s);
  assert.match(worker, /userAgentData\?\.mobile===true/);
});

test("the browser bundle has no unused background-removal dependency", () => {
  assert.ok(!packageJson.dependencies["@imgly/background-removal"]);
  assert.doesNotMatch(main, /@imgly\/background-removal/);
  assert.equal(packageJson.overrides.sharp, "0.35.3");
});
