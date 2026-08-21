import "./style.css";
import "./editor.css";
import {chooseSafeCleanup,recoverForegroundChannel} from "./mask-safety.js";
import {refineForegroundAlpha,resampleAlpha,removeTinyForegroundIslands} from "./mask-refine.js";
import {computeAssistSelection,applyAssistSelection} from "./assist.js";
import JSZip from "jszip";

const DEFAULT_SHADOW = { enabled: false, opacity: 0.18, blur: 26, offsetY: 14 };
const DEFAULT_ADJ = () => ({
  scale: 1, offsetX: 0, offsetY: 0,
  brightness: 100, contrast: 100, saturation: 100,
  shadow: { ...DEFAULT_SHADOW }
});

const IS_MOBILE = navigator.userAgentData?.mobile === true ||
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
  (/Macintosh/i.test(navigator.userAgent) && Number(navigator.maxTouchPoints || 0) > 1);

// Resolution the mask is refined at before it is applied to the full-size photo.
// Refinement allocates a handful of float buffers per pixel, so phones stay lower.
const REFINE_MAX_SIDE = { fast: 768, auto: IS_MOBILE ? 896 : 1280, best: IS_MOBILE ? 1024 : 1440 };

const state = {
  items: [],
  selected: new Set(),
  backgroundURL: null,
  backgroundName: "",
  bgMode: "transparent",
  solidColor: "#ffffff",
  backgroundScope: "selected",
  editScopes: {position:"selected",filters:"selected",shadow:"selected"},
  processing: false,
  completed: 0,
  failed: 0,
  quality: "auto",
  editor: null,
  drag: null
};

const app = document.querySelector("#app");
app.innerHTML = `
<header class="topbar">
  <div class="brand-wrap"><img class="brand-logo" src="./icon-192.png" alt=""><div><div class="brand">BackshotAI</div><div class="subtitle">Bulk background studio</div></div></div>
  <button id="installBtn" class="ghost hidden">Install</button>
</header>

<main class="page">
  <section class="hero card">
    <div class="hero-copy">
      <div class="eyebrow">PRIVATE • IN-BROWSER</div>
      <h1>Remove 1 background or 100 in a whiff.</h1>
      <p>Remove backgrounds, replace them, then refine each product.</p>
    </div>
    <label class="upload-zone">
      <input id="photoInput" type="file" accept="image/*" multiple hidden />
      <div class="upload-icon">＋</div><strong>Select photos</strong>
      <span>Choose multiple images from Photos or Files</span>
    </label>
  </section>

  <section id="workspace" class="workspace hidden">
    <aside class="controls card">
      <div class="section-title">1. Background removal</div>
      <div class="quality-row">
        <span>Removal mode</span>
        <select id="qualityMode" aria-label="Background removal quality">
          <option value="auto">Automatic</option>
          <option value="fast">Fast Mobile</option>
          <option value="best">Best Quality</option>
        </select>
      </div>
      <div class="single-mode-badge">Backshot Engine <span id="engineStatus">Starting…</span></div>
      <div class="remove-button-stack">
        <button id="removeSelectedBtn" class="primary" disabled>Remove selected backgrounds</button>
        <button id="removeAllBtn" class="ghost remove-all-btn" disabled>Remove all backgrounds</button>
        <p id="removeHint" class="action-hint">Select photos to remove only those, or use Remove all for the whole batch.</p>
      </div>
      <div id="progressWrap" class="progress-wrap hidden">
        <div class="progress-track"><div id="progressBar" class="progress-bar"></div></div>
        <div id="progressText" class="small"></div>
      </div>
      <p class="privacy-note">Runs locally in your browser. No API key, no per-image fees, and no uploads.</p>

      <div class="divider"></div>
      <div class="section-title">2. New background</div>
      <div class="background-scope-row">
        <span>Apply background to</span>
        <div class="tool-group">
          <button id="backgroundScopeSelected" class="tool active" type="button">Selected</button>
          <button id="backgroundScopeBatch" class="tool" type="button">Whole batch</button>
        </div>
      </div>
      <div class="segmented">
        <button data-bg="transparent" class="seg active">Transparent</button>
        <button data-bg="solid" class="seg">Colour</button>
        <button data-bg="image" class="seg">Image</button>
      </div>
      <div id="solidControls" class="inline hidden">
        <input id="solidColor" type="color" value="#ffffff" /><span>Choose colour</span>
      </div>
      <label id="backgroundPicker" class="file-row hidden">
        <input id="backgroundInput" type="file" accept="image/*" hidden />
        <span>Choose one background image</span><b>Browse</b>
      </label>
      <div id="backgroundPreview" class="background-preview hidden">
        <img id="backgroundPreviewImage" alt="Current background" />
        <div><strong>Current background</strong><span id="backgroundPreviewName"></span></div>
        <button id="clearBackground" class="icon-btn mini" type="button">×</button>
      </div>
      <button id="clearSelectedBackground" class="ghost reset-btn" type="button">Remove replacement from selected</button>
      <p class="privacy-note">Keeps the existing cutout intact so you can try another colour or image.</p>

      <div class="divider"></div>
      <div class="selection-head">
        <div><div class="section-title no-margin">3. Selected photos</div><span id="selectedCount">0 selected</span></div>
        <div class="selection-actions">
          <button id="selectAll" class="text-btn" type="button">All</button>
          <button id="selectNone" class="text-btn" type="button">None</button>
        </div>
      </div>
      <p class="selection-help">Tap photos individually or click-drag across the batch to select several. Edits and “Remove selected” only affect those photos.</p>
      <div class="mini-title scope-title"><span>Position &amp; size</span><div class="tool-group scope-tools"><button class="tool active" data-edit-scope="position" data-scope="selected">Selected</button><button class="tool" data-edit-scope="position" data-scope="batch">Whole batch</button></div></div>
      <fieldset id="positionControls" disabled>
        <label class="control-row"><span>Scale</span><input id="scaleRange" type="range" min="0.55" max="1.35" step="0.01" value="1" /></label>
        <label class="control-row"><span>Horizontal</span><input id="xRange" type="range" min="-30" max="30" step="1" value="0" /></label>
        <label class="control-row"><span>Vertical</span><input id="yRange" type="range" min="-30" max="30" step="1" value="0" /></label>
      </fieldset>
      <div class="mini-title scope-title"><span>Filters</span><div class="tool-group scope-tools"><button class="tool active" data-edit-scope="filters" data-scope="selected">Selected</button><button class="tool" data-edit-scope="filters" data-scope="batch">Whole batch</button></div></div>
      <fieldset id="filterControls" disabled>
        <label class="control-row"><span>Brightness</span><input id="brightnessRange" type="range" min="50" max="150" step="1" value="100" /></label>
        <label class="control-row"><span>Contrast</span><input id="contrastRange" type="range" min="50" max="150" step="1" value="100" /></label>
        <label class="control-row"><span>Saturation</span><input id="saturationRange" type="range" min="0" max="200" step="1" value="100" /></label>
        <button id="resetSelected" class="ghost reset-btn" type="button">Reset scoped edits</button>
      </fieldset>

      <div class="divider"></div>
      <div class="section-title">4. Shadow</div>
      <div class="background-scope-row"><span>Apply shadow to</span><div class="tool-group scope-tools"><button class="tool active" data-edit-scope="shadow" data-scope="selected">Selected</button><button class="tool" data-edit-scope="shadow" data-scope="batch">Whole batch</button></div></div>
      <fieldset id="shadowControls" disabled>
        <label class="toggle-row"><span>Shadow</span><input id="shadowEnabled" type="checkbox" checked /></label>
        <label class="control-row"><span>Strength</span><input id="shadowOpacity" type="range" min="0" max="0.5" step="0.01" value="0.22" /></label>
        <label class="control-row"><span>Softness</span><input id="shadowBlur" type="range" min="0" max="70" step="1" value="24" /></label>
        <label class="control-row"><span>Distance</span><input id="shadowY" type="range" min="-30" max="70" step="1" value="18" /></label>
      </fieldset>

      <div class="divider"></div>
      <div class="section-title">5. Download</div>
      <button id="downloadSelectedBtn" class="primary success secondary-download" disabled>Download selected</button>
      <button id="downloadAllBtn" class="primary success" disabled>Download all</button>
      <p id="downloadHint" class="action-hint">Only photos that finished background removal are exported.</p>
      <button id="clearBtn" class="danger ghost">Clear batch</button>
    </aside>

    <section class="gallery-shell">
      <div class="gallery-head">
        <div><h2>Your batch</h2><p id="batchCount">0 photos</p></div>
        <div class="gallery-head-actions">
          <button id="helpBtn" class="ghost" type="button"><span class="help-glyph" aria-hidden="true">?</span> Tutorial</button>
          <button id="addMoreBtn" class="ghost" type="button">+ Add more</button>
        </div>
      </div>
      <div id="dragGuide" class="drag-guide">
        <div class="drag-guide-icon" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="drag-guide-copy"><strong>Drag to select multiple photos</strong><span>Click and drag across photo cards to select several at once.</span></div>
        <button id="dragGuideGotIt" class="guide-got-it" type="button">Got it</button>
      </div>
      <div id="gallery" class="gallery"></div>
      <div id="dragSelectBox" class="drag-select-box hidden"></div>
    </section>
  </section>
</main>

<div id="cutoutModal" class="modal hidden">
  <div class="modal-card">
    <div class="modal-head">
      <div><strong>Edit cutout</strong><span>Assisted tap or manual brush. Works with mouse and touch.</span></div>
      <button id="closeEditor" class="icon-btn">×</button>
    </div>
    <div class="editor-toolbar">
      <div class="tool-group">
        <button id="eraseTool" class="tool active">Erase</button>
        <button id="restoreTool" class="tool">Restore</button>
      </div>
      <label class="smart-toggle"><input id="assistToggle" type="checkbox" checked /> AI Assist</label>
      <label id="assistSizeRow" class="brush-row">Target <input id="assistSize" type="range" min="14" max="150" step="1" value="46" /><span id="assistSizeLabel" class="range-value">Medium</span></label>
      <label id="brushSizeRow" class="brush-row hidden">Brush <input id="brushSize" type="range" min="8" max="180" value="54" /></label>
      <button id="undoEdit" class="ghost small-btn">Undo</button>
      <button id="redoEdit" class="ghost small-btn">Redo</button>
      <div class="tool-group" aria-label="Editor zoom">
        <button id="zoomOutEditor" class="tool" type="button" aria-label="Zoom out">−</button>
        <button id="fitEditor" class="tool" type="button">Fit</button>
        <button id="zoomInEditor" class="tool" type="button" aria-label="Zoom in">＋</button>
      </div>
      <button id="smartRecover" class="ghost small-btn">Re-run removal</button>
    </div>
    <div class="editor-stage">
      <canvas id="editorCanvas"></canvas>
      <div id="assistTarget" class="assist-target"><span class="assist-target-dot"></span></div>
      <div id="brushCursor" class="brush-cursor"></div>
    </div>
    <div class="editor-foot">
      <span id="editorHint">AI Assist: place the target on an area to remove and tap once.</span>
      <button id="applyEdit" class="primary compact">Apply cutout</button>
    </div>
  </div>
</div>

<div id="helpModal" class="help-modal hidden" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
  <div class="help-card">
    <div class="help-head">
      <div><span class="help-kicker">HOW TO USE BACKSHOTAI</span><strong id="helpTitle">Quick tutorial</strong></div>
      <button id="closeHelp" class="icon-btn" type="button">×</button>
    </div>
    <div class="help-body">
      <div class="tutorial-visual" id="tutorialVisual"></div>
      <div class="tutorial-copy">
        <div class="tutorial-count" id="tutorialCount">1 / 7</div>
        <h3 id="tutorialTitle"></h3>
        <p id="tutorialText"></p>
        <ul id="tutorialPoints" class="tutorial-points"></ul>
      </div>
    </div>
    <div class="help-foot">
      <div id="tutorialDots" class="tutorial-dots"></div>
      <div class="tutorial-nav"><button id="tutorialBack" class="ghost" type="button">Back</button><button id="tutorialNext" class="primary compact" type="button">Next</button></div>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>
`;

