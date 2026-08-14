import "./style.css";
import JSZip from "jszip";
import { removeBackground } from "@imgly/background-removal";

const state = {
  items: [],
  backgroundFile: null,
  backgroundURL: null,
  bgMode: "transparent",
  solidColor: "#ffffff",
  shadow: {
    enabled: true,
    opacity: 0.22,
    blur: 24,
    offsetX: 0,
    offsetY: 18
  },
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  processing: false,
  completed: 0,
  failed: 0
};

const app = document.querySelector("#app");

app.innerHTML = `
  <header class="topbar">
    <div>
      <div class="brand">BackdropAI</div>
      <div class="subtitle">Bulk background studio</div>
    </div>
    <button id="installBtn" class="ghost hidden">Install</button>
  </header>

  <main class="page">
    <section class="hero card">
      <div class="hero-copy">
        <div class="eyebrow">PRIVATE • IN-BROWSER</div>
        <h1>Remove 1 background or 100.</h1>
        <p>Select your photos, remove every background, apply one new background to the whole batch, then download everything at once.</p>
      </div>

      <label class="upload-zone">
        <input id="photoInput" type="file" accept="image/*" multiple hidden />
        <div class="upload-icon">＋</div>
        <strong>Select photos</strong>
        <span>Choose multiple images from Photos or Files</span>
      </label>
    </section>

    <section id="workspace" class="workspace hidden">
      <aside class="controls card">
        <div class="section-title">1. Background removal</div>
        <button id="removeAllBtn" class="primary">Remove all backgrounds</button>
        <div id="progressWrap" class="progress-wrap hidden">
          <div class="progress-track"><div id="progressBar" class="progress-bar"></div></div>
          <div id="progressText" class="small"></div>
        </div>

        <div class="divider"></div>
        <div class="section-title">2. New background</div>

        <div class="segmented">
          <button data-bg="transparent" class="seg active">Transparent</button>
          <button data-bg="solid" class="seg">Colour</button>
          <button data-bg="image" class="seg">Image</button>
        </div>

        <div id="solidControls" class="inline hidden">
          <input id="solidColor" type="color" value="#ffffff" />
          <span>Choose colour</span>
        </div>

        <label id="backgroundPicker" class="file-row hidden">
          <input id="backgroundInput" type="file" accept="image/*" hidden />
          <span>Choose one background image</span>
          <b>Browse</b>
        </label>

        <div class="divider"></div>
        <div class="section-title">3. Subject</div>

        <label class="control-row">
          <span>Scale</span>
          <input id="scaleRange" type="range" min="0.55" max="1.35" step="0.01" value="1" />
        </label>
        <label class="control-row">
          <span>Horizontal</span>
          <input id="xRange" type="range" min="-30" max="30" step="1" value="0" />
        </label>
        <label class="control-row">
          <span>Vertical</span>
          <input id="yRange" type="range" min="-30" max="30" step="1" value="0" />
        </label>

        <div class="divider"></div>
        <div class="section-title">4. Shadow</div>

        <label class="toggle-row">
          <span>Realistic shadow</span>
          <input id="shadowEnabled" type="checkbox" checked />
        </label>
        <label class="control-row">
          <span>Strength</span>
          <input id="shadowOpacity" type="range" min="0" max="0.5" step="0.01" value="0.22" />
        </label>
        <label class="control-row">
          <span>Softness</span>
          <input id="shadowBlur" type="range" min="0" max="70" step="1" value="24" />
        </label>
        <label class="control-row">
          <span>Distance</span>
          <input id="shadowY" type="range" min="-30" max="70" step="1" value="18" />
        </label>

        <div class="divider"></div>
        <button id="downloadAllBtn" class="primary success">Download all as ZIP</button>
        <button id="clearBtn" class="danger ghost">Clear batch</button>

        <p class="privacy-note">Background removal runs in your browser. The first use downloads the removal model, so it can take longer.</p>
      </aside>

      <section class="gallery-shell">
        <div class="gallery-head">
          <div>
            <h2>Your batch</h2>
            <p id="batchCount">0 photos</p>
          </div>
          <button id="addMoreBtn" class="ghost">+ Add more</button>
        </div>
        <div id="gallery" class="gallery"></div>
      </section>
    </section>
  </main>

  <div id="toast" class="toast"></div>
`;

const $ = (q) => document.querySelector(q);
const gallery = $("#gallery");
const workspace = $("#workspace");
const photoInput = $("#photoInput");
const backgroundInput = $("#backgroundInput");

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2400);
}

function fileToURL(file) {
  return URL.createObjectURL(file);
}

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/"));
  if (!files.length) return;

  for (const file of files) {
    state.items.push({
      id: crypto.randomUUID(),
      name: file.name,
      file,
      originalURL: fileToURL(file),
      cutoutBlob: null,
      cutoutURL: null,
      status: "waiting",
      error: null
    });
  }

  workspace.classList.remove("hidden");
  renderGallery();
}

