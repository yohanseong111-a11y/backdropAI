# BackdropAI Web / PWA

This is the web version of BackdropAI focused on the workflow:

**Bulk select → remove all backgrounds → choose one replacement background → apply to all → adjust subject/shadow → download all.**

## Why this version

- Works on Windows.
- Works on iPhone in Safari.
- Can be added to the iPhone Home Screen as a PWA.
- No Mac, Xcode, TestFlight or paid Apple Developer membership is required.
- Background removal is performed in the browser using `@imgly/background-removal`.
- One replacement background is applied to the entire batch.
- Finished images are exported together as a ZIP.

## Run on Windows

Install Node.js first, then open PowerShell in this folder:

```powershell
npm install
npm run dev
```

Vite will print a local URL such as:

```text
http://localhost:5173
```

Open it in Chrome/Edge.

## Test on your iPhone on the same Wi-Fi

Run:

```powershell
npm run dev -- --host
```

Vite will show a network URL similar to:

```text
http://192.168.1.10:5173
```

Open that address in Safari on your iPhone while the phone and PC are connected to the same Wi-Fi.

Note: PWA/service-worker installation generally requires HTTPS when deployed publicly. Local LAN testing may still open as a normal website.

## Put it online

The built site can be deployed to a static host such as Cloudflare Pages, Netlify, Vercel or GitHub Pages.

Build:

```powershell
npm run build
```

The production files appear in `dist/`.

## Add it to iPhone Home Screen

After deploying to HTTPS:

1. Open the website in Safari.
2. Tap Share.
3. Tap **Add to Home Screen**.
4. Launch BackdropAI from the new icon.

## Privacy / model note

`@imgly/background-removal` runs the segmentation model in the browser, so images do not need to be uploaded to your own server for normal background removal.

The package is currently provided under the AGPL-3.0 license. If you deploy or distribute a modified application using it, review the license obligations and make the corresponding source available where required. If you later want a closed-source commercial product, switch to a model/library with licensing that matches that use case or obtain a commercial license.

## Current feature set

- Multi-image selection.
- Bulk background removal.
- Local browser processing.
- Transparent background output.
- Solid-colour replacement.
- One photo background applied to every selected image.
- Batch subject scale.
- Batch horizontal/vertical subject position.
- Adjustable shadow strength, softness and distance.
- Preview grid.
- Remove individual items.
- Add more photos to an existing batch.
- ZIP download.
- PWA manifest + service worker shell.
- Mobile/iPhone responsive layout.

## Practical performance note

In-browser AI is memory-intensive. On an iPhone, start with smaller batches (for example 5–15 high-resolution photos) and increase from there. The UI supports much larger selections, but available memory is ultimately controlled by the browser/device.