const $ = q => document.querySelector(q);
const gallery = $("#gallery");
const workspace = $("#workspace");
const photoInput = $("#photoInput");
const backgroundInput = $("#backgroundInput");

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}
function escapeHtml(str) { return str.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }
function cleanupItem(item) {
  if (item.originalURL) URL.revokeObjectURL(item.originalURL);
  if (item.cutoutURL) URL.revokeObjectURL(item.cutoutURL);
  if (item.background?.url) URL.revokeObjectURL(item.background.url);
}
const MAX_FILE_BYTES = 80 * 1024 * 1024;
function addFiles(fileList) {
  const incoming = Array.from(fileList || []);
  const files = [];
  const rejected = [];
  for (const file of incoming) {
    if (!file.type?.startsWith("image/")) rejected.push(`${file.name} is not an image`);
    else if (file.size > MAX_FILE_BYTES) rejected.push(`${file.name} is over 80 MB`);
    else files.push(file);
  }

  for (const file of files) {
    state.items.push({
      id: crypto.randomUUID(), name: file.name, file,
      originalURL: URL.createObjectURL(file), cutoutBlob: null, cutoutURL: null,
      status: "waiting", error: null, adj: DEFAULT_ADJ(), background: null
    });
  }
  if (files.length) {
    workspace.classList.remove("hidden");
    renderGallery();
    updateSelectionUI();
  }
  // Rejecting a file must never discard the photos that did load.
  if (rejected.length) {
    toast(rejected.length === 1 ? `Skipped: ${rejected[0]}.` : `Skipped ${rejected.length} files that are not usable images.`);
  } else if (!files.length && incoming.length) {
    toast("No usable images in that selection.");
  }
}
function isProcessed(item){ return item.status === "done" && !!item.cutoutBlob; }
function processedItems(items){ return items.filter(isProcessed); }
let suppressNextCardClick = false;
function statusText(item) {
  return item.status === "processing" ? "Removing…" : item.status === "revealing" ? "Cleaned" : item.status === "done" ? "Ready" : item.status === "failed" ? "Failed" : "Waiting";
}
function toggleSelected(id) {
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  updateSelectionClasses(); updateSelectionUI();
}
function selectedItems(){ return state.items.filter(i=>state.selected.has(i.id)); }
function updateSelectionClasses(){
  for(const card of gallery.querySelectorAll(".photo-card")){
    const selected=state.selected.has(card.dataset.card);
    card.classList.toggle("selected",selected);
    const chip=card.querySelector(".select-chip");if(chip)chip.textContent=selected?"✓":"";
  }
}
function renderGallery() {
  $("#batchCount").textContent = `${state.items.length} photo${state.items.length === 1 ? "" : "s"}`;
  gallery.innerHTML = state.items.map((item,index)=>`
    <article class="photo-card ${state.selected.has(item.id) ? "selected" : ""}" data-card="${item.id}">
      <div class="preview-wrap ${item.status === "processing" ? "scanning" : ""} ${item.status === "revealing" ? "revealing" : ""}">
        ${item.status === "processing" ? `<img class="processing-original" src="${item.originalURL}" alt="" /><div class="scan-track"><div class="scan-glow"></div><div class="scan-line"></div></div>` : item.status === "revealing" ? `
          <img class="reveal-original" src="${item.originalURL}" alt="" />
          <img class="reveal-cutout" src="${item.cutoutURL}" alt="" />
          <div class="reveal-scan-line"></div>
        ` : `<canvas class="preview-canvas" data-index="${index}"></canvas>`}
        <button class="select-chip" data-select="${item.id}" type="button">${state.selected.has(item.id) ? "✓" : ""}</button>
        <div class="status ${item.status}" title="${item.error ? escapeHtml(item.error) : ""}">${statusText(item)}</div>
      </div>
      <div class="photo-actions">
        <button class="edit-cutout ${item.cutoutURL ? "" : "disabled"}" data-edit="${item.id}" ${item.cutoutURL ? "" : "disabled"}>Edit cutout</button>
        <button class="remove-one" data-remove="${item.id}">×</button>
      </div>
      <div class="photo-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
    </article>`).join("");

  document.querySelectorAll("[data-card]").forEach(card=>card.onclick=e=>{
    if(e.target.closest("button") || suppressNextCardClick) return;
    toggleSelected(card.dataset.card);
  });
  document.querySelectorAll(".select-chip").forEach(btn=>btn.onclick=e=>{e.stopPropagation();toggleSelected(btn.dataset.select);});
  document.querySelectorAll(".remove-one").forEach(btn=>btn.onclick=e=>{
    e.stopPropagation(); const idx=state.items.findIndex(x=>x.id===btn.dataset.remove);
    if(idx>=0){state.selected.delete(state.items[idx].id);cleanupItem(state.items[idx]);state.items.splice(idx,1);if(!state.items.length)workspace.classList.add("hidden");renderGallery();updateSelectionUI();}
  });
  document.querySelectorAll(".edit-cutout").forEach(btn=>btn.onclick=e=>{e.stopPropagation();openEditor(btn.dataset.edit);});
  requestAnimationFrame(renderAllPreviews);
}

function updateSelectionUI(){
  const items=selectedItems(), first=items[0];
  const selectedPending=items.filter(item=>!item.cutoutBlob).length;
  const allPending=state.items.filter(item=>!item.cutoutBlob).length;
  const selectedReady=processedItems(items).length;
  const allReady=processedItems(state.items).length;

  $("#removeSelectedBtn").disabled=state.processing||!selectedPending;
  $("#removeAllBtn").disabled=state.processing||!allPending;
  $("#downloadSelectedBtn").disabled=state.processing||!selectedReady;
  $("#downloadAllBtn").disabled=state.processing||!allReady;
  $("#removeHint").textContent=
    !state.items.length?"Add photos to get started."
    :!items.length?"Nothing selected — tap photos or drag across them, or use Remove all."
    :!selectedPending?`All ${items.length} selected photo${items.length===1?"":"s"} already done. Remove all covers the rest.`
    :`Ready to process ${selectedPending} of ${items.length} selected photo${items.length===1?"":"s"}.`;
  $("#downloadHint").textContent=
    !allReady?"Finish background removal first — only completed cutouts can be exported."
    :`${selectedReady} selected and ${allReady} total cutout${allReady===1?"":"s"} ready to export.`;

  $("#selectedCount").textContent=`${items.length} selected`;
  $("#positionControls").disabled=state.editScopes.position==="selected"&&!items.length;
  $("#filterControls").disabled=state.editScopes.filters==="selected"&&!items.length;
  $("#shadowControls").disabled=state.editScopes.shadow==="selected"&&!items.length;
  const clearSelected=$("#clearSelectedBackground");if(clearSelected)clearSelected.disabled=!items.length;
  if(first){
    const background=backgroundFor(first);
    document.querySelectorAll(".seg").forEach(button=>button.classList.toggle("active",button.dataset.bg===background.mode));
    $("#solidControls").classList.toggle("hidden",background.mode!=="solid");
    $("#backgroundPicker").classList.toggle("hidden",background.mode!=="image");
    if(background.mode==="solid")$("#solidColor").value=background.color||state.solidColor;
    if(background.mode==="image"&&background.url){
      $("#backgroundPreviewImage").src=background.url;
      $("#backgroundPreviewName").textContent=background.name||"Selected background";
      $("#backgroundPreview").classList.remove("hidden");
    }else $("#backgroundPreview").classList.add("hidden");
    $("#scaleRange").value=first.adj.scale; $("#xRange").value=first.adj.offsetX; $("#yRange").value=first.adj.offsetY;
    $("#brightnessRange").value=first.adj.brightness; $("#contrastRange").value=first.adj.contrast; $("#saturationRange").value=first.adj.saturation;
    const shadowCfg=first.adj.shadow||{...DEFAULT_SHADOW};
    $("#shadowEnabled").checked=shadowCfg.enabled; $("#shadowOpacity").value=shadowCfg.opacity; $("#shadowBlur").value=shadowCfg.blur; $("#shadowY").value=shadowCfg.offsetY;
  }
}
function editTargets(category){
  const items=state.editScopes[category]==="batch"?state.items:selectedItems();
  if(!items.length)toast(state.editScopes[category]==="batch"?"Add photos first.":"Select one or more photos first.");
  return items;
}
function applyScopedEdit(category,key,value){
  const items=editTargets(category);if(!items.length)return;
  for(const item of items)item.adj[key]=value;
  schedulePreviewRender();
}
function applyScopedShadow(key,value){
  const items=editTargets("shadow");if(!items.length)return;
  for(const item of items){
    item.adj.shadow ||= {...DEFAULT_SHADOW};
    item.adj.shadow[key]=value;
  }
  schedulePreviewRender();
}

async function alphaStats(blob) {
  const bmp = await createImageBitmap(blob);
  const maxSide=256,s=Math.min(1,maxSide/Math.max(bmp.width,bmp.height));
  const c=document.createElement("canvas");c.width=Math.max(1,Math.round(bmp.width*s));c.height=Math.max(1,Math.round(bmp.height*s));
  const ctx=c.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0,c.width,c.height);
  const d=ctx.getImageData(0,0,c.width,c.height).data;let visible=0,strong=0;
  for(let i=3;i<d.length;i+=4){if(d[i]>8)visible++;if(d[i]>160)strong++;}
  const total=d.length/4;return {visible:visible/total,strong:strong/total};
}


async function decontaminateMatteBoundary(rgba,source,alpha,w,h){
  // Source edge pixels are commonly a blend C=aF+(1-a)B. Recover F using
  // nearby pixels the matte already proved are background. Only partial-alpha
  // boundary RGB is corrected; opaque product pixels and the alpha shape stay.
  const radius=4;
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
    const i=y*w+x,a=alpha[i];if(a<=24||a>=252)continue;
    let br=0,bg=0,bb=0,count=0;
    for(let oy=-radius;oy<=radius;oy++)for(let ox=-radius;ox<=radius;ox++){
      if(ox*ox+oy*oy>radius*radius)continue;
      const nx=x+ox,ny=y+oy;if(nx<0||ny<0||nx>=w||ny>=h)continue;
      const ni=ny*w+nx;if(alpha[ni]>=24)continue;
      const no=ni*4;br+=source[no];bg+=source[no+1];bb+=source[no+2];count++;
    }
    if(!count)continue;
    br/=count;bg/=count;bb/=count;
    const o=i*4;
    rgba[o]=recoverForegroundChannel(source[o],br,a);
    rgba[o+1]=recoverForegroundChannel(source[o+1],bg,a);
    rgba[o+2]=recoverForegroundChannel(source[o+2],bb,a);
    }
    // Prevent long full-resolution edge passes from starving scrolling,
    // progress animation and mobile browser watchdogs.
    if(y&&y%128===0)await new Promise(resolve=>setTimeout(resolve,0));
  }
}