function renderGallery() {
  $("#batchCount").textContent = `${state.items.length} photo${state.items.length === 1 ? "" : "s"}`;

  gallery.innerHTML = state.items.map((item, index) => `
    <article class="photo-card" data-id="${item.id}">
      <div class="preview-wrap">
        <canvas class="preview-canvas" data-index="${index}"></canvas>
        <div class="status ${item.status}">${statusText(item)}</div>
      </div>
      <div class="photo-meta">
        <span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <button class="remove-one" data-remove="${item.id}" aria-label="Remove">×</button>
      </div>
    </article>
  `).join("");

  document.querySelectorAll(".remove-one").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.remove;
      const idx = state.items.findIndex(x => x.id === id);
      if (idx >= 0) {
        cleanupItem(state.items[idx]);
        state.items.splice(idx, 1);
        if (!state.items.length) workspace.classList.add("hidden");
        renderGallery();
      }
    });
  });

  requestAnimationFrame(renderAllPreviews);
}

function statusText(item) {
  if (item.status === "processing") return "Removing…";
  if (item.status === "done") return "Ready";
  if (item.status === "failed") return "Failed";
  return "Waiting";
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[c]));
}

function cleanupItem(item) {
  if (item.originalURL) URL.revokeObjectURL(item.originalURL);
  if (item.cutoutURL) URL.revokeObjectURL(item.cutoutURL);
}

async function removeAllBackgrounds() {
  if (state.processing || !state.items.length) return;

  state.processing = true;
  state.completed = 0;
  state.failed = 0;
  $("#removeAllBtn").disabled = true;
  $("#progressWrap").classList.remove("hidden");

  const queue = state.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.cutoutBlob);

  if (!queue.length) {
    state.processing = false;
    $("#removeAllBtn").disabled = false;
    updateProgress();
    toast("All backgrounds are already removed.");
    return;
  }

  const concurrency = Math.min(2, Math.max(1, navigator.hardwareConcurrency ? Math.floor(navigator.hardwareConcurrency / 4) : 1));
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const current = queue[cursor++];
      const { item } = current;
      item.status = "processing";
      renderGallery();

      try {
        const blob = await removeBackground(item.file, {
          progress: () => {}
        });
        item.cutoutBlob = blob;
        if (item.cutoutURL) URL.revokeObjectURL(item.cutoutURL);
        item.cutoutURL = URL.createObjectURL(blob);
        item.status = "done";
        item.error = null;
        state.completed++;
      } catch (error) {
        console.error(error);
        item.status = "failed";
        item.error = error?.message || "Background removal failed";
        state.failed++;
      }

      updateProgress(queue.length);
      renderGallery();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  state.processing = false;
  $("#removeAllBtn").disabled = false;
  updateProgress(queue.length);

  if (state.failed) {
    toast(`${state.completed} finished, ${state.failed} failed.`);
  } else {
    toast(`Finished ${state.completed} background removals.`);
  }
}

function updateProgress(total = state.items.length) {
  const finished = state.completed + state.failed;
  const pct = total ? Math.round((finished / total) * 100) : 0;
  $("#progressBar").style.width = `${pct}%`;
  $("#progressText").textContent = state.processing
    ? `${finished}/${total} processed`
    : `${finished}/${total} finished${state.failed ? ` • ${state.failed} failed` : ""}`;
}

