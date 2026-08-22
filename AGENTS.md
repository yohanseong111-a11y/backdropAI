# AGENTS.md

## Cursor Cloud specific instructions

BackshotAI/BackdropAI is a **100% client-side** Vite web app (browser-based bulk
background removal). There is no backend, database, or auth — everything runs in
the browser via Transformers.js + ONNX Runtime Web. Node 22 is required (matches
`.github/workflows/ci.yml`).

Standard commands live in `package.json` (`dev`, `lint`, `test`, `build`) and are
documented in `README.md`; use those rather than duplicating them here. Tests
(`npm test`) and lint (`npm run lint`) are pure Node checks and do NOT need the AI
model or a browser. The default `npm run build` intentionally skips downloading
model weights unless `CI=true` or `BACKSHOTAI_PREPARE_MODELS=1` is set.

### Gotcha: running background removal in the dev server needs local model files

The removal worker (`src/removal-worker.js`) loads the RMBG-1.4 model from the
**same origin** (`/models/...`) first, and only falls back to Hugging Face if the
local fetch fails. In the Vite dev server, a missing `/models/...` path returns
`index.html` with HTTP 200 (SPA fallback), NOT a 404 — so Transformers.js parses
HTML as JSON, throws `Unexpected token '<'`, and never reaches the Hugging Face
fallback. As a result, the AI background-removal feature cannot run in `npm run dev`
until the model files are present under `public/models/` (which is gitignored).

To exercise background removal locally, populate the model files once (they persist
in the working tree; they are large — ~130 MB total):

```bash
# ONNX weights (with checksum + retries), into public/models/briaai/RMBG-1.4/onnx/
BACKSHOTAI_PREPARE_MODELS=1 node scripts/prepare-models.mjs

# Small config files the dev server must also serve same-origin:
REV=5d9eda8f5384c94a951fcb225b34922bc03536dc
BASE="https://huggingface.co/briaai/RMBG-1.4/resolve/$REV"
curl -fsSL "$BASE/config.json"               -o public/models/briaai/RMBG-1.4/config.json
curl -fsSL "$BASE/preprocessor_config.json"  -o public/models/briaai/RMBG-1.4/preprocessor_config.json
```

Then run `npm run dev`, upload an image, and click "Remove all backgrounds".

Note: Transformers.js caches model fetches in the browser's Cache Storage
(`useBrowserCache=true`). If you ever loaded the app while model files were missing,
a bad HTML response can be cached and keep failing. Clear it via DevTools →
Application → "Clear site data" (or `caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k))))`),
then hard-reload.