function rgbToHsv(r,g,b){
  r/=255;g/=255;b/=255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  let hue=0;
  if(delta){
    if(max===r)hue=60*(((g-b)/delta)%6);
    else if(max===g)hue=60*((b-r)/delta+2);
    else hue=60*((r-g)/delta+4);
  }
  if(hue<0)hue+=360;
  return [hue,max?delta/max:0,max];
}

async function conservativeCloseupFallback(file){
  // Only remove a dominant border background connected to the outer edge.
  // This is intentionally conservative: when uncertain, keep the product.
  const bmp=await createImageBitmap(file);
  const maxSide=720,s=Math.min(1,maxSide/Math.max(bmp.width,bmp.height));
  const w=Math.max(64,Math.round(bmp.width*s)),h=Math.max(64,Math.round(bmp.height*s));
  const c=document.createElement("canvas");c.width=w;c.height=h;
  const ctx=c.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0,w,h);
  const img=ctx.getImageData(0,0,w,h),d=img.data;

  // Sample the top border heavily: product closeups often touch side/bottom edges.
  const samples=[];
  const rows=Math.max(3,Math.round(h*.045));
  for(let y=0;y<rows;y+=2){
    for(let x=0;x<w;x+=3){
      const o=(y*w+x)*4;samples.push([d[o],d[o+1],d[o+2]]);
    }
  }
  if(samples.length<20)return null;

  // Median RGB gives a robust background seed even with texture such as grass.
  const med=k=>{const a=samples.map(v=>v[k]).sort((a,b)=>a-b);return a[(a.length/2)|0];};
  const seed=[med(0),med(1),med(2)];
  const [seedHue,seedSat]=rgbToHsv(seed[0],seed[1],seed[2]);
  const greenDominantSeed=seed[1]>seed[2]*1.05&&seed[1]>seed[0]*1.15;

  let spread=0;
  for(const p of samples)spread+=Math.hypot(p[0]-seed[0],p[1]-seed[1],p[2]-seed[2]);
  spread/=samples.length;
  const tol=Math.max(58,Math.min(125,spread*2.2+42));

  const candidate=new Uint8Array(w*h);
  for(let i=0;i<w*h;i++){
    const o=i*4;
    const dist=Math.hypot(d[o]-seed[0],d[o+1]-seed[1],d[o+2]-seed[2]);
    const [hue,sat]=rgbToHsv(d[o],d[o+1],d[o+2]);
    let hueDistance=Math.abs(hue-seedHue);hueDistance=Math.min(hueDistance,360-hueDistance);
    // Saturated backgrounds such as grass are separated by hue as well as
    // colour distance, preventing cyan/blue garments from joining the flood.
    const hueCompatible=seedSat<.16||(sat>.10&&hueDistance<44);
    const grassLike=d[o+1]>d[o]*1.10&&d[o+1]>d[o+2]*1.035&&hueDistance<34;
    // For a grass seed, broad RGB distance is not sufficient: dark navy can
    // be numerically close to shadowed grass. Require green hue dominance.
    if(dist<tol&&hueCompatible&&(!greenDominantSeed||grassLike))candidate[i]=1;
  }

  // Flood background-colour candidates from every frame edge. Hue gating above
  // keeps edge-touching garments, while reaching floor/grass regions split by
  // sleeves, phones or props.
  const bg=new Uint8Array(w*h),q=[];
  const push=(x,y)=>{const i=y*w+x;if(candidate[i]&&!bg[i]){bg[i]=1;q.push(i);}};
  for(let x=0;x<w;x++){push(x,0);push(x,h-1);}
  for(let y=0;y<h;y++){push(0,y);push(w-1,y);}
  for(let qi=0;qi<q.length;qi++){
    const i=q[qi],x=i%w,y=(i/w)|0;
    if(x>0)push(x-1,y);if(x<w-1)push(x+1,y);if(y>0)push(x,y-1);if(y<h-1)push(x,y+1);
  }

  let bgCount=0;for(const v of bg)bgCount+=v;
  const ratio=bgCount/(w*h);
  if(new URLSearchParams(location.search).has("debugMasks"))document.documentElement.dataset.backgroundRatio=String(ratio);
  if(ratio<.025||ratio>.48)return null;

  const maskCanvas=document.createElement("canvas");maskCanvas.width=w;maskCanvas.height=h;
  const maskCtx=maskCanvas.getContext("2d"),maskImage=maskCtx.createImageData(w,h);
  for(let i=0;i<bg.length;i++){
    const o=i*4;maskImage.data[o]=maskImage.data[o+1]=maskImage.data[o+2]=255;maskImage.data[o+3]=bg[i]?0:255;
  }
  maskCtx.putImageData(maskImage,0,0);
  const full=document.createElement("canvas");full.width=bmp.width;full.height=bmp.height;
  const fctx=full.getContext("2d");fctx.drawImage(bmp,0,0);
  fctx.save();fctx.globalCompositeOperation="destination-in";fctx.imageSmoothingEnabled=true;fctx.imageSmoothingQuality="high";
  fctx.drawImage(maskCanvas,0,0,full.width,full.height);fctx.restore();
  return await new Promise(res=>full.toBlob(res,"image/png",1));
}




let removalWorker=null;
let removalSeq=0;
const removalPending=new Map();
let engineWarmStarted=false;

function rejectAllWorkerJobs(reason){
  for(const [id,job] of removalPending){
    clearTimeout(job.timeout);
    job.reject(new Error(reason));
    removalPending.delete(id);
  }
}

function destroyRemovalWorker(reason="Background-removal worker stopped."){
  if(removalWorker){
    try{removalWorker.terminate();}catch{}
    removalWorker=null;
  }
  engineWarmStarted=false;
  rejectAllWorkerJobs(reason);
}

function getRemovalWorker(){
  if(removalWorker)return removalWorker;
  try{
    removalWorker=new Worker(new URL("./removal-worker.js",import.meta.url),{type:"module"});
  }catch(error){
    throw new Error(`This browser could not start the AI worker: ${error?.message||error}`);
  }

  removalWorker.onmessage=async e=>{
    const msg=e.data||{};
    const job=removalPending.get(msg.id);

    if(msg.type==="progress"){
      if(msg.message)$("#progressText").textContent=msg.message;
      if(job?.onProgress)job.onProgress(msg);
      return;
    }
    if(msg.type==="debug-mask"&&new URLSearchParams(location.search).has("debugMasks")){
      debugMaskStage(msg.label,new Uint8Array(msg.buffer),msg.width,msg.height);
      return;
    }
    if(!job)return;

    if(msg.type==="dual-mask"){
      try{
        const blob=await applyDualMaskToFile(
          job.file,
          msg.primaryBuffer,
          msg.safetyBuffer,
          msg.width,
          msg.height,
          job.profile
        );
        clearTimeout(job.timeout);
        removalPending.delete(msg.id);
        job.resolve(blob);
      }catch(error){
        clearTimeout(job.timeout);
        removalPending.delete(msg.id);
        job.reject(error);
      }
      return;
    }

    if(msg.type==="done"){
      clearTimeout(job.timeout);
      removalPending.delete(msg.id);
      msg.blob instanceof Blob && msg.blob.size
        ? job.resolve(msg.blob)
        : job.reject(new Error("The remover returned an empty image."));
      return;
    }

    if(msg.type==="error"){
      clearTimeout(job.timeout);
      removalPending.delete(msg.id);
      job.reject(new Error(msg.error||"Background removal failed."));
    }
  };

  removalWorker.onerror=e=>{
    console.error("Backshot Engine worker crashed",e);
    destroyRemovalWorker(e?.message?`AI worker crashed: ${e.message}`:"AI worker crashed unexpectedly.");
  };
  removalWorker.onmessageerror=()=>{
    destroyRemovalWorker("The browser could not read the AI worker result.");
  };
  return removalWorker;
}



async function decodeImageForCanvas(file){
  if(typeof createImageBitmap==="function"){
    try{
      return {image:await createImageBitmap(file),close:true};
    }catch(error){
      console.warn("createImageBitmap failed; using image-element fallback",error);
    }
  }

  const url=URL.createObjectURL(file);
  try{
    const image=await new Promise((resolve,reject)=>{
      const img=new Image();
      img.onload=()=>resolve(img);
      img.onerror=()=>reject(new Error("The browser could not decode this image."));
      img.src=url;
    });
    return {image,close:false};
  }finally{
    URL.revokeObjectURL(url);
  }
}

function debugMaskStage(label,alpha,w,h){
  if(!new URLSearchParams(location.search).has("debugMasks"))return;
  let gallery=document.querySelector("#maskDebugGallery");
  if(!gallery){
    gallery=document.createElement("section");
    gallery.id="maskDebugGallery";
    gallery.style.cssText="position:relative;z-index:99999;background:#111;color:#fff;padding:20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px";
    document.body.appendChild(gallery);
  }
  const canvas=document.createElement("canvas");
  canvas.width=w;canvas.height=h;
  canvas.style.cssText="width:100%;height:auto;background:#000";
  canvas.dataset.maskStage=label;
  const ctx=canvas.getContext("2d");
  const rgba=new Uint8ClampedArray(w*h*4);
  for(let i=0;i<alpha.length;i++){
    const a=alpha[i],o=i*4;
    rgba[o]=a;rgba[o+1]=a;rgba[o+2]=a;rgba[o+3]=255;
  }
  ctx.putImageData(new ImageData(rgba,w,h),0,0);
  const figure=document.createElement("figure");
  const caption=document.createElement("figcaption");
  caption.textContent=label;
  figure.append(canvas,caption);
  gallery.appendChild(figure);
}

function breathe(){
  // Long typed-array passes must not starve the scan animation or the mobile
  // browser watchdog.
  return new Promise(resolve=>setTimeout(resolve,0));
}

function alphaToMaskCanvas(alpha,width,height){
  const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
  const rgba=new Uint8ClampedArray(alpha.length*4);
  for(let i=0;i<alpha.length;i++){
    const a=alpha[i],o=i*4;
    rgba[o]=rgba[o+1]=rgba[o+2]=255;
    rgba[o+3]=a<6?0:a>250?255:a;
  }
  canvas.getContext("2d").putImageData(new ImageData(rgba,width,height),0,0);
  return canvas;
}

/**
 * Rebuilds the true colour of semi-transparent edge pixels, which the camera
 * recorded as a blend of subject and background. Runs in horizontal strips so peak
 * memory stays a few megabytes even for a 48 MP photo.
 */