async function imageFromURL(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function drawComposite(canvas, item, exportSize = null) {
  const sourceURL = item.cutoutURL || item.originalURL;
  if (!sourceURL) return;

  const subject = await imageFromURL(sourceURL);
  const sourceW = subject.naturalWidth || subject.width;
  const sourceH = subject.naturalHeight || subject.height;

  const targetW = exportSize?.width || sourceW;
  const targetH = exportSize?.height || sourceH;

  canvas.width = targetW;
  canvas.height = targetH;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, targetW, targetH);

  if (state.bgMode === "solid") {
    ctx.fillStyle = state.solidColor;
    ctx.fillRect(0, 0, targetW, targetH);
  } else if (state.bgMode === "image" && state.backgroundURL) {
    const bg = await imageFromURL(state.backgroundURL);
    drawCover(ctx, bg, targetW, targetH);
  }

  const scale = state.scale;
  const drawW = targetW * scale;
  const drawH = targetH * scale;
  const x = (targetW - drawW) / 2 + targetW * (state.offsetX / 100);
  const y = (targetH - drawH) / 2 + targetH * (state.offsetY / 100);

  if (state.shadow.enabled && item.cutoutURL) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${state.shadow.opacity})`;
    ctx.shadowBlur = state.shadow.blur * (targetW / Math.max(900, targetW));
    ctx.shadowOffsetX = state.shadow.offsetX;
    ctx.shadowOffsetY = state.shadow.offsetY * (targetH / Math.max(900, targetH));
    ctx.drawImage(subject, x, y, drawW, drawH);
    ctx.restore();
  }

  ctx.drawImage(subject, x, y, drawW, drawH);
}

function drawCover(ctx, img, width, height) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.max(width / iw, height / ih);
  const w = iw * scale;
  const h = ih * scale;
  ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
}

async function renderAllPreviews() {
  const canvases = document.querySelectorAll(".preview-canvas");
  for (const canvas of canvases) {
    const index = Number(canvas.dataset.index);
    const item = state.items[index];
    if (!item) continue;

    const cardWidth = Math.max(260, canvas.parentElement.clientWidth * 2);
    const original = await imageFromURL(item.cutoutURL || item.originalURL);
    const ratio = (original.naturalHeight || original.height) / (original.naturalWidth || original.width);
    const exportSize = {
      width: Math.round(cardWidth),
      height: Math.round(cardWidth * ratio)
    };

    await drawComposite(canvas, item, exportSize);
  }
}

async function downloadAll() {
  if (!state.items.length) return;

  const ready = state.items.filter(item => item.cutoutURL || item.originalURL);
  if (!ready.length) return;

  $("#downloadAllBtn").disabled = true;
  $("#downloadAllBtn").textContent = "Preparing ZIP…";

  try {
    const zip = new JSZip();
    let counter = 1;

    for (const item of ready) {
      const source = await imageFromURL(item.cutoutURL || item.originalURL);
      const canvas = document.createElement("canvas");
      await drawComposite(canvas, item, {
        width: source.naturalWidth || source.width,
        height: source.naturalHeight || source.height
      });

      const transparent = state.bgMode === "transparent";
      const mime = transparent ? "image/png" : "image/jpeg";
      const ext = transparent ? "png" : "jpg";

      const blob = await new Promise(resolve =>
        canvas.toBlob(resolve, mime, transparent ? undefined : 0.94)
      );

      const cleanName = (item.name.replace(/\.[^.]+$/, "") || `image-${counter}`)
        .replace(/[^\w\- ]+/g, "")
        .trim()
        .replace(/\s+/g, "-");

      zip.file(`${cleanName}-edited.${ext}`, blob);
      counter++;
    }

    const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    downloadBlob(zipBlob, `BackdropAI-${new Date().toISOString().slice(0,10)}.zip`);
    toast("ZIP ready.");
  } catch (error) {
    console.error(error);
    toast("Couldn't create the ZIP.");
  } finally {
    $("#downloadAllBtn").disabled = false;
    $("#downloadAllBtn").textContent = "Download all as ZIP";
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function setBgMode(mode) {
  state.bgMode = mode;
  document.querySelectorAll(".seg").forEach(btn =>
    btn.classList.toggle("active", btn.dataset.bg === mode)
  );
  $("#solidControls").classList.toggle("hidden", mode !== "solid");
  $("#backgroundPicker").classList.toggle("hidden", mode !== "image");
  renderAllPreviews();
}

photoInput.addEventListener("change", e => addFiles(e.target.files));
$("#addMoreBtn").addEventListener("click", () => photoInput.click());
$("#removeAllBtn").addEventListener("click", removeAllBackgrounds);
$("#downloadAllBtn").addEventListener("click", downloadAll);

$("#clearBtn").addEventListener("click", () => {
  for (const item of state.items) cleanupItem(item);
  state.items = [];
  state.completed = 0;
  state.failed = 0;
  gallery.innerHTML = "";
  workspace.classList.add("hidden");
  $("#progressWrap").classList.add("hidden");
  photoInput.value = "";
});

document.querySelectorAll(".seg").forEach(btn => {
  btn.addEventListener("click", () => setBgMode(btn.dataset.bg));
});

$("#solidColor").addEventListener("input", e => {
  state.solidColor = e.target.value;
  renderAllPreviews();
});

backgroundInput.addEventListener("change", e => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (state.backgroundURL) URL.revokeObjectURL(state.backgroundURL);
  state.backgroundFile = file;
  state.backgroundURL = URL.createObjectURL(file);
  state.bgMode = "image";
  renderAllPreviews();
  toast("Background applied to the whole batch.");
});

$("#scaleRange").addEventListener("input", e => {
  state.scale = Number(e.target.value);
  renderAllPreviews();
});
$("#xRange").addEventListener("input", e => {
  state.offsetX = Number(e.target.value);
  renderAllPreviews();
});
$("#yRange").addEventListener("input", e => {
  state.offsetY = Number(e.target.value);
  renderAllPreviews();
});
$("#shadowEnabled").addEventListener("change", e => {
  state.shadow.enabled = e.target.checked;
  renderAllPreviews();
});
$("#shadowOpacity").addEventListener("input", e => {
  state.shadow.opacity = Number(e.target.value);
  renderAllPreviews();
});
$("#shadowBlur").addEventListener("input", e => {
  state.shadow.blur = Number(e.target.value);
  renderAllPreviews();
});
$("#shadowY").addEventListener("input", e => {
  state.shadow.offsetY = Number(e.target.value);
  renderAllPreviews();
});

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("#installBtn").classList.remove("hidden");
});

$("#installBtn").addEventListener("click", async () => {
  if (!installPrompt) {
    toast("On iPhone: Safari → Share → Add to Home Screen");
    return;
  }
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("#installBtn").classList.add("hidden");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(console.warn);
  });
}
