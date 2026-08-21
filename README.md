# BackshotAI

Bulk background removal and product-photo editor for desktop and mobile browsers.
Everything runs locally: no API key, no per-image fees, no uploads.

## How it works

1. **Segmentation.** `src/removal-worker.js` runs RMBG-1.4 through Transformers.js in
   a worker, off the UI thread. Inference happens on a square between 320 and
   1024px depending on the chosen profile and the device.
2. **Refinement.** `src/mask-refine.js` turns that small mask into a clean cutout.
   Because the mask is a fraction of a phone photo's resolution, a plain upscale
   leaves soft edges, a halo of original background and thin gaps filled in. The
   refinement pass works at a bounded working resolution against the real photo
   pixels: a colour guided filter snaps the mask onto real image edges, local
   colour models learn what foreground and background look like in each part of
   the frame, and background that is connected to proven transparency is reclaimed
   without crossing object outlines. Every stage is rolled back if the subject
   loses its extent.
3. **Compositing.** The refined mask is applied to the untouched original at full
   size, so exports are never cropped or stretched. Soft edge pixels are unmixed
   in horizontal strips, which keeps peak memory low on large photos.
4. **Correction.** `src/assist.js` powers AI Assist in the cutout editor: a
   target-guided local segmentation correction that can only ever change pixels
   inside the visible circle.

## Development

```bash
npm install
npm run dev      # dev server
npm run lint     # syntax check every module
npm test         # algorithmic and wiring tests
npm run build    # production build
```

`npm run build` downloads RMBG's ONNX weights into `public/models` only in CI, or
locally with `BACKSHOTAI_PREPARE_MODELS=1`. The deployed build serves them from
its own origin, because networks that allow the site often block Hugging Face.
Without them the worker falls back to downloading from Hugging Face directly.