async function decontaminateEdgesInStrips(ctx,file,width,height){
  const decoded=await decodeImageForCanvas(file);
  const source=document.createElement("canvas");
  source.width=width;source.height=height;
  const sourceCtx=source.getContext("2d",{willReadFrequently:true});
  sourceCtx.drawImage(decoded.image,0,0,width,height);
  if(decoded.close)decoded.image.close?.();

  const stripHeight=Math.max(64,Math.min(512,Math.round(4e6/Math.max(1,width))));
  try{
    for(let y=0;y<height;y+=stripHeight){
      const rows=Math.min(stripHeight,height-y);
      const composed=ctx.getImageData(0,y,width,rows);
      const originalPixels=sourceCtx.getImageData(0,y,width,rows).data;
      const alpha=new Uint8Array(width*rows);
      let band=0;
      for(let i=0;i<alpha.length;i++){
        const a=composed.data[i*4+3];
        alpha[i]=a;
        if(a>24&&a<252)band++;
      }
      if(!band)continue;
      await decontaminateMatteBoundary(composed.data,originalPixels,alpha,width,rows);
      ctx.putImageData(composed,0,y);
    }
  }finally{
    source.width=0;source.height=0;
  }
}

function refineWorkingSize(width,height,profile){
  const maxSide=REFINE_MAX_SIDE[profile]||REFINE_MAX_SIDE.auto;
  const scale=Math.min(1,maxSide/Math.max(width,height));
  return {
    width:Math.max(32,Math.round(width*scale)),
    height:Math.max(32,Math.round(height*scale))
  };
}

/**
 * Turns a small inference mask into a full-resolution cutout.
 *
 * The mask is first refined against the real photo pixels at a working resolution
 * (edge-aware upsampling, local colour models, connected background reclaim), then
 * composited onto the untouched original so the exported image keeps its full size
 * and is never stretched or cropped.
 */
async function applyDualMaskToFile(file,primaryBuffer,safetyBuffer,maskWidth,maskHeight,profile=state.quality){
  if(!primaryBuffer||!maskWidth||!maskHeight){
    throw new Error("The AI returned an invalid mask.");
  }

  const rawAlpha=new Uint8Array(primaryBuffer);
  if(rawAlpha.length!==maskWidth*maskHeight){
    throw new Error("The AI mask size did not match the image.");
  }
  debugMaskStage("01-inference-mask",rawAlpha,maskWidth,maskHeight);

  const decoded=await decodeImageForCanvas(file);
  const bitmap=decoded.image;
  const fullWidth=bitmap.naturalWidth||bitmap.width;
  const fullHeight=bitmap.naturalHeight||bitmap.height;
  if(!fullWidth||!fullHeight){
    if(decoded.close)bitmap.close?.();
    throw new Error("The browser could not read this image's size.");
  }

  const work=refineWorkingSize(fullWidth,fullHeight,profile);
  const workCanvas=document.createElement("canvas");
  workCanvas.width=work.width;workCanvas.height=work.height;
  const workCtx=workCanvas.getContext("2d",{willReadFrequently:true});
  workCtx.imageSmoothingEnabled=true;workCtx.imageSmoothingQuality="high";
  workCtx.drawImage(bitmap,0,0,work.width,work.height);
  const workRGB=workCtx.getImageData(0,0,work.width,work.height).data;

  const upscaled=resampleAlpha(rawAlpha,maskWidth,maskHeight,work.width,work.height);
  debugMaskStage("02-upscaled",upscaled,work.width,work.height);

  const guard=chooseSafeCleanup(
    upscaled,
    removeTinyForegroundIslands(upscaled,work.width,work.height),
    work.width,
    work.height
  );

  const {alpha:refined,report}=await refineForegroundAlpha({
    rgb:workRGB,
    alpha:guard,
    width:work.width,
    height:work.height,
    options:{reclaim:profile==="fast"?{backgroundTolerance:54,separation:1.4}:undefined},
    breathe
  });
  debugMaskStage("03-refined",refined,work.width,work.height);
  if(new URLSearchParams(location.search).has("debugMasks")){
    document.documentElement.dataset.refineReport=JSON.stringify(report);
  }

  const maskCanvas=alphaToMaskCanvas(refined,work.width,work.height);
  const outCanvas=document.createElement("canvas");
  outCanvas.width=fullWidth;outCanvas.height=fullHeight;
  const ctx=outCanvas.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0,fullWidth,fullHeight);
  if(decoded.close)bitmap.close?.();
  ctx.save();
  ctx.globalCompositeOperation="destination-in";
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
  ctx.drawImage(maskCanvas,0,0,fullWidth,fullHeight);
  ctx.restore();

  // Unmix the soft edge so no background tint survives in semi-transparent pixels.
  await decontaminateEdgesInStrips(ctx,file,fullWidth,fullHeight);

  return new Promise((resolve,reject)=>{
    outCanvas.toBlob(
      b=>b&&b.size?resolve(b):reject(new Error("The browser could not create the cutout PNG.")),
      "image/png",
      1
    );
  });
}


function warmBackshotEngine(){
  if(engineWarmStarted)return;
  engineWarmStarted=true;

  let worker;
  try{worker=getRemovalWorker();}
  catch{
    engineWarmStarted=false;
    const status=$("#engineStatus");if(status)status.textContent="Loads on Remove";
    return;
  }

  const id=`warm-${Date.now()}`;
  const status=$("#engineStatus");
  if(status)status.textContent="Downloading AI…";

  const handler=e=>{
    const msg=e.data||{};
    if(msg.id!==id)return;
    if(msg.type==="progress"&&msg.stage==="load"&&status){
      status.textContent=`Loading ${Math.round(msg.progress||0)}%`;
    }else if(msg.type==="ready"){
      worker.removeEventListener("message",handler);
      if(status)status.textContent=msg.acceleration==="webgpu"?"AI Ready ✓ GPU":msg.acceleration==="fallback"?"AI Ready ✓ compatibility":"AI Ready ✓";
    }else if(msg.type==="error"){
      worker.removeEventListener("message",handler);
      engineWarmStarted=false;
      if(status)status.textContent="Loads on Remove";
    }
  };
  worker.addEventListener("message",handler);
  try{worker.postMessage({type:"warm",id});}
  catch{
    worker.removeEventListener("message",handler);
    engineWarmStarted=false;
    if(status)status.textContent="Loads on Remove";
  }
}

function removeWithBackshotEngine(file,onProgress,attempt=0,profile=state.quality){
  return new Promise((resolve,reject)=>{
    let worker;
    try{worker=getRemovalWorker();}catch(error){reject(error);return;}
    const id=++removalSeq;

    const timeout=setTimeout(()=>{
      removalPending.delete(id);
      destroyRemovalWorker("The AI remover timed out and was restarted.");
      if(attempt<1){
        removeWithBackshotEngine(file,onProgress,attempt+1,profile).then(resolve,reject);
      }else{
        reject(new Error("Background removal timed out twice. Try a smaller image or reload BackshotAI."));
      }
    },360000);

    removalPending.set(id,{resolve,reject,onProgress,timeout,file,profile});
    try{worker.postMessage({type:"remove",id,file,profile});}
    catch(error){
      clearTimeout(timeout);
      removalPending.delete(id);
      destroyRemovalWorker("The browser could not send the image to the AI worker.");
      if(attempt<1)removeWithBackshotEngine(file,onProgress,attempt+1,profile).then(resolve,reject);
      else reject(error);
    }
  });
}

async function chooseSafeCutout(file){
  $("#progressText").textContent="Backshot Engine: preparing…";
  if(!(file instanceof Blob)||!file.type?.startsWith("image/")){
    throw new Error("This file is not a supported image.");
  }
  if(file.size>80*1024*1024){
    throw new Error("This image is larger than 80 MB. Please use a smaller photo.");
  }

  // Segmentation first. Every profile then finishes through the same
  // refinement inside applyDualMaskToFile, so batch items cannot end up with
  // visibly different edge quality.
  try{
    const blob=await removeWithBackshotEngine(file,msg=>{
      if(msg.stage==="load"&&Number.isFinite(msg.progress)){
        $("#progressText").textContent=`Backshot Engine: loading ${Math.round(msg.progress)}%`;
      }else if(msg.stage==="remove"){
        $("#progressText").textContent="Backshot Engine: removing background…";
      }else if(msg.stage==="fast-path"){
        $("#progressText").textContent=msg.message||"Existing transparency preserved…";
      }else if(msg.stage==="fallback"){
        $("#progressText").textContent=msg.message||"Switching removal engine…";
      }
    });
    if(!(blob instanceof Blob)||!blob.size)throw new Error("The remover returned an empty result.");
    return blob;
  }catch(aiError){
    // Last resort for devices that cannot run the model at all: remove only a
    // dominant background that touches the frame edge. It is deliberately
    // conservative, so an uncertain photo keeps its subject.
    console.warn("AI removal failed; trying the edge-connected colour fallback",aiError);
    $("#progressText").textContent="Trying the offline colour fallback…";
    const fallback=await conservativeCloseupFallback(file).catch(()=>null);
    if(fallback){
      const [before,after]=await Promise.all([alphaStats(file),alphaStats(fallback)]);
      if(after.strong>0.08&&after.strong<before.strong*0.94)return fallback;
    }
    throw aiError;
  }
}


function nextFrame(){
  return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
}

async function removeOne(item,queueTotal){
  item.status="processing";
  item.error=null;
  renderGallery();
  await nextFrame();

  try{
    let blob;
    try{
      blob=await chooseSafeCutout(item.file);
    }catch(firstError){
      console.warn("First removal attempt failed; retrying once",firstError);
      destroyRemovalWorker("Restarting AI engine for retry.");
      await new Promise(resolve=>setTimeout(resolve,250));
      blob=await chooseSafeCutout(item.file);
    }

    if(!(blob instanceof Blob)||blob.size===0){
      throw new Error("The remover returned an empty image.");
    }

    item.cutoutBlob=blob;
    if(item.cutoutURL)URL.revokeObjectURL(item.cutoutURL);
    item.cutoutURL=URL.createObjectURL(blob);

    item.status="revealing";
    renderGallery();

    // Let the compositor-driven wipe finish before replacing its DOM. Cutting
    // this short caused the final frame to flash in larger batches.
    await new Promise(resolve=>setTimeout(resolve,740));

    item.status="done";
    item.error=null;
    state.completed++;
  }catch(error){
    console.error("Removal failed",error);
    item.status="failed";
    item.error=error?.message||"Background removal failed.";
    state.failed++;
    toast(`Removal failed: ${item.error}`);
  }

  updateProgress(queueTotal);
  renderGallery();
  updateSelectionUI();
}

async function processRemovalQueue(queue,label){
  if(state.processing){
    toast("A removal batch is already running.");
    return;
  }

  // Photos that already have a cutout are skipped, so pressing a button twice
  // never re-runs inference the user did not ask for.
  queue=Array.from(queue||[]).filter(item=>item&&!item.cutoutBlob);
  if(!queue.length){
    toast(`${label} already have backgrounds removed.`);
    return;
  }

  state.processing=true;
  state.completed=0;
  state.failed=0;

  $("#qualityMode").disabled=true;
  $("#progressWrap").classList.remove("hidden");
  updateSelectionUI();
  updateProgress(queue.length);

  // A single worker owns one ONNX session. Concurrent run() calls can contend
  // for the same session, and restarting one failed job would reject its peer.
  // Serial inference is more reliable and often just as fast on one GPU/CPU;
  // decoding, animation and edge cleanup still yield to the interface.
  try{
    for(const item of queue){
      await removeOne(item,queue.length);
      await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
    }
  }catch(error){
    console.error("Removal queue stopped unexpectedly",error);
    toast(`Removal queue stopped: ${error?.message||"unknown error"}`);
  }finally{
    state.processing=false;
    $("#qualityMode").disabled=false;
    updateSelectionUI();
    updateProgress(queue.length);
  }

  toast(
    state.failed
      ? `${state.completed} finished • ${state.failed} failed`
      : `Finished ${state.completed} cutout${state.completed===1?"":"s"}.`
  );
}

async function removeSelectedBackgrounds(){
  const picked=selectedItems();
  if(!picked.length){
    toast("Select one or more photos first.");
    return;
  }
  await processRemovalQueue(picked,"Selected photos");
}

async function removeAllBackgrounds(){
  if(!state.items.length){
    toast("Add some photos first.");
    return;
  }
  await processRemovalQueue(state.items,"All photos");
}

function updateProgress(total=state.items.length){
  const finished=state.completed+state.failed;
  const active=state.items.filter(i=>i.status==="processing"||i.status==="revealing").length;
  const pct=total?Math.round(finished/total*100):0;
  $("#progressBar").style.width=`${pct}%`;
  $("#progressText").textContent=state.processing
    ? `${finished}/${total} finished${active?` • ${active} removing now`:""}`
    : `${finished}/${total} finished${state.failed?` • ${state.failed} failed`:""}`;
}

async function imageFromURL(url){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=url;});}
function drawCover(ctx,img,w,h){const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height,s=Math.max(w/iw,h/ih),dw=iw*s,dh=ih*s;ctx.drawImage(img,(w-dw)/2,(h-dh)/2,dw,dh);}
function backgroundFor(item){
  return item.background||{mode:state.bgMode,color:state.solidColor,url:state.backgroundURL,name:state.backgroundName||""};
}
function replaceItemBackground(item,next){
  if(item.background?.url)URL.revokeObjectURL(item.background.url);
  item.background=next;
}
function backgroundTargets(){
  if(state.backgroundScope==="batch")return state.items;
  const items=selectedItems();
  if(!items.length)toast("Select one or more photos first, or choose Whole batch.");
  return items;
}
function applyBackgroundMode(mode){
  const targets=backgroundTargets();if(!targets.length)return false;
  if(state.backgroundScope==="batch"){
    state.bgMode=mode;
    for(const item of state.items)replaceItemBackground(item,null);
  }else{
    for(const item of targets)replaceItemBackground(item,{mode,color:state.solidColor,url:null,name:""});
  }
  renderAllPreviews();return true;
}
async function drawComposite(canvas,item,exportSize=null){
  const sourceURL=item.cutoutURL||item.originalURL;if(!sourceURL)return;const subject=await imageFromURL(sourceURL),sw=subject.naturalWidth||subject.width,sh=subject.naturalHeight||subject.height;
  const tw=exportSize?.width||sw,th=exportSize?.height||sh;canvas.width=tw;canvas.height=th;const ctx=canvas.getContext("2d");ctx.clearRect(0,0,tw,th);
  const background=backgroundFor(item);
  if(background.mode==="solid"){ctx.fillStyle=background.color||"#ffffff";ctx.fillRect(0,0,tw,th);}else if(background.mode==="image"&&background.url){drawCover(ctx,await imageFromURL(background.url),tw,th);}
  const a=item.adj||DEFAULT_ADJ(),dw=tw*a.scale,dh=th*a.scale,x=(tw-dw)/2+tw*(a.offsetX/100),y=(th-dh)/2+th*(a.offsetY/100);
  ctx.save();ctx.filter=`brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturation}%)`;
  const shadowCfg=a.shadow||{...DEFAULT_SHADOW};
  if(shadowCfg.enabled&&item.cutoutURL&&shadowCfg.opacity>0){
    // Shadow sliders are authored against a ~1000px canvas, so scale them with the
    // export size. Without this a 24px blur is invisible on a 4000px photo.
    const relative=Math.max(tw,th)/1000;
    ctx.shadowColor=`rgba(0,0,0,${shadowCfg.opacity})`;
    ctx.shadowBlur=shadowCfg.blur*relative;
    ctx.shadowOffsetY=shadowCfg.offsetY*relative;
  }
  ctx.drawImage(subject,x,y,dw,dh);ctx.restore();
}
let previewRenderFrame=0,previewRenderGeneration=0;
function schedulePreviewRender(){
  cancelAnimationFrame(previewRenderFrame);
  previewRenderFrame=requestAnimationFrame(()=>renderAllPreviews());
}
async function renderAllPreviews(){
  const generation=++previewRenderGeneration;
  await Promise.all([...document.querySelectorAll(".preview-canvas")].map(async canvas=>{
    const item=state.items[Number(canvas.dataset.index)];if(!item)return;
    try{
      const img=await imageFromURL(item.cutoutURL||item.originalURL),ratio=(img.naturalHeight||img.height)/(img.naturalWidth||img.width),w=Math.max(260,canvas.parentElement.clientWidth*2);
      const buffer=document.createElement("canvas");
      await drawComposite(buffer,item,{width:Math.round(w),height:Math.round(w*ratio)});
      if(generation!==previewRenderGeneration||!canvas.isConnected)return;
      if(canvas.width!==buffer.width)canvas.width=buffer.width;if(canvas.height!==buffer.height)canvas.height=buffer.height;
      const ctx=canvas.getContext("2d");ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(buffer,0,0);
    }catch(error){console.warn("Preview render skipped",error);}
  }));
}

/* ---------- Cutout editor ---------- */

// The AI Assist slider is expressed in on-screen pixels so the target always
// matches what the user sees, whatever the zoom level or photo resolution.
const ASSIST_SIZE_LABELS=[[26,"Small"],[70,"Medium"],[Infinity,"Large"]];
function assistDisplayDiameter(){return Number($("#assistSize").value)||46;}
function assistSizeLabel(){
  const size=assistDisplayDiameter();
  return (ASSIST_SIZE_LABELS.find(([limit])=>size<=limit)||ASSIST_SIZE_LABELS.at(-1))[1];
}
function canvasPixelsPerScreenPixel(){
  const e=state.editor;if(!e)return 1;
  const rect=e.canvas.getBoundingClientRect();
  return e.canvas.width/Math.max(1,rect.width);
}
function assistRadiusInImagePixels(){
  return Math.max(4,assistDisplayDiameter()/2*canvasPixelsPerScreenPixel());
}

async function openEditor(id){
  const item=state.items.find(x=>x.id===id);if(!item?.cutoutURL)return;
  const original=await imageFromURL(item.originalURL),cutout=await imageFromURL(item.cutoutURL),canvas=$("#editorCanvas"),max=1400,s=Math.min(1,max/Math.max(original.naturalWidth,original.naturalHeight));
  canvas.width=Math.round(original.naturalWidth*s);canvas.height=Math.round(original.naturalHeight*s);const ctx=canvas.getContext("2d",{willReadFrequently:true});ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(cutout,0,0,canvas.width,canvas.height);
  const oc=document.createElement("canvas");oc.width=canvas.width;oc.height=canvas.height;const octx=oc.getContext("2d",{willReadFrequently:true});octx.drawImage(original,0,0,canvas.width,canvas.height);
  state.editor={item,original,canvas,ctx,originalData:octx.getImageData(0,0,canvas.width,canvas.height),mode:"erase",history:[ctx.getImageData(0,0,canvas.width,canvas.height)],redo:[],drawing:false,last:null,viewScale:1,fitScale:1,panX:0,panY:0,pointers:new Map(),pinch:null};
  $("#cutoutModal").classList.remove("hidden");
  requestAnimationFrame(()=>{ fitEditorCanvasToStage(); updateEditorUI(); setupEditorEvents(); });
}
function fitEditorCanvasToStage(){
  if(!state.editor)return;
  const stage=$(".editor-stage"),canvas=state.editor.canvas;
  const pad=24,availableW=Math.max(1,stage.clientWidth-pad*2),availableH=Math.max(1,stage.clientHeight-pad*2);
  const fit=Math.min(availableW/canvas.width,availableH/canvas.height,1);
  state.editor.fitScale=fit;
  updateEditorTransform();
}
function updateEditorTransform(){
  const e=state.editor;if(!e)return;
  const scale=e.fitScale*e.viewScale;
  e.canvas.style.width=`${Math.max(1,Math.floor(e.canvas.width*scale))}px`;
  e.canvas.style.height=`${Math.max(1,Math.floor(e.canvas.height*scale))}px`;
  e.canvas.style.transform=`translate3d(${e.panX}px,${e.panY}px,0)`;
}
function setEditorZoom(next){
  const e=state.editor;if(!e)return;
  e.viewScale=Math.max(1,Math.min(8,next));
  if(e.viewScale===1){e.panX=0;e.panY=0;}
  updateEditorTransform();
}
function updateEditorUI(){
  const e=state.editor;if(!e)return;
  $("#eraseTool").classList.toggle("active",e.mode==="erase");
  $("#restoreTool").classList.toggle("active",e.mode==="restore");
  const assisted=$("#assistToggle").checked;
  $("#assistSizeRow").classList.toggle("hidden",!assisted);
  $("#brushSizeRow").classList.toggle("hidden",assisted);
  $("#assistSizeLabel").textContent=assistSizeLabel();
  $("#editorHint").textContent=assisted
    ? `AI Assist: place the target on ${e.mode==="erase"?"leftover background":"a missing part of the subject"} and tap. Only that area is analysed.`
    : e.mode==="erase"?"Manual: brush over unwanted areas.":"Manual: brush over missing parts to restore them.";
  $("#undoEdit").disabled=e.history.length<=1;
  $("#redoEdit").disabled=!e.redo.length;
  updateAssistTargetSize();
}
function updateAssistTargetSize(){
  const target=$("#assistTarget");if(!target)return;
  const size=assistDisplayDiameter();
  target.style.width=`${size}px`;
  target.style.height=`${size}px`;
  if(!$("#assistToggle").checked)target.classList.remove("show");
}
function setupEditorEvents(){
  const e=state.editor,c=e.canvas,stage=$(".editor-stage");
  stage.onwheel=ev=>{ev.preventDefault();setEditorZoom(e.viewScale*(ev.deltaY<0?1.12:.89));};
  c.onpointerdown=ev=>{
    c.setPointerCapture(ev.pointerId);e.pointers.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});
    if(e.pointers.size===2){const pts=[...e.pointers.values()];e.drawing=false;e.pinch={distance:Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y),scale:e.viewScale,midX:(pts[0].x+pts[1].x)/2,midY:(pts[0].y+pts[1].y)/2,panX:e.panX,panY:e.panY};return;}
    if(ev.button===1||ev.altKey){e.panning={x:ev.clientX,y:ev.clientY,panX:e.panX,panY:e.panY};return;}
    moveEditorCursor(ev);
    const p=pointFor(ev,c);if($("#assistToggle").checked){assistedTap(p);return;}e.drawing=true;e.last=p;paintAt(p);
  };
  c.onpointermove=ev=>{
    moveEditorCursor(ev);if(e.pointers.has(ev.pointerId))e.pointers.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});
    if(e.pointers.size===2&&e.pinch){const pts=[...e.pointers.values()],distance=Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y),midX=(pts[0].x+pts[1].x)/2,midY=(pts[0].y+pts[1].y)/2;e.viewScale=Math.max(1,Math.min(8,e.pinch.scale*distance/Math.max(1,e.pinch.distance)));e.panX=e.pinch.panX+midX-e.pinch.midX;e.panY=e.pinch.panY+midY-e.pinch.midY;updateEditorTransform();return;}
    if(e.panning){e.panX=e.panning.panX+ev.clientX-e.panning.x;e.panY=e.panning.panY+ev.clientY-e.panning.y;updateEditorTransform();return;}
    if(!e.drawing||$("#assistToggle").checked)return;const p=pointFor(ev,c);paintLine(e.last,p);e.last=p;
  };
  const finish=ev=>{e.pointers.delete(ev.pointerId);e.pinch=null;e.panning=null;if(e.drawing){e.drawing=false;pushHistory();}};
  c.onpointerup=finish;c.onpointercancel=finish;c.onpointerleave=hideEditorCursor;c.onpointerenter=ev=>moveEditorCursor(ev);
}
function pointFor(ev,c){const r=c.getBoundingClientRect();return{x:(ev.clientX-r.left)/r.width*c.width,y:(ev.clientY-r.top)/r.height*c.height};}
function brushRadius(){return Number($("#brushSize").value)/2*(state.editor.canvas.width/state.editor.canvas.getBoundingClientRect().width);}
function paintLine(a,b){const dist=Math.hypot(b.x-a.x,b.y-a.y),step=Math.max(2,brushRadius()*.25),n=Math.max(1,Math.ceil(dist/step));for(let i=1;i<=n;i++)paintAt({x:a.x+(b.x-a.x)*i/n,y:a.y+(b.y-a.y)*i/n});}
function paintAt(p){const e=state.editor,r=brushRadius(),ctx=e.ctx;ctx.save();if(e.mode==="erase"){ctx.globalCompositeOperation="destination-out";ctx.fillStyle="#000";ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();}else{ctx.globalCompositeOperation="source-over";ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.clip();const temp=document.createElement("canvas");temp.width=e.canvas.width;temp.height=e.canvas.height;temp.getContext("2d").putImageData(e.originalData,0,0);ctx.drawImage(temp,0,0);}ctx.restore();}

function assistedTap(p){
  const e=state.editor,w=e.canvas.width,h=e.canvas.height;
  const current=e.ctx.getImageData(0,0,w,h);
  const alpha=new Uint8Array(w*h);
  for(let i=0;i<alpha.length;i++)alpha[i]=current.data[i*4+3];

  const radius=assistRadiusInImagePixels();
  const selection=computeAssistSelection({
    rgb:e.originalData.data,
    alpha,
    width:w,
    height:h,
    x:p.x,
    y:p.y,
    radius,
    mode:e.mode
  });

  if(!selection){
    toast(e.mode==="erase"
      ? "Nothing to remove there. Move the target onto the leftover background."
      : "Nothing to restore there. Move the target onto the missing area.");
    return;
  }

  const changed=applyAssistSelection(current.data,e.originalData.data,w,selection,e.mode);
  if(!changed){
    toast(e.mode==="erase"?"That area is already removed.":"That area is already part of the cutout.");
    return;
  }

  e.ctx.putImageData(current,0,0);
  pushHistory();
  pulseAssistTarget();
  toast(e.mode==="erase"?"Removed the targeted area." : "Restored the targeted area.");
}
function pushHistory(){const e=state.editor;e.history.push(e.ctx.getImageData(0,0,e.canvas.width,e.canvas.height));if(e.history.length>18)e.history.shift();e.redo=[];updateEditorUI();}
function undo(){const e=state.editor;if(e.history.length<=1)return;const cur=e.history.pop();e.redo.push(cur);e.ctx.putImageData(e.history[e.history.length-1],0,0);updateEditorUI();}
function redo(){const e=state.editor;if(!e.redo.length)return;const img=e.redo.pop();e.history.push(img);e.ctx.putImageData(img,0,0);updateEditorUI();}
function moveEditorCursor(ev){
  const stage=$(".editor-stage").getBoundingClientRect();
  const assisted=$("#assistToggle").checked;
  const el=assisted?$("#assistTarget"):$("#brushCursor");
  const other=assisted?$("#brushCursor"):$("#assistTarget");
  other.classList.remove("show");
  const size=assisted?assistDisplayDiameter():Number($("#brushSize").value);
  el.classList.add("show");
  el.style.width=`${size}px`;
  el.style.height=`${size}px`;
  el.style.left=`${ev.clientX-stage.left-size/2}px`;
  el.style.top=`${ev.clientY-stage.top-size/2}px`;
}
function hideEditorCursor(){
  $("#brushCursor").classList.remove("show");
  $("#assistTarget").classList.remove("show");
}
function pulseAssistTarget(){
  const target=$("#assistTarget");
  target.classList.remove("pulse");
  // Restart the keyframes so repeated taps each get their own confirmation.
  void target.offsetWidth;
  target.classList.add("pulse");
}
async function smartRecover(){
  const e=state.editor;if(!e)return;
  const button=$("#smartRecover");let recoverURL="";
  button.disabled=true;button.textContent="Working…";
  try{
    const clean=await chooseSafeCutout(e.item.file);
    recoverURL=URL.createObjectURL(clean);
    const img=await imageFromURL(recoverURL);
    e.ctx.save();
    e.ctx.globalCompositeOperation="copy";
    e.ctx.drawImage(img,0,0,e.canvas.width,e.canvas.height);
    e.ctx.restore();
    pushHistory();toast("Removal re-run. Undo restores your previous edit.");
  }catch(err){
    console.error("Removal re-run failed",err);
    toast(`Re-run failed: ${err?.message||"this device could not complete it."}`);
  }finally{
    if(recoverURL)URL.revokeObjectURL(recoverURL);
    button.disabled=false;button.textContent="Re-run removal";
  }
}
async function applyEditor(){
  const e=state.editor;if(!e)return;
  try{
    const blob=await new Promise((resolve,reject)=>e.canvas.toBlob(value=>value?resolve(value):reject(new Error("The edited image could not be encoded.")),"image/png",1));
    e.item.cutoutBlob=blob;if(e.item.cutoutURL)URL.revokeObjectURL(e.item.cutoutURL);e.item.cutoutURL=URL.createObjectURL(blob);e.item.status="done";e.item.error=null;
    closeEditor();renderGallery();updateSelectionUI();toast("Cutout updated.");
  }catch(err){
    console.error("Cutout editor export failed",err);
    toast(`Could not save the edit: ${err?.message||"unknown error"}`);
  }
}
function closeEditor(){$("#cutoutModal").classList.add("hidden");state.editor=null;}

/* ---------- Export ---------- */
function downloadBlob(blob,filename){
  if(!(blob instanceof Blob)||!blob.size)throw new Error("The export was empty.");
  const url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download=filename;link.style.display="none";
  document.body.appendChild(link);link.click();
  setTimeout(()=>link.remove(),1000);
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function exportNameFor(item,index){
  const base=(item.name.replace(/\.[^.]+$/,"")||`image-${index}`).replace(/[^\w\- ]+/g,"").trim().replace(/\s+/g,"-");
  return base||`image-${index}`;
}
async function renderExport(item){
  const source=await imageFromURL(item.cutoutURL);
  const canvas=document.createElement("canvas");
  await drawComposite(canvas,item,{width:source.naturalWidth||source.width,height:source.naturalHeight||source.height});
  const transparent=backgroundFor(item).mode==="transparent";
  const mime=transparent?"image/png":"image/jpeg";
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(
    value=>value?resolve(value):reject(new Error(`Could not export ${item.name}.`)),
    mime,
    transparent?undefined:.95
  ));
  return {blob,ext:transparent?"png":"jpg"};
}
async function downloadItems(candidates, button, filenamePrefix, emptyMessage){
  // Only completed cutouts are exported, so a half-finished batch can never
  // silently ship original photos with their backgrounds still attached.
  const items=processedItems(candidates);
  if(!items.length){toast(emptyMessage);return;}
  const skipped=candidates.length-items.length;
  const originalText=button.textContent;
  button.disabled=true;button.textContent="Preparing…";
  try{
    if(items.length===1){
      const {blob,ext}=await renderExport(items[0]);
      downloadBlob(blob,`${exportNameFor(items[0],1)}-backshotai.${ext}`);
      toast(skipped?`1 photo downloaded • ${skipped} not processed yet.`:"Photo downloaded.");
    }else{
      const zip=new JSZip();
      let counter=1;
      for(const item of items){
        const {blob,ext}=await renderExport(item);
        zip.file(`${exportNameFor(item,counter)}-backshotai.${ext}`,blob);
        counter++;
      }
      const out=await zip.generateAsync({type:"blob",compression:"DEFLATE"});
      downloadBlob(out,`${filenamePrefix}-${new Date().toISOString().slice(0,10)}.zip`);
      toast(skipped?`ZIP ready: ${items.length} photos • ${skipped} not processed yet.`:`ZIP ready: ${items.length} photos.`);
    }
  }catch(e){console.error(e);toast(`Couldn't export: ${e?.message||"unknown export error"}`);}
  button.disabled=false;button.textContent=originalText;
  updateSelectionUI();
}
async function downloadSelected(){
  const items=selectedItems();
  await downloadItems(
    items,
    $("#downloadSelectedBtn"),
    "BackshotAI-selected",
    items.length?"None of the selected photos have finished background removal yet.":"Select one or more photos first."
  );
}
async function downloadAll(){
  await downloadItems(state.items,$("#downloadAllBtn"),"BackshotAI","No finished cutouts to download yet.");
}

// Small illustrations built from the same tokens as the app itself, so the
// tutorial reads as part of BackshotAI rather than a bolted-on component.
const tutorialArt={
  upload:`<div class="tut-art tut-upload"><div class="tut-plate"></div><div class="tut-plate"></div><div class="tut-plate"></div><span class="tut-plus">＋</span></div>`,
  select:`<div class="tut-art tut-grid">${[0,1,2,3].map(i=>`<span class="tut-cell${i===1?" picked":""}"></span>`).join("")}</div>`,
  drag:`<div class="tut-art tut-grid tut-drag">${[0,1,2,3,4,5].map(i=>`<span class="tut-cell${[0,1,3,4].includes(i)?" swept":""}"></span>`).join("")}<span class="tut-marquee"></span><span class="tut-pointer"></span></div>`,
  removeSelected:`<div class="tut-art tut-grid">${[0,1,2,3].map(i=>`<span class="tut-cell${i<2?" picked cleared":""}"></span>`).join("")}<span class="tut-sweep"></span></div>`,
  removeAll:`<div class="tut-art tut-grid">${[0,1,2,3].map(()=>`<span class="tut-cell cleared"></span>`).join("")}<span class="tut-sweep"></span></div>`,
  refine:`<div class="tut-art tut-refine"><span class="tut-subject"></span><span class="tut-target"></span></div>`,
  downloadSelected:`<div class="tut-art tut-grid">${[0,1,2,3].map(i=>`<span class="tut-cell${i===0||i===2?" picked":""}"></span>`).join("")}<span class="tut-arrow">↓</span></div>`,
  downloadAll:`<div class="tut-art tut-zip"><span class="tut-zip-body">ZIP</span><span class="tut-arrow">↓</span></div>`
};

const tutorialSteps=[
  {
    title:"Upload your images",
    text:"Tap Select photos on the home screen, or + Add more once a batch is open. Choose one image or hundreds — everything runs privately in this browser.",
    points:["JPG, PNG, HEIC and WebP are all accepted.","Unsupported files are skipped without touching the rest of your batch."],
    visual:tutorialArt.upload
  },
  {
    title:"Select individual images",
    text:"Tap a photo, or its circular tick, to select it. Tap again to unselect. The selection count in the controls panel always shows what an action will affect.",
    points:["All and None select or clear the whole batch instantly."],
    visual:tutorialArt.select
  },
  {
    title:"Drag-select several at once",
    text:"Press on empty space in the grid and drag a box across the cards you want. Everything the box touches is selected — no mode to switch on first.",
    points:["Hold Shift while dragging to add to an existing selection.","On a phone, press and hold briefly, then drag."],
    visual:tutorialArt.drag
  },
  {
    title:"Remove selected backgrounds",
    text:"With photos selected, press Remove selected backgrounds. Only those photos are processed and everything else is left exactly as it is.",
    points:["The button stays disabled while nothing is selected."],
    visual:tutorialArt.removeSelected
  },
  {
    title:"Remove all backgrounds",
    text:"Press Remove all backgrounds to process every uploaded photo, whatever is selected. Photos that already have a cutout are skipped instead of being redone.",
    points:["Each photo shows a scanning animation while it is being processed."],
    visual:tutorialArt.removeAll
  },
  {
    title:"Refine a cutout",
    text:"Press Edit cutout on any finished photo. AI Assist analyses only the area under the circular target, so one tap clears leftover background without eating into the subject.",
    points:["Pick Small, Medium or Large with the Target slider.","Undo and Redo cover every correction."],
    visual:tutorialArt.refine
  },
  {
    title:"Download selected images",
    text:"Press Download selected to export just your current selection. One photo downloads directly; several arrive as a ZIP.",
    points:["Only photos that finished background removal are included."],
    visual:tutorialArt.downloadSelected
  },
  {
    title:"Download all images",
    text:"Press Download all to export every finished cutout in one ZIP. Transparent photos export as PNG; replaced backgrounds export as JPG.",
    points:["Photos still processing or failed are left out of the export."],
    visual:tutorialArt.downloadAll
  }
];
let tutorialIndex=0;

function renderTutorial(){
  const step=tutorialSteps[tutorialIndex]||tutorialSteps[0];
  $("#tutorialCount").textContent=`Step ${tutorialIndex+1} of ${tutorialSteps.length}`;
  $("#tutorialTitle").textContent=step.title;
  $("#tutorialText").textContent=step.text;
  $("#tutorialVisual").innerHTML=step.visual;
  $("#tutorialPoints").innerHTML=(step.points||[]).map(point=>`<li>${escapeHtml(point)}</li>`).join("");
  $("#tutorialDots").innerHTML=tutorialSteps
    .map((_,i)=>`<span class="${i===tutorialIndex?"active":""}"></span>`)
    .join("");
  $("#tutorialBack").disabled=tutorialIndex===0;
  $("#tutorialNext").textContent=
    tutorialIndex===tutorialSteps.length-1?"Done":"Next";
}

function openHelp(){tutorialIndex=0;renderTutorial();$("#helpModal").classList.remove("hidden");$("#closeHelp").focus();}
function closeHelp(){$("#helpModal").classList.add("hidden");}
photoInput.addEventListener("change", e => {
  addFiles(e.target.files);
  // Allow choosing the same file again later.
  e.target.value = "";
});
$("#addMoreBtn").onclick = () => photoInput.click();

$("#helpBtn").onclick=openHelp;$("#closeHelp").onclick=closeHelp;$("#helpModal").onclick=e=>{if(e.target.id==="helpModal")closeHelp();};
$("#tutorialBack").onclick=()=>{if(tutorialIndex>0){tutorialIndex--;renderTutorial();}};
$("#tutorialNext").onclick=()=>{if(tutorialIndex<tutorialSteps.length-1){tutorialIndex++;renderTutorial();}else closeHelp();};
const dragGuide=$("#dragGuide");
try{
  if(localStorage.getItem("backshotaiDragGuideDismissed")==="1"){
    dragGuide.classList.add("hidden");
  }
}catch{}
$("#dragGuideGotIt").onclick=()=>{
  dragGuide.classList.add("guide-dismiss");
  try{localStorage.setItem("backshotaiDragGuideDismissed","1");}catch{}
  setTimeout(()=>dragGuide.classList.add("hidden"),180);
};

$("#removeSelectedBtn").onclick=removeSelectedBackgrounds;
$("#removeAllBtn").onclick=removeAllBackgrounds;
$("#qualityMode").value=state.quality;
$("#qualityMode").onchange=e=>{
  state.quality=e.target.value;
  destroyRemovalWorker("Removal mode changed.");
  const status=$("#engineStatus");
  if(status)status.textContent=state.quality==="fast"?"Fast mode ready":state.quality==="best"?"Best mode ready":"Ready on Remove";
  toast(state.quality==="fast"?"Fast Mobile uses less memory and is quicker.":state.quality==="best"?"Best Quality uses a larger precision mask.":"Automatic mode selected.");
};
$("#downloadSelectedBtn").onclick=downloadSelected;$("#downloadAllBtn").onclick=downloadAll;
$("#clearBtn").onclick=()=>{
  for(const i of state.items)cleanupItem(i);
  if(state.backgroundURL)URL.revokeObjectURL(state.backgroundURL);
  state.items=[];state.selected.clear();state.backgroundURL=null;state.backgroundName="";state.bgMode="transparent";
  backgroundInput.value="";$("#backgroundPreview").classList.add("hidden");
  document.querySelectorAll(".seg").forEach(button=>button.classList.toggle("active",button.dataset.bg==="transparent"));
  workspace.classList.add("hidden");gallery.innerHTML="";updateSelectionUI();
};
function setBackgroundScope(scope){
  state.backgroundScope=scope;
  $("#backgroundScopeSelected").classList.toggle("active",scope==="selected");
  $("#backgroundScopeBatch").classList.toggle("active",scope==="batch");
}
$("#backgroundScopeSelected").onclick=()=>setBackgroundScope("selected");
$("#backgroundScopeBatch").onclick=()=>setBackgroundScope("batch");
document.querySelectorAll(".seg").forEach(btn=>btn.onclick=()=>{
  const mode=btn.dataset.bg;
  document.querySelectorAll(".seg").forEach(b=>b.classList.toggle("active",b===btn));
  $("#solidControls").classList.toggle("hidden",mode!=="solid");
  $("#backgroundPicker").classList.toggle("hidden",mode!=="image");
  if(mode!=="image"&&applyBackgroundMode(mode))toast(`${mode==="transparent"?"Replacement removed from":"Background applied to"} ${state.backgroundScope==="batch"?"the whole batch":"selected photos"}.`);
});
$("#solidColor").oninput=e=>{
  state.solidColor=e.target.value;const targets=backgroundTargets();if(!targets.length)return;
  if(state.backgroundScope==="batch"){
    state.bgMode="solid";for(const item of state.items)replaceItemBackground(item,null);
  }else for(const item of targets)replaceItemBackground(item,{mode:"solid",color:state.solidColor,url:null,name:""});
  renderAllPreviews();
};
backgroundInput.onchange=e=>{
  const f=e.target.files?.[0];if(!f)return;const targets=backgroundTargets();if(!targets.length){backgroundInput.value="";return;}
  if(state.backgroundScope==="batch"){
    if(state.backgroundURL)URL.revokeObjectURL(state.backgroundURL);
    state.backgroundURL=URL.createObjectURL(f);state.backgroundName=f.name;state.bgMode="image";
    for(const item of state.items)replaceItemBackground(item,null);
    $("#backgroundPreviewImage").src=state.backgroundURL;
  }else{
    for(const item of targets)replaceItemBackground(item,{mode:"image",color:state.solidColor,url:URL.createObjectURL(f),name:f.name});
    $("#backgroundPreviewImage").src=targets[0].background.url;
  }
  $("#backgroundPreviewName").textContent=f.name;$("#backgroundPreview").classList.remove("hidden");
  document.querySelectorAll(".seg").forEach(b=>b.classList.toggle("active",b.dataset.bg==="image"));renderAllPreviews();
  toast(`New background applied to ${state.backgroundScope==="batch"?"the whole batch":"selected photos"}.`);
};
$("#clearSelectedBackground").onclick=()=>{const items=selectedItems();if(!items.length){toast("Select one or more photos first.");return;}for(const item of items)replaceItemBackground(item,{mode:"transparent",color:state.solidColor,url:null,name:""});renderAllPreviews();toast("Replacement background removed from selected photos.");};
$("#clearBackground").onclick=()=>{
  if(state.backgroundScope==="selected"){$("#clearSelectedBackground").click();return;}
  if(state.backgroundURL)URL.revokeObjectURL(state.backgroundURL);state.backgroundURL=null;state.backgroundName="";backgroundInput.value="";$("#backgroundPreview").classList.add("hidden");state.bgMode="transparent";for(const item of state.items)replaceItemBackground(item,null);document.querySelectorAll(".seg").forEach(b=>b.classList.toggle("active",b.dataset.bg==="transparent"));renderAllPreviews();
};
$("#selectAll").onclick=()=>{state.selected=new Set(state.items.map(i=>i.id));updateSelectionClasses();updateSelectionUI();};$("#selectNone").onclick=()=>{state.selected.clear();updateSelectionClasses();updateSelectionUI();};
document.querySelectorAll("[data-edit-scope]").forEach(button=>button.onclick=()=>{
  const category=button.dataset.editScope;state.editScopes[category]=button.dataset.scope;
  document.querySelectorAll(`[data-edit-scope="${category}"]`).forEach(peer=>peer.classList.toggle("active",peer===button));
  updateSelectionUI();
});
$("#scaleRange").oninput=e=>applyScopedEdit("position","scale",Number(e.target.value));$("#xRange").oninput=e=>applyScopedEdit("position","offsetX",Number(e.target.value));$("#yRange").oninput=e=>applyScopedEdit("position","offsetY",Number(e.target.value));$("#brightnessRange").oninput=e=>applyScopedEdit("filters","brightness",Number(e.target.value));$("#contrastRange").oninput=e=>applyScopedEdit("filters","contrast",Number(e.target.value));$("#saturationRange").oninput=e=>applyScopedEdit("filters","saturation",Number(e.target.value));

$("#resetSelected").onclick=()=>{
  const positionTargets=editTargets("position"),filterTargets=editTargets("filters"),shadowTargets=editTargets("shadow");
  for(const item of positionTargets){item.adj.scale=1;item.adj.offsetX=0;item.adj.offsetY=0;}
  for(const item of filterTargets){item.adj.brightness=100;item.adj.contrast=100;item.adj.saturation=100;}
  for(const item of shadowTargets)item.adj.shadow=DEFAULT_ADJ().shadow;
  updateSelectionUI();schedulePreviewRender();
};

/* ---------- Drag selection ----------
 * Always available: there is no mode to turn on. A pointer press anywhere in the
 * grid starts a marquee, the selection previews live while dragging, and the
 * anchor is corrected for any scrolling that happens mid-drag so the box stays on
 * the cards it started from. Touch waits for a short hold so ordinary scrolling
 * still works. */
const dragSelectBox=$("#dragSelectBox");
const TOUCH_HOLD_MS=190;
const AUTO_SCROLL_EDGE=44;

function galleryScroller(){ return document.querySelector(".gallery-shell"); }
function currentScrollTop(){
  const el=galleryScroller();
  return (el?el.scrollTop:0)+window.scrollY;
}
function dragAnchor(){
  const drag=state.drag;
  return {x:drag.startX,y:drag.startY-(currentScrollTop()-drag.startScrollTop)};
}
function drawDragBox(x1,y1,x2,y2){
  const left=Math.min(x1,x2),top=Math.min(y1,y2),right=Math.max(x1,x2),bottom=Math.max(y1,y2);
  dragSelectBox.style.left=`${left}px`;
  dragSelectBox.style.top=`${top}px`;
  dragSelectBox.style.width=`${right-left}px`;
  dragSelectBox.style.height=`${bottom-top}px`;
  return {left,top,right,bottom};
}
function cardsWithin(rect){
  const ids=[];
  for(const card of gallery.querySelectorAll(".photo-card")){
    const box=card.getBoundingClientRect();
    const hit=!(box.right<rect.left||box.left>rect.right||box.bottom<rect.top||box.top>rect.bottom);
    if(hit&&card.dataset.card)ids.push(card.dataset.card);
  }
  return ids;
}
function previewDragSelection(){
  const drag=state.drag;if(!drag?.active)return;
  drag.dirty=false;
  const anchor=dragAnchor();
  const rect=drawDragBox(anchor.x,anchor.y,drag.currentX,drag.currentY);
  const next=drag.additive?new Set(drag.base):new Set();
  for(const id of cardsWithin(rect))next.add(id);
  state.selected=next;
  updateSelectionClasses();
  updateSelectionUI();
}
// One update per frame: pointermove only records the position, and auto-scroll
// near an edge keeps the marquee growing when the grid runs out of room.
function dragFrame(){
  const drag=state.drag;if(!drag?.active)return;
  const scroller=galleryScroller();
  const box=scroller?.getBoundingClientRect();
  const scrollable=!!box&&scroller.scrollHeight>scroller.clientHeight+1;
  const top=scrollable?box.top:0;
  const bottom=scrollable?box.bottom:window.innerHeight;
  let amount=0;
  if(drag.currentY<top+AUTO_SCROLL_EDGE)amount=-Math.min(18,(top+AUTO_SCROLL_EDGE-drag.currentY)/2);
  else if(drag.currentY>bottom-AUTO_SCROLL_EDGE)amount=Math.min(18,(drag.currentY-(bottom-AUTO_SCROLL_EDGE))/2);
  if(amount){
    if(scrollable)scroller.scrollTop+=amount;
    else window.scrollBy(0,amount);
    drag.dirty=true;
  }
  if(drag.dirty)previewDragSelection();
  drag.frame=requestAnimationFrame(dragFrame);
}
function activateDrag(){
  const drag=state.drag;if(!drag||drag.active)return;
  drag.active=true;
  drag.base=new Set(state.selected);
  dragSelectBox.classList.remove("hidden");
  gallery.classList.add("drag-select-active");
  document.body.classList.add("drag-selecting");
  previewDragSelection();
  drag.frame=requestAnimationFrame(dragFrame);
}
function endDrag(){
  const drag=state.drag;
  state.drag=null;
  if(!drag)return false;
  clearTimeout(drag.holdTimer);
  cancelAnimationFrame(drag.frame);
  dragSelectBox.classList.add("hidden");
  gallery.classList.remove("drag-select-active");
  document.body.classList.remove("drag-selecting");
  return drag.active;
}

// While a marquee is running the grid must not also scroll under the finger.
gallery.addEventListener("touchmove",e=>{
  if(state.drag?.active)e.preventDefault();
},{passive:false});

gallery.addEventListener("pointerdown",e=>{
  if(e.target.closest("button"))return;
  if(e.button)return;
  endDrag();
  state.drag={
    pointerId:e.pointerId,
    pointerType:e.pointerType,
    startX:e.clientX,
    startY:e.clientY,
    currentX:e.clientX,
    currentY:e.clientY,
    startScrollTop:currentScrollTop(),
    additive:e.shiftKey||e.ctrlKey||e.metaKey,
    base:new Set(state.selected),
    active:false,
    armed:e.pointerType!=="touch",
    dirty:false,
    holdTimer:0,
    frame:0
  };
  if(e.pointerType==="touch"){
    // A brief hold separates "I want to select" from "I want to scroll".
    state.drag.holdTimer=setTimeout(()=>{
      if(state.drag)state.drag.armed=true;
      activateDrag();
    },TOUCH_HOLD_MS);
  }
  try{gallery.setPointerCapture(e.pointerId);}catch{}
});

gallery.addEventListener("pointermove",e=>{
  const drag=state.drag;
  if(!drag||e.pointerId!==drag.pointerId)return;
  drag.currentX=e.clientX;
  drag.currentY=e.clientY;
  if(!drag.active){
    const moved=Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY);
    if(!drag.armed){
      // Still deciding: a real scroll gesture cancels the pending marquee.
      if(moved>10){clearTimeout(drag.holdTimer);state.drag=null;}
      return;
    }
    if(moved<8)return;
    activateDrag();
  }
  e.preventDefault();
  drag.dirty=true;
},{passive:false});

gallery.addEventListener("pointerup",e=>{
  const drag=state.drag;
  if(drag&&e.pointerId===drag.pointerId&&drag.active){
    drag.currentX=e.clientX;
    drag.currentY=e.clientY;
    previewDragSelection();
    e.preventDefault();
    e.stopPropagation();
    endDrag();
    // The click that follows a marquee must not toggle the card underneath.
    suppressNextCardClick=true;
    setTimeout(()=>{suppressNextCardClick=false;},0);
    return;
  }
  endDrag();
});
gallery.addEventListener("pointercancel",endDrag);

$("#shadowEnabled").onchange=e=>applyScopedShadow("enabled",e.target.checked);
$("#shadowOpacity").oninput=e=>applyScopedShadow("opacity",Number(e.target.value));
$("#shadowBlur").oninput=e=>applyScopedShadow("blur",Number(e.target.value));
$("#shadowY").oninput=e=>applyScopedShadow("offsetY",Number(e.target.value));
$("#eraseTool").onclick=()=>{if(state.editor){state.editor.mode="erase";updateEditorUI();}};
$("#restoreTool").onclick=()=>{if(state.editor){state.editor.mode="restore";updateEditorUI();}};
$("#assistToggle").onchange=updateEditorUI;
$("#assistSize").oninput=()=>{$("#assistSizeLabel").textContent=assistSizeLabel();updateAssistTargetSize();};
$("#undoEdit").onclick=undo;$("#redoEdit").onclick=redo;$("#smartRecover").onclick=smartRecover;$("#applyEdit").onclick=applyEditor;$("#closeEditor").onclick=closeEditor;$("#cutoutModal").onclick=e=>{if(e.target.id==="cutoutModal")closeEditor();};
$("#zoomOutEditor").onclick=()=>setEditorZoom((state.editor?.viewScale||1)/1.25);$("#zoomInEditor").onclick=()=>setEditorZoom((state.editor?.viewScale||1)*1.25);$("#fitEditor").onclick=()=>setEditorZoom(1);
let installPrompt=null;window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;$("#installBtn").classList.remove("hidden");});$("#installBtn").onclick=async()=>{if(!installPrompt){toast("On iPhone: Safari → Share → Add to Home Screen");return;}installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$("#installBtn").classList.add("hidden");};
window.addEventListener("resize",()=>{if(state.editor)requestAnimationFrame(fitEditorCanvasToStage);});
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(console.warn));


/* ---------- Scrolling ----------
 * The controls column and the photo grid each scroll on their own, and once one
 * of them reaches an end the gesture continues into the page instead of dead-
 * ending. Touch scrolling is left entirely to the browser: CSS overscroll
 * chaining already hands the gesture over, and intercepting touchmove used to
 * kill momentum scrolling inside both panels. */
function enableWheelChaining(el){
  if(!el)return;
  el.addEventListener("wheel",e=>{
    // Ctrl/Cmd + wheel is browser zoom, and a marquee drag owns the pointer.
    if(e.ctrlKey||e.metaKey||state.drag?.active)return;
    if(el.scrollHeight<=el.clientHeight+1)return;

    const atTop=el.scrollTop<=0;
    const atBottom=Math.ceil(el.scrollTop+el.clientHeight)>=el.scrollHeight-1;
    if((e.deltaY<0&&atTop)||(e.deltaY>0&&atBottom)){
      e.preventDefault();
      window.scrollBy({top:e.deltaY,left:0,behavior:"auto"});
    }
  },{passive:false});
}

enableWheelChaining(document.querySelector(".controls"));
enableWheelChaining(document.querySelector(".gallery-shell"));

document.addEventListener("keydown",e=>{
  if(e.key!=="Escape")return;
  if(!$("#cutoutModal").classList.contains("hidden")){closeEditor();return;}
  if(!$("#helpModal").classList.contains("hidden"))closeHelp();
});

// Preload only where the device/network has comfortable headroom. Constrained
// devices load on demand so merely opening a shared link cannot crash the tab.
const connection=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
const memory=Number(navigator.deviceMemory||0),cores=Number(navigator.hardwareConcurrency||0);
const constrained=IS_MOBILE||(memory>0&&memory<6)||(cores>0&&cores<6)||connection?.saveData||/2g/.test(connection?.effectiveType||"");
if(!constrained){
  if("requestIdleCallback" in window)requestIdleCallback(()=>warmBackshotEngine(),{timeout:1800});
  else setTimeout(()=>warmBackshotEngine(),1200);
}else{
  const status=$("#engineStatus");if(status)status.textContent="Ready on Remove";
}


window.addEventListener("error",event=>{
  console.error("BackshotAI runtime error",event.error||event.message);
  const status=document.querySelector("#engineStatus");
  if(status&&status.textContent.includes("Starting")){
    status.textContent="Loads on Remove";
  }
});
window.addEventListener("unhandledrejection",event=>{
  console.error("BackshotAI async error",event.reason);
});
