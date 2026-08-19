import "./style.css";
import "./editor.css";
import {chooseSafeCleanup,isHighConfidenceResidual,isNeutralBorderResidual,isGreenFringePixel,recoverForegroundChannel} from "./mask-safety.js";
import JSZip from "jszip";
import { removeBackground, preload } from "@imgly/background-removal";

const DEFAULT_ADJ = () => ({
  scale: 1, offsetX: 0, offsetY: 0,
  brightness: 100, contrast: 100, saturation: 100,
  shadow: { enabled: true, opacity: 0.22, blur: 24, offsetY: 18 }
});

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
  dragSelecting: false,
  dragMoved: false,
  dragStartX: 0,
  dragStartY: 0
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
        <div class="single-mode-badge">Backshot Engine <span id="engineStatus">Starting…</span></div>
      </div>
      <div class="remove-button-stack">
        <button id="removeSelectedBtn" class="primary">Remove selected backgrounds</button>
        <button id="removeAllBtn" class="ghost remove-all-btn">Remove all backgrounds</button>
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
      <button id="downloadSelectedBtn" class="primary success secondary-download">Download selected</button>
      <button id="downloadAllBtn" class="primary success">Download all as ZIP</button>
      <button id="clearBtn" class="danger ghost">Clear batch</button>
    </aside>

    <section class="gallery-shell">
      <div class="gallery-head">
        <div><h2>Your batch</h2><p id="batchCount">0 photos</p></div>
        <div class="gallery-head-actions">
          <button id="helpBtn" class="ghost">Get help</button>
          <button id="addMoreBtn" class="ghost">+ Add more</button>
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
      <label class="smart-toggle"><input id="assistToggle" type="checkbox" checked /> Assisted</label>
      <label class="brush-row">Brush <input id="brushSize" type="range" min="8" max="180" value="54" /></label>
      <button id="undoEdit" class="ghost small-btn">Undo</button>
      <button id="redoEdit" class="ghost small-btn">Redo</button>
      <div class="tool-group" aria-label="Editor zoom">
        <button id="zoomOutEditor" class="tool" type="button" aria-label="Zoom out">−</button>
        <button id="fitEditor" class="tool" type="button">Fit</button>
        <button id="zoomInEditor" class="tool" type="button" aria-label="Zoom in">＋</button>
      </div>
      <button id="smartRecover" class="ghost small-btn">Re-check subject</button>
    </div>
    <div class="editor-stage">
      <canvas id="editorCanvas"></canvas>
      <div id="brushCursor" class="brush-cursor"></div>
    </div>
    <div class="editor-foot">
      <span id="editorHint">Assisted: tap a missed area and BackshotAI follows that region.</span>
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
function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/"));
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
}
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
    if(e.target.closest("button") || state.dragMoved) return;
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

function updateSelectionUI(){const ds=$("#downloadSelectedBtn");if(ds)ds.disabled=state.selected.size===0;
  const items=selectedItems(), first=items[0];
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
    const shadowCfg=first.adj.shadow||{enabled:true,opacity:.22,blur:24,offsetY:18};
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
    item.adj.shadow ||= {enabled:true,opacity:.22,blur:24,offsetY:18};
    item.adj.shadow[key]=value;
  }
  schedulePreviewRender();
}

function removalConfig(mode, progress, useWorker = true) {
  const model = mode === "fast" ? "isnet_quint8" : "isnet";
  return {
    model,
    device: "cpu",
    proxyToWorker: useWorker,
    output: { format: "image/png", quality: 1 },
    progress
  };
}

async function trySimpleBackgroundRemoval(file){
  // Fast path for simple/minimal backgrounds: estimate the dominant border colour family
  // and remove ONLY background pixels connected to the image edges.
  // This preserves every disconnected object/product in the middle of the frame.
  const bmp=await createImageBitmap(file);
  const maxSide=320,scale=Math.min(1,maxSide/Math.max(bmp.width,bmp.height));
  const w=Math.max(32,Math.round(bmp.width*scale)),h=Math.max(32,Math.round(bmp.height*scale));
  const c=document.createElement("canvas");c.width=w;c.height=h;
  const ctx=c.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0,w,h);
  const img=ctx.getImageData(0,0,w,h),d=img.data;

  function rgb2hsv(r,g,b){
    r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),df=mx-mn;
    let hh=0;if(df){
      if(mx===r)hh=((g-b)/df)%6;
      else if(mx===g)hh=(b-r)/df+2;
      else hh=(r-g)/df+4;
      hh*=60;if(hh<0)hh+=360;
    }
    return [hh,mx?df/mx:0,mx];
  }
  const border=[];
  const step=Math.max(1,Math.floor(Math.min(w,h)/80));
  for(let x=0;x<w;x+=step){
    for(const y of [0,h-1]){const o=(y*w+x)*4;border.push([d[o],d[o+1],d[o+2]]);}
  }
  for(let y=0;y<h;y+=step){
    for(const x of [0,w-1]){const o=(y*w+x)*4;border.push([d[o],d[o+1],d[o+2]]);}
  }
  if(border.length<20)return null;

  // Quantize HSV to find a dominant border family.
  const bins=new Map();
  for(const [r,g,b] of border){
    const [hh,s,v]=rgb2hsv(r,g,b);
    const hb=Math.round(hh/24),sb=Math.round(s*5),vb=Math.round(v*5);
    const key=`${hb}|${sb}|${vb}`;
    const a=bins.get(key)||[];a.push([r,g,b,hh,s,v]);bins.set(key,a);
  }
  let dominant=null;
  for(const arr of bins.values())if(!dominant||arr.length>dominant.length)dominant=arr;
  if(!dominant||dominant.length/border.length<0.32)return null;

  let mr=0,mg=0,mb=0,mh=0,ms=0,mv=0;
  for(const p of dominant){mr+=p[0];mg+=p[1];mb+=p[2];mh+=p[3];ms+=p[4];mv+=p[5];}
  mr/=dominant.length;mg/=dominant.length;mb/=dominant.length;mh/=dominant.length;ms/=dominant.length;mv/=dominant.length;

  // Adaptive tolerance from cluster spread.
  let spread=0;
  for(const p of dominant)spread+=Math.hypot(p[0]-mr,p[1]-mg,p[2]-mb);
  spread/=dominant.length;
  const rgbTol=Math.max(34,Math.min(92,spread*2.6+24));
  const hueTol=Math.max(18,Math.min(52,spread*.55+20));

  const candidate=new Uint8Array(w*h);
  for(let i=0;i<w*h;i++){
    const o=i*4,r=d[o],g=d[o+1],b=d[o+2],dist=Math.hypot(r-mr,g-mg,b-mb);
    const [hh,s,v]=rgb2hsv(r,g,b);
    let hd=Math.abs(hh-mh);hd=Math.min(hd,360-hd);
    const similarRGB=dist<rgbTol;
    const similarHue=ms>.18 && s>.12 && hd<hueTol && Math.abs(v-mv)<.35;
    if(similarRGB||similarHue)candidate[i]=1;
  }

  // Flood only from edges. Similar-colour product pixels that are not edge-connected survive.
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
  // Only trust this shortcut when it clearly identified a substantial background, but not nearly everything.
  if(ratio<0.12||ratio>0.78)return null;

  // Create a full-resolution alpha mask using nearest scaling of the connected background mask,
  // then lightly feather the boundary.
  const full=document.createElement("canvas");full.width=bmp.width;full.height=bmp.height;
  const fctx=full.getContext("2d",{willReadFrequently:true});fctx.drawImage(bmp,0,0);
  const out=fctx.getImageData(0,0,full.width,full.height),od=out.data;
  for(let y=0;y<full.height;y++){
    const sy=Math.min(h-1,Math.floor(y*h/full.height));
    for(let x=0;x<full.width;x++){
      const sx=Math.min(w-1,Math.floor(x*w/full.width)),si=sy*w+sx,o=(y*full.width+x)*4;
      if(bg[si])od[o+3]=0;
    }
    if(y%180===0)await new Promise(r=>setTimeout(r,0));
  }
  fctx.putImageData(out,0,0);
  return await new Promise(res=>full.toBlob(res,"image/png",1));
}

async function removeStable(file, mode, progress) {
  // Reliability-first: keep inference off the UI thread when possible.
  // If worker execution is unsupported on a browser, retry directly on CPU.
  try {
    return await removeBackground(file, removalConfig(mode, progress, true));
  } catch (workerError) {
    console.warn("Worker removal failed; retrying directly on CPU", workerError);
    return await removeBackground(file, removalConfig(mode, progress, false));
  }
}
function preloadRemovalModel() {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 250));
  idle(async () => {
    try { await preload(removalConfig("smart", () => {}, true)); document.documentElement.dataset.removerReady = "true"; }
    catch (error) { console.warn("Background model preload skipped", error); }
  });
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

async function cleanCutoutEdges(blob){
  // Matting-style refinement: preserve the model's foreground alpha and clean only the boundary.
  // BackshotAI's own API docs note that matting is what improves cutout edges over a raw mask.
  const bmp=await createImageBitmap(blob),c=document.createElement("canvas");
  c.width=bmp.width;c.height=bmp.height;
  const ctx=c.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0);
  const img=ctx.getImageData(0,0,c.width,c.height),d=img.data,w=c.width,h=c.height;
  const alpha=new Uint8Array(w*h);
  for(let i=0,p=3;i<alpha.length;i++,p+=4)alpha[i]=d[p];

  const newA=new Uint8Array(alpha);
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i=y*w+x,a=alpha[i];
      if(a===0)continue;

      let minA=255,maxA=0,sumA=0,count=0,best=-1,bestA=-1;
      for(let oy=-2;oy<=2;oy++){
        for(let ox=-2;ox<=2;ox++){
          const nx=x+ox,ny=y+oy;
          if(nx<0||ny<0||nx>=w||ny>=h)continue;
          const n=ny*w+nx,na=alpha[n];
          minA=Math.min(minA,na);maxA=Math.max(maxA,na);sumA+=na;count++;
          if(na>bestA){bestA=na;best=n;}
        }
      }

      const boundary=minA<20 && maxA>210;
      if(boundary){
        // Feather without deleting opaque subject pixels.
        const local=sumA/count;
        if(a<245)newA[i]=Math.max(a,Math.min(245,Math.round(a*.70+local*.30)));

        // Remove colour spill on the fringe by borrowing colour from the most opaque
        // neighbouring subject pixel. This targets green/white outlines without shrinking.
        if(best>=0&&bestA>220){
          const mix=a>230?.72:a>150?.58:.42;
          for(let k=0;k<3;k++){
            d[i*4+k]=Math.round(d[i*4+k]*(1-mix)+d[best*4+k]*mix);
          }
        }
      }
      if(a<5)newA[i]=0;
    }
    if(y%96===0)await new Promise(r=>setTimeout(r,0));
  }

  // One tiny alpha blur only in the unknown edge band for smoother anti-aliasing.
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i=y*w+x,a=newA[i];
      if(a<=5||a>=250)continue;
      let s=0,n=0;
      for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){s+=newA[(y+oy)*w+x+ox];n++;}
      d[i*4+3]=Math.round(a*.78+(s/n)*.22);
    }
  }
  for(let i=0;i<newA.length;i++)if(newA[i]<=5||newA[i]>=250)d[i*4+3]=newA[i];

  ctx.putImageData(img,0,0);
  return await new Promise(res=>c.toBlob(res,"image/png",1));
}


async function cutoutShapeStats(blob){
  const bmp=await createImageBitmap(blob);
  const maxSide=220,s=Math.min(1,maxSide/Math.max(bmp.width,bmp.height));
  const w=Math.max(1,Math.round(bmp.width*s)),h=Math.max(1,Math.round(bmp.height*s));
  const c=document.createElement("canvas");c.width=w;c.height=h;
  const ctx=c.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0,w,h);
  const d=ctx.getImageData(0,0,w,h).data,mask=new Uint8Array(w*h);
  let visible=0;
  for(let i=0;i<w*h;i++){if(d[i*4+3]>80){mask[i]=1;visible++;}}
  const seen=new Uint8Array(w*h);let largest=0,components=0;
  for(let i=0;i<w*h;i++){
    if(!mask[i]||seen[i])continue;
    components++;let size=0,q=[i];seen[i]=1;
    for(let qi=0;qi<q.length;qi++){
      const p=q[qi],x=p%w,y=(p/w)|0;size++;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=w||ny>=h)continue;
        const n=ny*w+nx;if(mask[n]&&!seen[n]){seen[n]=1;q.push(n);}
      }
    }
    largest=Math.max(largest,size);
  }
  return {visible:visible/(w*h),largestShare:visible?largest/visible:0,components};
}

async function fuseCutoutsPreserveSubject(aBlob,bBlob){
  // Conservative union of two AI passes. If one model pass accidentally deletes a
  // product section, the other pass can restore it. We prefer preserving subject
  // over aggressively deleting uncertain pixels.
  const [a,b]=await Promise.all([createImageBitmap(aBlob),createImageBitmap(bBlob)]);
  const w=a.width,h=a.height,c=document.createElement("canvas");c.width=w;c.height=h;
  const ctx=c.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(a,0,0);const ai=ctx.getImageData(0,0,w,h);
  ctx.clearRect(0,0,w,h);ctx.drawImage(b,0,0,w,h);const bi=ctx.getImageData(0,0,w,h);
  const ad=ai.data,bd=bi.data;
  for(let i=0;i<w*h;i++){
    const o=i*4,aa=ad[o+3],ba=bd[o+3];
    if(ba>aa){
      // Use RGB from whichever cutout is more confident at this pixel.
      ad[o]=bd[o];ad[o+1]=bd[o+1];ad[o+2]=bd[o+2];ad[o+3]=ba;
    }
  }
  ctx.putImageData(ai,0,0);
  return await new Promise(res=>c.toBlob(res,"image/png",1));
}


let birefModelPromise=null;
let birefProcessorPromise=null;

async function getBiRefNet(){
  if(!birefModelPromise){
    const modelId="onnx-community/BiRefNet_lite-ONNX";
    const device=navigator.gpu?"webgpu":"wasm";
    const dtype=navigator.gpu?"fp16":"q4";
    $("#progressText").textContent="Loading precision cutout model…";
    birefModelPromise=AutoModel.from_pretrained(modelId,{device,dtype});
    birefProcessorPromise=AutoProcessor.from_pretrained(modelId);
  }
  return Promise.all([birefModelPromise,birefProcessorPromise]);
}

async function removeWithBiRefNet(file){
  const [model,processor]=await getBiRefNet();
  const original=await RawImage.fromBlob(file);
  const {pixel_values}=await processor(original);
  const {output_image}=await model({input_image:pixel_values});
  const mask=await RawImage
    .fromTensor(output_image[0].sigmoid().mul(255).to("uint8"))
    .resize(original.width,original.height);

  const bmp=await createImageBitmap(file);
  const c=document.createElement("canvas");
  c.width=bmp.width;c.height=bmp.height;
  const ctx=c.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(bmp,0,0);
  const out=ctx.getImageData(0,0,c.width,c.height),d=out.data,md=mask.data;

  // BiRefNet returns a full alpha matte, not a tiny "salient object" crop.
  for(let i=0;i<c.width*c.height;i++)d[i*4+3]=md[i]??255;
  ctx.putImageData(out,0,0);
  return await new Promise(res=>c.toBlob(res,"image/png",1));
}

async function cleanupDisconnectedSpecks(blob,originalBlob=null){
  const bmp=await createImageBitmap(blob),c=document.createElement("canvas");c.width=bmp.width;c.height=bmp.height;
  const ctx=c.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0);bmp.close?.();
  const image=ctx.getImageData(0,0,c.width,c.height),alpha=new Uint8Array(c.width*c.height);
  for(let i=0;i<alpha.length;i++)alpha[i]=image.data[i*4+3];
  let cleaned=removeTinyForegroundIslands(alpha,c.width,c.height);
  cleaned=removeGreenBoundaryFringe(image.data,cleaned,c.width,c.height);
  cleaned=refineAlphaEdge(cleaned,c.width,c.height);
  const safe=chooseSafeCleanup(alpha,cleaned,c.width,c.height);
  for(let i=0;i<safe.length;i++)image.data[i*4+3]=safe[i];
  if(originalBlob){
    // Reuse the existing canvas instead of allocating a second full-resolution
    // canvas. This materially lowers peak memory for large phone photos.
    const original=await createImageBitmap(originalBlob);
    ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(original,0,0,c.width,c.height);original.close?.();
    const source=ctx.getImageData(0,0,c.width,c.height).data;
    await decontaminateMatteBoundary(image.data,source,safe,c.width,c.height);
  }
  ctx.putImageData(image,0,0);
  return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error("Could not create cleaned cutout.")),"image/png",1));
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

function removeGreenBoundaryFringe(rgba,alpha,w,h){
  const out=new Uint8Array(alpha),nearBackground=new Uint8Array(w*h),frontier=new Uint8Array(w*h);
  for(let i=0;i<alpha.length;i++)if(alpha[i]<24){nearBackground[i]=1;frontier[i]=1;}
  // Only inspect the immediate soft matte. Earlier versions searched sixteen
  // pixels inward and could mistake green-tinted navy fabric for grass.
  let current=frontier;
  for(let step=0;step<4;step++){
    const next=new Uint8Array(w*h);
    for(let i=0;i<current.length;i++)if(current[i]){
      const x=i%w;
      const add=j=>{if(j>=0&&j<nearBackground.length&&!nearBackground[j]){nearBackground[j]=1;next[j]=1;}};
      if(x)add(i-1);if(x<w-1)add(i+1);if(i>=w)add(i-w);if(i<current.length-w)add(i+w);
    }
    current=next;
  }
  for(let i=0;i<out.length;i++){
    // Never delete an opaque or confident product pixel based on colour.
    if(!nearBackground[i]||alpha[i]>=176)continue;
    const o=i*4,r=rgba[o],g=rgba[o+1],b=rgba[o+2];
    // Remove only unmistakably green fringe pixels in a two-pixel boundary.
    // Navy, grey, cyan, white phone bezels and orange tags cannot match this.
    if(isGreenFringePixel(r,g,b))out[i]=0;
  }
  return out;
}

async function suspiciousResidualRatio(blob){
  const bmp=await createImageBitmap(blob),max=280,scale=Math.min(1,max/Math.max(bmp.width,bmp.height));
  const c=document.createElement("canvas");c.width=Math.max(1,Math.round(bmp.width*scale));c.height=Math.max(1,Math.round(bmp.height*scale));
  const ctx=c.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0,c.width,c.height);bmp.close?.();
  const d=ctx.getImageData(0,0,c.width,c.height).data,alpha=new Uint8Array(c.width*c.height);let suspicious=0,visible=0;
  for(let i=0;i<alpha.length;i++)alpha[i]=d[i*4+3];
  for(let i=0;i<d.length;i+=4){
    if(d[i+3]<128)continue;visible++;
    const pixel=i/4,x=pixel%c.width,y=(pixel/c.width)|0,max=Math.max(d[i],d[i+1],d[i+2]),min=Math.min(d[i],d[i+1],d[i+2]);
    const neutralEdge=(y>c.height*.88||x<c.width*.05||x>c.width*.95)&&max>95&&max-min<52;
    if(!isHighConfidenceResidual(d[i],d[i+1],d[i+2])&&!neutralEdge)continue;
    let touchesTransparency=false;
    for(let oy=-2;oy<=2&&!touchesTransparency;oy++)for(let ox=-2;ox<=2;ox++){
      const nx=x+ox,ny=y+oy;if(nx<0||ny<0||nx>=c.width||ny>=c.height)continue;
      if(alpha[ny*c.width+nx]<24){touchesTransparency=true;break;}
    }
    if(touchesTransparency)suspicious++;
  }
  return suspicious/Math.max(1,visible);
}

async function refineResidualBackground(baseBlob,aiBlob,originalBlob){
  const [base,ai,original]=await Promise.all([createImageBitmap(baseBlob),createImageBitmap(aiBlob),createImageBitmap(originalBlob)]);
  const c=document.createElement("canvas");c.width=base.width;c.height=base.height;const ctx=c.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(base,0,0);const out=ctx.getImageData(0,0,c.width,c.height);
  ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(ai,0,0,c.width,c.height);const aid=ctx.getImageData(0,0,c.width,c.height).data;
  ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(original,0,0,c.width,c.height);const source=ctx.getImageData(0,0,c.width,c.height).data;
  base.close?.();ai.close?.();original.close?.();
  const bins=new Map(),keyAt=o=>`${source[o]>>4},${source[o+1]>>4},${source[o+2]>>4}`;let transparent=0;
  for(let i=0;i<c.width*c.height;i++){const o=i*4;if(out.data[o+3]<24){const key=keyAt(o);bins.set(key,(bins.get(key)||0)+1);transparent++;}}
  const support=Math.max(6,Math.round(transparent*.00008)),candidate=new Uint8Array(c.width*c.height),borderResidual=new Uint8Array(c.width*c.height),queue=[];
  for(let i=0;i<c.width*c.height;i++){
    const o=i*4;
    // Colour is only a suspicion signal. A second segmentation model must also
    // call the pixel background before it can be deleted.
    if(out.data[o+3]>=24&&isHighConfidenceResidual(out.data[o],out.data[o+1],out.data[o+2])&&aid[o+3]<48)out.data[o+3]=0;
    else if(out.data[o+3]>=24&&aid[o+3]<32&&isNeutralBorderResidual(source[o],source[o+1],source[o+2])&&(bins.get(keyAt(o))||0)>=support)candidate[i]=1;
  }
  // Matting pass for the thin halo attached to the product boundary. Unlike
  // component cleanup, this can reach background-coloured pixels connected to
  // the jacket, but only when the original colour was learned from already
  // transparent background and the segmentation model also calls it background.
  const alphaBeforeEdge=new Uint8Array(c.width*c.height);
  for(let i=0;i<alphaBeforeEdge.length;i++)alphaBeforeEdge[i]=out.data[i*4+3];
  for(let y=1;y<c.height-1;y++)for(let x=1;x<c.width-1;x++){
    const i=y*c.width+x,o=i*4;if(alphaBeforeEdge[i]<24||aid[o+3]>=28)continue;
    const backgroundColour=isHighConfidenceResidual(source[o],source[o+1],source[o+2])||isNeutralBorderResidual(source[o],source[o+1],source[o+2]);
    if(!backgroundColour||(bins.get(keyAt(o))||0)<support)continue;
    let nearTransparent=false;
    for(let oy=-3;oy<=3&&!nearTransparent;oy++)for(let ox=-3;ox<=3;ox++){
      const nx=x+ox,ny=y+oy;if(nx<0||ny<0||nx>=c.width||ny>=c.height)continue;
      if(alphaBeforeEdge[ny*c.width+nx]<20){nearTransparent=true;break;}
    }
    if(nearTransparent)out.data[o+3]=0;
  }
  // Neutral floors and walls can be too dark for a safe global colour rule.
  // Remove them only when their colour was learned from existing transparent
  // background, the AI agrees, and the residual is connected to the frame.
  const push=i=>{if(i>=0&&i<candidate.length&&candidate[i]&&!borderResidual[i]){borderResidual[i]=1;queue.push(i);}};
  for(let x=0;x<c.width;x++){push(x);push((c.height-1)*c.width+x);}for(let y=0;y<c.height;y++){push(y*c.width);push(y*c.width+c.width-1);}
  for(let head=0;head<queue.length;head++){const i=queue[head],x=i%c.width;if(x)push(i-1);if(x<c.width-1)push(i+1);if(i>=c.width)push(i-c.width);if(i<candidate.length-c.width)push(i+c.width);}
  for(let i=0;i<borderResidual.length;i++)if(borderResidual[i])out.data[i*4+3]=0;
  ctx.putImageData(out,0,0);
  return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error("Could not refine bright background.")),"image/png",1));
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


async function buildConservativeBackgroundMask(file){
  // High-confidence fast path. Learns the outer background, then only removes
  // pixels connected to the frame edge. It never deletes disconnected centre objects.
  const bmp=await createImageBitmap(file);
  const maxSide=360,s=Math.min(1,maxSide/Math.max(bmp.width,bmp.height));
  const w=Math.max(64,Math.round(bmp.width*s)),h=Math.max(64,Math.round(bmp.height*s));
  const c=document.createElement("canvas");c.width=w;c.height=h;
  const ctx=c.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0,w,h);
  const img=ctx.getImageData(0,0,w,h),d=img.data;

  const edge=[];
  const band=Math.max(2,Math.round(Math.min(w,h)*.025));
  const pushPix=(x,y)=>{const o=(y*w+x)*4;edge.push([d[o],d[o+1],d[o+2]]);};
  for(let x=0;x<w;x+=2){for(let y=0;y<band;y++)pushPix(x,y);}
  for(let y=0;y<h;y+=2){for(let x=0;x<band;x++)pushPix(x,y);for(let x=w-band;x<w;x++)pushPix(x,y);}
  if(edge.length<50)return null;

  // Robust median background colour.
  const med=k=>{const a=edge.map(v=>v[k]).sort((a,b)=>a-b);return a[(a.length/2)|0];};
  const seed=[med(0),med(1),med(2)];
  let spread=0;
  for(const p of edge)spread+=Math.hypot(p[0]-seed[0],p[1]-seed[1],p[2]-seed[2]);
  spread/=edge.length;

  // Only trust easy, reasonably consistent backgrounds.
  if(spread>82)return null;
  const tol=Math.max(42,Math.min(105,spread*1.9+32));

  const cand=new Uint8Array(w*h);
  for(let i=0;i<w*h;i++){
    const o=i*4;
    const dist=Math.hypot(d[o]-seed[0],d[o+1]-seed[1],d[o+2]-seed[2]);
    if(dist<tol)cand[i]=1;
  }

  const bg=new Uint8Array(w*h),q=[];
  const add=(x,y)=>{const i=y*w+x;if(cand[i]&&!bg[i]){bg[i]=1;q.push(i);}};
  for(let x=0;x<w;x++){add(x,0);add(x,h-1);}
  for(let y=0;y<h;y++){add(0,y);add(w-1,y);}
  for(let qi=0;qi<q.length;qi++){
    const i=q[qi],x=i%w,y=(i/w)|0;
    if(x>0)add(x-1,y);if(x<w-1)add(x+1,y);if(y>0)add(x,y-1);if(y<h-1)add(x,y+1);
  }

  let count=0;for(const v of bg)count+=v;
  const ratio=count/(w*h);
  if(ratio<.04||ratio>.62)return null;
  return {bmp,bg,w,h,ratio};
}

async function applyBackgroundMask(file,maskInfo){
  const {bmp,bg,w,h}=maskInfo;
  const full=document.createElement("canvas");full.width=bmp.width;full.height=bmp.height;
  const ctx=full.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0);
  const out=ctx.getImageData(0,0,full.width,full.height),d=out.data;
  for(let y=0;y<full.height;y++){
    const sy=Math.min(h-1,Math.floor(y*h/full.height));
    for(let x=0;x<full.width;x++){
      const sx=Math.min(w-1,Math.floor(x*w/full.width));
      if(bg[sy*w+sx])d[(y*full.width+x)*4+3]=0;
    }
    if(y%180===0)await new Promise(r=>setTimeout(r,0));
  }
  ctx.putImageData(out,0,0);
  return await new Promise(res=>full.toBlob(res,"image/png",1));
}

async function protectSubjectWithBackgroundMask(file,cutout,maskInfo){
  if(!maskInfo)return cutout;
  const [orig,fg]=await Promise.all([createImageBitmap(file),createImageBitmap(cutout)]);
  const {bg,w,h}=maskInfo;
  const c=document.createElement("canvas");c.width=orig.width;c.height=orig.height;
  const ctx=c.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(orig,0,0);const oi=ctx.getImageData(0,0,c.width,c.height);
  ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(fg,0,0,c.width,c.height);const fi=ctx.getImageData(0,0,c.width,c.height);
  const od=oi.data,fd=fi.data;
  for(let y=0;y<c.height;y++){
    const sy=Math.min(h-1,Math.floor(y*h/c.height));
    for(let x=0;x<c.width;x++){
      const sx=Math.min(w-1,Math.floor(x*w/c.width)),o=(y*c.width+x)*4;
      // Anything not confidently background gets preserved from the original.
      if(!bg[sy*w+sx] && fd[o+3]<220){
        od[o+3]=Math.max(fd[o+3],235);
      }else{
        od[o+3]=fd[o+3];
      }
    }
    if(y%180===0)await new Promise(r=>setTimeout(r,0));
  }
  ctx.putImageData(oi,0,0);
  return await new Promise(res=>c.toBlob(res,"image/png",1));
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
          msg.height
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

function combineForegroundMasks(primary,safety){
  const out=new Uint8Array(primary.length);

  for(let i=0;i<primary.length;i++){
    const a=primary[i];
    const b=safety?safety[i]:0;

    if(b>=210){
      out[i]=Math.max(a,b);
    }else if(b>=150 && a>=72){
      out[i]=Math.max(a,Math.round(b*0.88));
    }else{
      out[i]=a;
    }
  }

  return out;
}


function rgbDist(r1,g1,b1,r2,g2,b2){
  const dr=r1-r2,dg=g1-g2,db=b1-b2;
  return Math.sqrt(dr*dr+dg*dg+db*db);
}

function buildConsensusBackgroundClusters(rgb,primary,safety,w,h){
  const bins=new Map();
  const total=w*h;
  const stride=Math.max(1,Math.floor(Math.sqrt(total/160000)));

  for(let y=0;y<h;y+=stride){
    for(let x=0;x<w;x+=stride){
      const i=y*w+x;
      const p=primary[i];
      const s=safety?safety[i]:p;
      if(p>35||s>35)continue;

      const o=i*4;
      const r=rgb[o],g=rgb[o+1],b=rgb[o+2];
      const key=`${r>>4},${g>>4},${b>>4}`;
      let e=bins.get(key);
      if(!e){
        e={count:0,r:0,g:0,b:0};
        bins.set(key,e);
      }
      e.count++;
      e.r+=r;e.g+=g;e.b+=b;
    }
  }

  return [...bins.values()]
    .sort((a,b)=>b.count-a.count)
    .slice(0,10)
    .map(e=>({count:e.count,r:e.r/e.count,g:e.g/e.count,b:e.b/e.count}));
}

function rescueForegroundFromConsensus(rgb,alpha,primary,safety,w,h){
  const total=w*h;
  const clusters=buildConsensusBackgroundClusters(rgb,primary,safety,w,h);
  if(!clusters.length)return new Uint8Array(alpha);

  const out=new Uint8Array(alpha);
  const definiteBg=new Uint8Array(total);

  const bgDistance=i=>{
    const o=i*4,r=rgb[o],g=rgb[o+1],b=rgb[o+2];
    let d=999;
    for(const c of clusters)d=Math.min(d,rgbDist(r,g,b,c.r,c.g,c.b));
    return d;
  };

  for(let i=0;i<total;i++){
    const p=primary[i],s=safety?safety[i]:p;
    if(p<48 && s<48 && bgDistance(i)<70){
      definiteBg[i]=1;
      out[i]=0;
    }
  }

  const visited=new Uint8Array(total);
  const queue=new Int32Array(total);
  const comps=[];

  for(let start=0;start<total;start++){
    if(visited[start]||alpha[start]<145)continue;
    let head=0,tail=0;
    queue[tail++]=start; visited[start]=1;
    const pixels=[];

    while(head<tail){
      const i=queue[head++]; pixels.push(i);
      const x=i%w,y=(i/w)|0;
      const add=j=>{
        if(j<0||j>=total||visited[j]||alpha[j]<145)return;
        visited[j]=1; queue[tail++]=j;
      };
      if(x>0)add(i-1);
      if(x<w-1)add(i+1);
      if(y>0)add(i-w);
      if(y<h-1)add(i+w);
    }
    comps.push(pixels);
  }

  if(!comps.length)return out;
  comps.sort((a,b)=>b.length-a.length);

  const rescued=new Uint8Array(total);
  let head=0,tail=0;
  const minSubstantial=Math.max(150,Math.round(total*0.0025));

  for(const comp of comps){
    if(comp!==comps[0] && comp.length<minSubstantial)continue;
    for(const i of comp){
      if(rescued[i])continue;
      rescued[i]=1; queue[tail++]=i;
      out[i]=Math.max(out[i],alpha[i]);
    }
  }

  while(head<tail){
    const i=queue[head++];
    const x=i%w,y=(i/w)|0,io=i*4;

    const tryRescue=j=>{
      if(j<0||j>=total||rescued[j]||definiteBg[j])return;

      const jo=j*4;
      const local=rgbDist(
        rgb[io],rgb[io+1],rgb[io+2],
        rgb[jo],rgb[jo+1],rgb[jo+2]
      );
      const bgd=bgDistance(j);
      const p=primary[j],s=safety?safety[j]:p;

      const hasAIEvidence=Math.max(p,s)>=58;
      const unlikeBackground=bgd>=92;
      const locallyContinuous=local<=38 && bgd>=74;

      if(!(hasAIEvidence||unlikeBackground||locallyContinuous))return;

      rescued[j]=1; queue[tail++]=j;
      const modelA=Math.max(p,s,alpha[j]);
      out[j]=Math.max(modelA,(locallyContinuous||unlikeBackground)?238:165);
    };

    if(x>0)tryRescue(i-1);
    if(x<w-1)tryRescue(i+1);
    if(y>0)tryRescue(i-w);
    if(y<h-1)tryRescue(i+w);
  }

  for(let i=0;i<total;i++){
    if(definiteBg[i])out[i]=0;
  }

  return out;
}


function learnConfidentBackgroundModel(rgb,primary,safety,w,h){
  const bins=new Map();
  const total=w*h;
  const stride=Math.max(1,Math.floor(Math.sqrt(total/200000)));
  let confidentSamples=0;

  const rgbToHSV=(r,g,b)=>{
    r/=255;g/=255;b/=255;
    const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
    let h=0;
    if(d){
      if(max===r)h=((g-b)/d)%6;
      else if(max===g)h=(b-r)/d+2;
      else h=(r-g)/d+4;
      h*=60;
      if(h<0)h+=360;
    }
    const s=max===0?0:d/max;
    return [h,s,max];
  };

  for(let y=0;y<h;y+=stride){
    for(let x=0;x<w;x+=stride){
      const i=y*w+x;
      const p=primary[i];
      const s=safety?safety[i]:p;

      // Learn only where both models are very confident it is background.
      if(p>24||s>24)continue;

      confidentSamples++;
      const o=i*4;
      const r=rgb[o],g=rgb[o+1],b=rgb[o+2];

      // Slightly coarser quantisation groups textured grass/fabric-floor shades.
      const key=`${r>>5},${g>>5},${b>>5}`;
      let e=bins.get(key);
      if(!e){
        e={count:0,r:0,g:0,b:0};
        bins.set(key,e);
      }
      e.count++;
      e.r+=r;e.g+=g;e.b+=b;
    }
  }

  if(confidentSamples<32||!bins.size)return null;

  const ranked=[...bins.values()].sort((a,b)=>b.count-a.count);
  const clusters=ranked.slice(0,18).map(e=>{
    const r=e.r/e.count,g=e.g/e.count,b=e.b/e.count;
    const hsv=rgbToHSV(r,g,b);
    return {count:e.count,r,g,b,h:hsv[0],s:hsv[1],v:hsv[2]};
  });

  const covered=clusters.reduce((n,e)=>n+e.count,0);
  const coverage=covered/confidentSamples;

  // Textured backgrounds no longer need one dominant colour.
  // Enough confident samples + broad cluster coverage is sufficient.
  return {
    clusters,
    homogeneous:coverage>=0.48,
    topShare:coverage,
    confidentSamples
  };
}

function rescueNonBackgroundPixels(rgb,alpha,primary,safety,w,h){
  const model=learnConfidentBackgroundModel(rgb,primary,safety,w,h);
  if(!model||!model.homogeneous)return new Uint8Array(alpha);

  const out=new Uint8Array(alpha);
  const total=w*h;

  const rgbToHSV=(r,g,b)=>{
    r/=255;g/=255;b/=255;
    const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
    let h=0;
    if(d){
      if(max===r)h=((g-b)/d)%6;
      else if(max===g)h=(b-r)/d+2;
      else h=(r-g)/d+4;
      h*=60;
      if(h<0)h+=360;
    }
    const s=max===0?0:d/max;
    return [h,s,max];
  };

  const bgScores=i=>{
    const o=i*4;
    const r=rgb[o],g=rgb[o+1],b=rgb[o+2];
    const hsv=rgbToHSV(r,g,b);

    let rgbD=999;
    let hsvD=999;

    for(const c of model.clusters){
      rgbD=Math.min(rgbD,rgbDist(r,g,b,c.r,c.g,c.b));

      let hd=Math.abs(hsv[0]-c.h);
      hd=Math.min(hd,360-hd)/180;
      const sd=Math.abs(hsv[1]-c.s);
      const vd=Math.abs(hsv[2]-c.v);

      // Hue matters most for saturated backgrounds such as grass.
      // Saturation/value separate grey/navy garments from coloured floors.
      const score=Math.sqrt(
        (hd*1.45)**2 +
        (sd*1.15)**2 +
        (vd*0.65)**2
      );
      hsvD=Math.min(hsvD,score);
    }

    return {rgbD,hsvD};
  };

  for(let i=0;i<total;i++){
    if(out[i]>=218)continue;

    const p=primary[i];
    const s=safety?safety[i]:p;
    const {rgbD,hsvD}=bgScores(i);

    // Strong disagreement with the learned background family means the pixel
    // should not be deleted even when the segmentation model made a mistake.
    const veryUnlikeBg=rgbD>=112 || hsvD>=0.72;
    const unlikeBg=rgbD>=82 || hsvD>=0.52;
    const someAI=Math.max(p,s)>=28;

    if(veryUnlikeBg){
      out[i]=Math.max(out[i],p,s,248);
    }else if(unlikeBg&&someAI){
      out[i]=Math.max(out[i],p,s,210);
    }
  }

  // Reconnect narrow gaps inside rescued garment regions.
  const copy=new Uint8Array(out);
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i=y*w+x;
      if(copy[i]>=180)continue;

      let strong=0;
      if(copy[i-1]>=225)strong++;
      if(copy[i+1]>=225)strong++;
      if(copy[i-w]>=225)strong++;
      if(copy[i+w]>=225)strong++;

      if(strong>=3){
        const {rgbD,hsvD}=bgScores(i);
        if(rgbD>=70||hsvD>=0.44)out[i]=228;
      }
    }
  }

  return out;
}


function buildBackgroundOnlyCandidate(rgb,primary,safety,w,h){
  const model=learnConfidentBackgroundModel(rgb,primary,safety,w,h);
  if(!model||!model.homogeneous||!model.clusters?.length)return null;

  const total=w*h;
  const out=new Uint8Array(total);
  const bgLikely=new Uint8Array(total);

  const rgbToHSV=(r,g,b)=>{
    r/=255;g/=255;b/=255;
    const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
    let h=0;
    if(d){
      if(max===r)h=((g-b)/d)%6;
      else if(max===g)h=(b-r)/d+2;
      else h=(r-g)/d+4;
      h*=60;
      if(h<0)h+=360;
    }
    return [h,max===0?0:d/max,max];
  };

  const backgroundScore=i=>{
    const o=i*4;
    const r=rgb[o],g=rgb[o+1],b=rgb[o+2];
    const hsv=rgbToHSV(r,g,b);

    let rgbD=999,hsvD=999;
    for(const c of model.clusters){
      rgbD=Math.min(rgbD,rgbDist(r,g,b,c.r,c.g,c.b));

      let hd=Math.abs(hsv[0]-c.h);
      hd=Math.min(hd,360-hd)/180;
      const sd=Math.abs(hsv[1]-c.s);
      const vd=Math.abs(hsv[2]-c.v);

      hsvD=Math.min(
        hsvD,
        Math.sqrt((hd*1.45)**2+(sd*1.10)**2+(vd*0.65)**2)
      );
    }
    return {rgbD,hsvD};
  };

  for(let i=0;i<total;i++){
    const p=primary[i];
    const s=safety?safety[i]:p;
    const {rgbD,hsvD}=backgroundScore(i);

    const strongAIBackground=p<42 && s<42;
    const looksLikeBackground=rgbD<76 && hsvD<0.46;
    const moderateAIBackground=p<92 && s<92;
    const veryBackgroundLike=rgbD<52 && hsvD<0.32;

    if(
      (strongAIBackground && looksLikeBackground) ||
      (moderateAIBackground && veryBackgroundLike)
    ){
      bgLikely[i]=1;
    }
  }

  for(let i=0;i<total;i++)out[i]=bgLikely[i]?0:255;

  return removeTinyForegroundIslands(out,w,h);
}

function combineWithBackgroundCandidate(alpha,candidate,primary,safety,w,h){
  if(!candidate)return new Uint8Array(alpha);

  const total=w*h;
  const out=new Uint8Array(alpha);

  let aiStrong=0,candidateStrong=0;
  for(let i=0;i<total;i++){
    if(alpha[i]>=128)aiStrong++;
    if(candidate[i]>=128)candidateStrong++;
  }

  if(candidateStrong/Math.max(1,total)>0.88)return out;

  const candidateGain=candidateStrong/Math.max(1,aiStrong);
  if(candidateGain<1.035)return out;

  for(let i=0;i<total;i++){
    if(candidate[i]<128)continue;

    const p=primary[i];
    const s=safety?safety[i]:p;

    if(Math.max(p,s)>=52){
      out[i]=Math.max(out[i],p,s,244);
    }else{
      out[i]=Math.max(out[i],220);
    }
  }

  return out;
}

function maskDiagnostics(alpha,w,h){
  const total=w*h;
  let strong=0;
  let minX=w,maxX=-1,minY=h,maxY=-1;

  for(let i=0;i<total;i++){
    if(alpha[i]<128)continue;
    strong++;
    const x=i%w,y=(i/w)|0;
    if(x<minX)minX=x;if(x>maxX)maxX=x;
    if(y<minY)minY=y;if(y>maxY)maxY=y;
  }

  return {
    strong,
    ratio:strong/Math.max(1,total),
    width:maxX>=minX?(maxX-minX+1):0,
    height:maxY>=minY?(maxY-minY+1):0
  };
}

function releaseSafetyCheck(beforeCleanup,afterCleanup,w,h){
  const before=maskDiagnostics(beforeCleanup,w,h);
  const after=maskDiagnostics(afterCleanup,w,h);

  if(!before.strong)return new Uint8Array(afterCleanup);

  const areaRetention=after.strong/before.strong;
  const widthRetention=before.width?after.width/before.width:1;
  const heightRetention=before.height?after.height/before.height:1;

  if(areaRetention<0.94 || widthRetention<0.92 || heightRetention<0.92){
    console.warn("BackshotAI release safety rollback: product shrink detected");
    return new Uint8Array(beforeCleanup);
  }

  return afterCleanup;
}

function fillEnclosedAlphaHoles(alpha,w,h){
  const total=w*h;
  const outsideBg=new Uint8Array(total);
  const queue=new Int32Array(total);
  let head=0,tail=0;
  const threshold=72;

  const add=i=>{
    if(i<0||i>=total||outsideBg[i]||alpha[i]>=threshold)return;
    outsideBg[i]=1;
    queue[tail++]=i;
  };

  for(let x=0;x<w;x++){
    add(x);
    add((h-1)*w+x);
  }
  for(let y=0;y<h;y++){
    add(y*w);
    add(y*w+w-1);
  }

  while(head<tail){
    const i=queue[head++];
    const x=i%w,y=(i/w)|0;
    if(x>0)add(i-1);
    if(x<w-1)add(i+1);
    if(y>0)add(i-w);
    if(y<h-1)add(i+w);
  }

  const out=new Uint8Array(alpha);
  for(let i=0;i<total;i++){
    if(alpha[i]<threshold && !outsideBg[i]){
      out[i]=Math.max(out[i],242);
    }
  }

  return out;
}

function removeTinyForegroundIslands(alpha,w,h){
  const total=w*h;
  const visited=new Uint8Array(total);
  const out=new Uint8Array(alpha);
  const queue=new Int32Array(total);
  const components=[];

  const visible=i=>alpha[i]>=48;

  for(let start=0;start<total;start++){
    if(visited[start]||!visible(start))continue;

    let head=0,tail=0;
    queue[tail++]=start;
    visited[start]=1;

    const pixels=[];
    let minX=w,maxX=0,minY=h,maxY=0;

    while(head<tail){
      const i=queue[head++];
      pixels.push(i);
      const x=i%w,y=(i/w)|0;
      if(x<minX)minX=x;if(x>maxX)maxX=x;
      if(y<minY)minY=y;if(y>maxY)maxY=y;

      const add=j=>{
        if(j<0||j>=total||visited[j]||!visible(j))return;
        visited[j]=1;
        queue[tail++]=j;
      };

      if(x>0)add(i-1);
      if(x<w-1)add(i+1);
      if(y>0)add(i-w);
      if(y<h-1)add(i+w);
    }

    components.push({pixels,area:pixels.length,minX,maxX,minY,maxY});
  }

  if(!components.length)return out;

  components.sort((a,b)=>b.area-a.area);
  const largestArea=components[0].area;

  const hardTiny=Math.max(14,Math.round(total*0.00009));
  const softTiny=Math.max(50,Math.round(total*0.00032));
  const maxRelative=largestArea*0.008;

  for(let ci=1;ci<components.length;ci++){
    const c=components[ci];
    const bw=c.maxX-c.minX+1;
    const bh=c.maxY-c.minY+1;

    const definitelyTiny=c.area<=hardTiny;
    const smallAndCompact=
      c.area<=Math.min(softTiny,maxRelative) &&
      bw<=Math.max(16,Math.round(w*0.045)) &&
      bh<=Math.max(16,Math.round(h*0.045));

    if(definitelyTiny||smallAndCompact){
      for(const i of c.pixels)out[i]=0;
    }
  }

  return out;
}


function countStrongAlpha(alpha,threshold=128){
  let n=0;
  for(let i=0;i<alpha.length;i++){
    if(alpha[i]>=threshold)n++;
  }
  return n;
}

function chooseSaferFinalAlpha(protectedAlpha,cleanedAlpha){
  const protectedCount=countStrongAlpha(protectedAlpha,128);
  const cleanedCount=countStrongAlpha(cleanedAlpha,128);

  if(!protectedCount)return cleanedAlpha;

  const retained=cleanedCount/protectedCount;

  // Cleanup should never destroy a large portion of the already-protected
  // product. If it does, prefer the protected version rather than show holes.
  if(retained<0.91){
    console.warn("BackshotAI safety rollback: cleanup removed too much foreground");
    return new Uint8Array(protectedAlpha);
  }

  return cleanedAlpha;
}

function refineAlphaEdge(alpha,w,h){
  const out=new Uint8Array(alpha);

  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i=y*w+x;
      const a=alpha[i];

      if(a<36){
        out[i]=0;
        continue;
      }

      if(a>248){
        out[i]=255;
        continue;
      }

      let sum=0,touchesClear=false;
      for(let oy=-1;oy<=1;oy++){
        for(let ox=-1;ox<=1;ox++){
          const nearby=alpha[(y+oy)*w+x+ox];
          sum+=nearby;
          if(nearby<24)touchesClear=true;
        }
      }
      const avg=sum/9;
      let smooth=a*.72+avg*.28;
      // A small matte choke removes the coloured antialias fringe without
      // moving the strong product silhouette or modifying its RGB pixels.
      if(touchesClear&&smooth<150)smooth*=.68;
      out[i]=Math.max(0,Math.min(255,Math.round(smooth)));
    }
  }

  return out;
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

async function applyDualMaskToFile(file,primaryBuffer,safetyBuffer,maskWidth,maskHeight){
  if(!primaryBuffer||!maskWidth||!maskHeight){
    throw new Error("The AI returned an invalid mask.");
  }

  const decoded=await decodeImageForCanvas(file);
  const bitmap=decoded.image;
  const ow=bitmap.naturalWidth||bitmap.width;
  const oh=bitmap.naturalHeight||bitmap.height;

  const primaryRaw=new Uint8Array(primaryBuffer);
  const safetyRaw=safetyBuffer?new Uint8Array(safetyBuffer):null;

  if(primaryRaw.length!==maskWidth*maskHeight){
    bitmap.close?.();
    throw new Error("The AI mask size did not match the image.");
  }

  const scaleMask=raw=>{
    if(maskWidth===ow&&maskHeight===oh){
      return new Uint8Array(raw);
    }

    const maskCanvas=document.createElement("canvas");
    maskCanvas.width=maskWidth;maskCanvas.height=maskHeight;
    const mctx=maskCanvas.getContext("2d",{willReadFrequently:true});

    const rgba=new Uint8ClampedArray(maskWidth*maskHeight*4);
    for(let i=0;i<raw.length;i++){
      const a=raw[i],o=i*4;
      rgba[o]=a;rgba[o+1]=a;rgba[o+2]=a;rgba[o+3]=255;
    }
    mctx.putImageData(new ImageData(rgba,maskWidth,maskHeight),0,0);

    const scaled=document.createElement("canvas");
    scaled.width=ow;scaled.height=oh;
    const sctx=scaled.getContext("2d",{willReadFrequently:true});
    sctx.imageSmoothingEnabled=true;
    sctx.imageSmoothingQuality="high";
    sctx.drawImage(maskCanvas,0,0,ow,oh);

    const rgbaScaled=sctx.getImageData(0,0,ow,oh).data;
    const out=new Uint8Array(ow*oh);
    for(let i=0;i<ow*oh;i++)out[i]=rgbaScaled[i*4];
    return out;
  };

  const primary=scaleMask(primaryRaw);
  const safety=safetyRaw?scaleMask(safetyRaw):null;
  debugMaskStage("01-primary-rmbg",primary,ow,oh);
  if(safety)debugMaskStage("02-safety-isnet",safety,ow,oh);

  const outCanvas=document.createElement("canvas");
  outCanvas.width=ow;outCanvas.height=oh;
  const ctx=outCanvas.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0,ow,oh);
  if(decoded.close)bitmap.close?.();

  const image=ctx.getImageData(0,0,ow,oh);

  // Segmentation and cleanup are deliberately separate. BiRefNet owns the
  // matte; cleanup may only remove genuinely tiny disconnected islands.
  // Colour clustering and model unions were removed because both can turn
  // uncertain navy/grey product pixels into background or restore grass.
  let alpha=new Uint8Array(primary);
  const protectedAlpha=new Uint8Array(alpha);
  debugMaskStage("03-protected-model-matte",protectedAlpha,ow,oh);

  let cleanedAlpha=removeTinyForegroundIslands(protectedAlpha,ow,oh);
  cleanedAlpha=refineAlphaEdge(cleanedAlpha,ow,oh);
  debugMaskStage("04-cleanup",cleanedAlpha,ow,oh);

  // Fail safe: never accept cleanup that removes too much of the protected item.
  alpha=chooseSafeCleanup(protectedAlpha,cleanedAlpha,ow,oh);
  alpha=releaseSafetyCheck(protectedAlpha,alpha,ow,oh);
  const finalDiag=maskDiagnostics(alpha,ow,oh);
  const protectedDiag=maskDiagnostics(protectedAlpha,ow,oh);

  if(
    protectedDiag.strong &&
    (
      finalDiag.strong/protectedDiag.strong<0.94 ||
      finalDiag.width<protectedDiag.width*0.92 ||
      finalDiag.height<protectedDiag.height*0.92
    )
  ){
    alpha=new Uint8Array(protectedAlpha);
  }
  debugMaskStage("05-final",alpha,ow,oh);

  for(let i=0;i<ow*oh;i++){
    let a=alpha[i];
    if(a<14)a=0;
    else if(a>226)a=255;
    image.data[i*4+3]=a;
  }
  ctx.putImageData(image,0,0);

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

function removeWithBackshotEngine(file,onProgress,attempt=0){
  return new Promise((resolve,reject)=>{
    let worker;
    try{worker=getRemovalWorker();}catch(error){reject(error);return;}
    const id=++removalSeq;

    const timeout=setTimeout(()=>{
      removalPending.delete(id);
      destroyRemovalWorker("The AI remover timed out and was restarted.");
      if(attempt<1){
        removeWithBackshotEngine(file,onProgress,attempt+1).then(resolve,reject);
      }else{
        reject(new Error("Background removal timed out twice. Try a smaller image or reload BackshotAI."));
      }
    },360000);

    removalPending.set(id,{resolve,reject,onProgress,timeout,file});
    try{worker.postMessage({type:"remove",id,file});}
    catch(error){
      clearTimeout(timeout);
      removalPending.delete(id);
      destroyRemovalWorker("The browser could not send the image to the AI worker.");
      if(attempt<1)removeWithBackshotEngine(file,onProgress,attempt+1).then(resolve,reject);
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

  // Background-first segmentation is the preservation-biased path for
  // consistent edge-connected scenes (grass, walls and floors). It removes
  // only pixels connected to a learned border background and never asks a
  // foreground model to decide whether a dark jacket panel should exist.
  const backgroundFirst=await conservativeCloseupFallback(file);
  if(backgroundFirst){
    const [before,after,shape]=await Promise.all([alphaStats(file),alphaStats(backgroundFirst),cutoutShapeStats(backgroundFirst)]);
    if(new URLSearchParams(location.search).has("debugMasks"))document.documentElement.dataset.backgroundDiag=JSON.stringify({before,after,shape});
    if(after.strong>0.08 && after.strong<before.strong*0.94 && shape.largestShare>.95){
      $("#progressText").textContent="Background-first mask complete.";
      let clean=await cleanupDisconnectedSpecks(backgroundFirst,file);
      // A bright low-saturation residual (for example a white rug under grass)
      // is suspicious. Ask RMBG only about those pixels; its decisions can
      // remove the residual but can never delete dark/blue product sections.
      if(await suspiciousResidualRatio(clean)>.00035){
        const evidence=await removeWithBackshotEngine(file);
        clean=await refineResidualBackground(clean,evidence,file);
        clean=await cleanupDisconnectedSpecks(clean,file);
      }
      return clean;
    }
  }

  const blob=await removeWithBackshotEngine(file,msg=>{
    if(msg.stage==="load"&&Number.isFinite(msg.progress)){
      $("#progressText").textContent=`Backshot Engine: loading ${Math.round(msg.progress)}%`;
    }else if(msg.stage==="remove"){
      $("#progressText").textContent="Backshot Engine: removing background…";
    }else if(msg.stage==="safety"){
      $("#progressText").textContent=msg.message||"Protecting product details…";
    }else if(msg.stage==="fast-path"){
      $("#progressText").textContent=msg.message||"Clean mask found — finishing…";
    }else if(msg.stage==="fallback"){
      $("#progressText").textContent=msg.message||"Switching removal engine…";
    }
  });

  if(!(blob instanceof Blob)||!blob.size)throw new Error("The remover returned an empty result.");
  // Every route must finish through the same preservation-biased cleanup.
  // Previously only the background-first jacket route removed disconnected
  // grass specks and green boundary fringe, so otherwise similar batch items
  // could leave the engine with visibly different edge quality.
  $("#progressText").textContent="Backshot Engine: cleaning edges…";
  return await cleanupDisconnectedSpecks(blob,file);
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
}

async function processRemovalQueue(queue,label){
  if(state.processing){
    toast("A removal batch is already running.");
    return;
  }

  queue=Array.from(queue||[]).filter(item=>item&&!item.cutoutBlob);
  if(!queue.length){
    toast(`${label} already have backgrounds removed.`);
    return;
  }

  state.processing=true;
  state.completed=0;
  state.failed=0;

  $("#removeSelectedBtn").disabled=true;
  $("#removeAllBtn").disabled=true;
  $("#progressWrap").classList.remove("hidden");
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
    $("#removeSelectedBtn").disabled=false;
    $("#removeAllBtn").disabled=false;
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
  const shadowCfg=a.shadow||{enabled:true,opacity:.22,blur:24,offsetY:18};
  if(shadowCfg.enabled&&item.cutoutURL){
    ctx.shadowColor=`rgba(0,0,0,${shadowCfg.opacity})`;
    ctx.shadowBlur=shadowCfg.blur*(tw/Math.max(900,tw));
    ctx.shadowOffsetY=shadowCfg.offsetY*(th/Math.max(900,th));
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
const ASSIST_LOCAL_RADIUS=96;

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
function updateEditorUI(){if(!state.editor)return;$("#eraseTool").classList.toggle("active",state.editor.mode==="erase");$("#restoreTool").classList.toggle("active",state.editor.mode==="restore");const assisted=$("#assistToggle").checked;$("#brushSize").disabled=assisted;$("#editorHint").textContent=assisted?`Assisted: tap a ${state.editor.mode==="erase"?"missed background area":"missing product area"} and BackshotAI follows that region.`:state.editor.mode==="erase"?"Manual: brush over unwanted areas.":"Manual: brush over missing parts to restore them.";$("#undoEdit").disabled=state.editor.history.length<=1;$("#redoEdit").disabled=!state.editor.redo.length;}
function setupEditorEvents(){
  const e=state.editor,c=e.canvas,stage=$(".editor-stage");
  stage.onwheel=ev=>{ev.preventDefault();setEditorZoom(e.viewScale*(ev.deltaY<0?1.12:.89));};
  c.onpointerdown=ev=>{
    c.setPointerCapture(ev.pointerId);e.pointers.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});
    if(e.pointers.size===2){const pts=[...e.pointers.values()];e.drawing=false;e.pinch={distance:Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y),scale:e.viewScale,midX:(pts[0].x+pts[1].x)/2,midY:(pts[0].y+pts[1].y)/2,panX:e.panX,panY:e.panY};return;}
    if(ev.button===1||ev.altKey){e.panning={x:ev.clientX,y:ev.clientY,panX:e.panX,panY:e.panY};return;}
    const p=pointFor(ev,c);if($("#assistToggle").checked){assistedTap(p);return;}e.drawing=true;e.last=p;paintAt(p);
  };
  c.onpointermove=ev=>{
    moveBrushCursor(ev);if(e.pointers.has(ev.pointerId))e.pointers.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});
    if(e.pointers.size===2&&e.pinch){const pts=[...e.pointers.values()],distance=Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y),midX=(pts[0].x+pts[1].x)/2,midY=(pts[0].y+pts[1].y)/2;e.viewScale=Math.max(1,Math.min(8,e.pinch.scale*distance/Math.max(1,e.pinch.distance)));e.panX=e.pinch.panX+midX-e.pinch.midX;e.panY=e.pinch.panY+midY-e.pinch.midY;updateEditorTransform();return;}
    if(e.panning){e.panX=e.panning.panX+ev.clientX-e.panning.x;e.panY=e.panning.panY+ev.clientY-e.panning.y;updateEditorTransform();return;}
    if(!e.drawing||$("#assistToggle").checked)return;const p=pointFor(ev,c);paintLine(e.last,p);e.last=p;
  };
  const finish=ev=>{e.pointers.delete(ev.pointerId);e.pinch=null;e.panning=null;if(e.drawing){e.drawing=false;pushHistory();}};
  c.onpointerup=finish;c.onpointercancel=finish;c.onpointerleave=()=>$("#brushCursor").classList.remove("show");c.onpointerenter=()=>$("#brushCursor").classList.add("show");
}
function pointFor(ev,c){const r=c.getBoundingClientRect();return{x:(ev.clientX-r.left)/r.width*c.width,y:(ev.clientY-r.top)/r.height*c.height};}
function brushRadius(){return Number($("#brushSize").value)/2*(state.editor.canvas.width/state.editor.canvas.getBoundingClientRect().width);}
function paintLine(a,b){const dist=Math.hypot(b.x-a.x,b.y-a.y),step=Math.max(2,brushRadius()*.25),n=Math.max(1,Math.ceil(dist/step));for(let i=1;i<=n;i++)paintAt({x:a.x+(b.x-a.x)*i/n,y:a.y+(b.y-a.y)*i/n});}
function paintAt(p){const e=state.editor,r=brushRadius(),ctx=e.ctx;ctx.save();if(e.mode==="erase"){ctx.globalCompositeOperation="destination-out";ctx.fillStyle="#000";ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();}else{ctx.globalCompositeOperation="source-over";ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.clip();const temp=document.createElement("canvas");temp.width=e.canvas.width;temp.height=e.canvas.height;temp.getContext("2d").putImageData(e.originalData,0,0);ctx.drawImage(temp,0,0);}ctx.restore();}

function assistedTap(p){
  const e=state.editor,w=e.canvas.width,h=e.canvas.height;
  const x0=Math.max(0,Math.min(w-1,Math.round(p.x))),y0=Math.max(0,Math.min(h-1,Math.round(p.y)));
  const cur=e.ctx.getImageData(0,0,w,h),cd=cur.data,od=e.originalData.data;
  let sr=0,sg=0,sb=0,sc=0;
  const seedRadius=Math.max(2,Math.round(Math.min(w,h)/350));
  for(let yy=Math.max(0,y0-seedRadius);yy<=Math.min(h-1,y0+seedRadius);yy++){
    for(let xx=Math.max(0,x0-seedRadius);xx<=Math.min(w-1,x0+seedRadius);xx++){
      const o=(yy*w+xx)*4;sr+=od[o];sg+=od[o+1];sb+=od[o+2];sc++;
    }
  }
  const seed=[sr/sc,sg/sc,sb/sc],seedLum=.299*seed[0]+.587*seed[1]+.114*seed[2];
  const visited=new Uint8Array(w*h),stack=[y0*w+x0],region=[];
  const scale=w/Math.max(1,e.canvas.getBoundingClientRect().width);
  const maxRadius=Math.max(12,ASSIST_LOCAL_RADIUS*scale);
  const maxRegion=Math.ceil(Math.PI*maxRadius*maxRadius);
  const colourTol=e.mode==="erase"?82:72,lumTol=e.mode==="erase"?72:62;

  while(stack.length&&region.length<maxRegion){
    const i=stack.pop();if(visited[i])continue;visited[i]=1;
    const x=i%w,y=(i/w)|0;if(Math.hypot(x-x0,y-y0)>maxRadius)continue;
    const o=i*4,a=cd[o+3];
    if(e.mode==="erase"&&a<5)continue;
    if(e.mode==="restore"&&a>250)continue;
    const r=od[o],g=od[o+1],b=od[o+2],dr=r-seed[0],dg=g-seed[1],db=b-seed[2];
    const colour=Math.sqrt(dr*dr*.30+dg*dg*.59+db*db*.11),lum=.299*r+.587*g+.114*b;
    if(colour>colourTol||Math.abs(lum-seedLum)>lumTol)continue;
    region.push(i);
    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
      if(!ox&&!oy)continue;const nx=x+ox,ny=y+oy;if(nx>=0&&nx<w&&ny>=0&&ny<h)stack.push(ny*w+nx);
    }
  }
  if(region.length<3){toast("Tap inside the area you want to change.");return;}
  if(e.mode==="erase"){for(const i of region)cd[i*4+3]=0;}
  else{for(const i of region){const o=i*4;cd[o]=od[o];cd[o+1]=od[o+1];cd[o+2]=od[o+2];cd[o+3]=od[o+3];}}
  e.ctx.putImageData(cur,0,0);pushHistory();toast(`${e.mode==="erase"?"Removed":"Restored"} the selected area.`);
}
function pushHistory(){const e=state.editor;e.history.push(e.ctx.getImageData(0,0,e.canvas.width,e.canvas.height));if(e.history.length>18)e.history.shift();e.redo=[];updateEditorUI();}
function undo(){const e=state.editor;if(e.history.length<=1)return;const cur=e.history.pop();e.redo.push(cur);e.ctx.putImageData(e.history[e.history.length-1],0,0);updateEditorUI();}
function redo(){const e=state.editor;if(!e.redo.length)return;const img=e.redo.pop();e.history.push(img);e.ctx.putImageData(img,0,0);updateEditorUI();}
function moveBrushCursor(ev){const stage=$(".editor-stage").getBoundingClientRect(),size=$("#assistToggle").checked?28:Number($("#brushSize").value),el=$("#brushCursor");el.classList.add("show");el.style.width=`${size}px`;el.style.height=`${size}px`;el.style.left=`${ev.clientX-stage.left-size/2}px`;el.style.top=`${ev.clientY-stage.top-size/2}px`;}
async function smartRecover(){
  const e=state.editor;if(!e)return;
  const button=$("#smartRecover");let recoverURL="";
  button.disabled=true;button.textContent="Checking…";
  try{
    const clean=await chooseSafeCutout(e.item.file);
    recoverURL=URL.createObjectURL(clean);
    const img=await imageFromURL(recoverURL);
    e.ctx.save();e.ctx.globalCompositeOperation="source-over";e.ctx.drawImage(img,0,0,e.canvas.width,e.canvas.height);e.ctx.restore();
    pushHistory();toast("Safer high-quality subject pass merged.");
  }catch(err){
    console.error("Subject re-check failed",err);
    toast(`Re-check failed: ${err?.message||"this device could not complete it."}`);
  }finally{
    if(recoverURL)URL.revokeObjectURL(recoverURL);
    button.disabled=false;button.textContent="Re-check subject";
  }
}
async function applyEditor(){
  const e=state.editor;if(!e)return;
  try{
    const blob=await new Promise((resolve,reject)=>e.canvas.toBlob(value=>value?resolve(value):reject(new Error("The edited image could not be encoded.")),"image/png",1));
    e.item.cutoutBlob=blob;if(e.item.cutoutURL)URL.revokeObjectURL(e.item.cutoutURL);e.item.cutoutURL=URL.createObjectURL(blob);e.item.status="done";
    closeEditor();renderGallery();toast("Cutout updated.");
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
async function downloadItems(items, button, filenamePrefix){
  if(!items.length){toast("Select one or more photos first.");return;}
  const originalText=button.textContent;
  button.disabled=true;button.textContent="Preparing…";
  try{
    const zip=new JSZip();let counter=1;
    for(const item of items){
      const img=await imageFromURL(item.cutoutURL||item.originalURL),canvas=document.createElement("canvas");
      await drawComposite(canvas,item,{width:img.naturalWidth||img.width,height:img.naturalHeight||img.height});
      const transparent=backgroundFor(item).mode==="transparent",mime=transparent?"image/png":"image/jpeg",ext=transparent?"png":"jpg";
      const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error(`Could not export ${item.name}.`)),mime,transparent?undefined:.95));
      const name=(item.name.replace(/\.[^.]+$/,"")||`image-${counter}`).replace(/[^\w\- ]+/g,"").trim().replace(/\s+/g,"-");
      zip.file(`${name||`image-${counter}`}-edited.${ext}`,blob);counter++;
    }
    const out=await zip.generateAsync({type:"blob",compression:"DEFLATE"});
    downloadBlob(out,`${filenamePrefix}-${new Date().toISOString().slice(0,10)}.zip`);
    toast(`ZIP ready: ${items.length} photo${items.length===1?"":"s"}.`);
  }catch(e){console.error(e);toast(`Couldn't create ZIP: ${e?.message||"unknown export error"}`);}
  button.disabled=false;button.textContent=originalText;
}
async function downloadSelected(){await downloadItems(selectedItems(),$("#downloadSelectedBtn"),"BackshotAI-selected");}
async function downloadAll(){await downloadItems(state.items,$("#downloadAllBtn"),"BackshotAI");}

const tutorialSteps=[
  {
    title:"Add your photos",
    text:"Choose one image or a whole batch from Photos or Files.",
    visual:"＋"
  },
  {
    title:"Select exactly what you want",
    text:"Tap individual photos, or click and drag across cards to select several without selecting the whole batch.",
    visual:"✓"
  },
  {
    title:"Remove backgrounds",
    text:"Press Remove selected backgrounds for your selection, or Remove all backgrounds for the entire batch.",
    visual:"✦"
  },
  {
    title:"Choose a new background",
    text:"Keep transparency, use a solid colour, or choose one image to use as the new background.",
    visual:"▧"
  },
  {
    title:"Adjust selected photos or the batch",
    text:"Position, filters and shadows each have their own Selected or Whole batch switch, so every category follows the scope you choose.",
    visual:"↔"
  },
  {
    title:"Refine a cutout",
    text:"Press Edit cutout on one photo to erase or restore areas using Assisted mode or the manual brush.",
    visual:"⌁"
  },
  {
    title:"Download",
    text:"Download only your selected photos or export the complete batch as a ZIP.",
    visual:"↓"
  }
];
let tutorialIndex=0;

function renderTutorial(){
  const step=tutorialSteps[tutorialIndex]||tutorialSteps[0];
  $("#tutorialCount").textContent=`${tutorialIndex+1} / ${tutorialSteps.length}`;
  $("#tutorialTitle").textContent=step.title;
  $("#tutorialText").textContent=step.text;
  $("#tutorialVisual").textContent=step.visual;
  $("#tutorialDots").innerHTML=tutorialSteps
    .map((_,i)=>`<span class="${i===tutorialIndex?"active":""}"></span>`)
    .join("");
  $("#tutorialBack").disabled=tutorialIndex===0;
  $("#tutorialNext").textContent=
    tutorialIndex===tutorialSteps.length-1?"Done":"Next";
}

function openHelp(){tutorialIndex=0;renderTutorial();$("#helpModal").classList.remove("hidden");}
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

const dragSelectBox=$("#dragSelectBox");

function pagePoint(e){ return {x:e.clientX,y:e.clientY}; }
function updateDragBox(x1,y1,x2,y2){
  const left=Math.min(x1,x2),top=Math.min(y1,y2),right=Math.max(x1,x2),bottom=Math.max(y1,y2);
  dragSelectBox.style.left=`${left}px`;dragSelectBox.style.top=`${top}px`;
  dragSelectBox.style.width=`${right-left}px`;dragSelectBox.style.height=`${bottom-top}px`;
  return {left,top,right,bottom};
}
function applyDragSelection(rect){
  let hits=0;
  for(const card of gallery.querySelectorAll(".photo-card")){
    const r=card.getBoundingClientRect();
    const hit=!(r.right<rect.left||r.left>rect.right||r.bottom<rect.top||r.top>rect.bottom);
    if(hit){const id=card.dataset.card;if(id&&!state.selected.has(id)){state.selected.add(id);hits++;}}
  }
  if(hits){updateSelectionClasses();updateSelectionUI();}
}
gallery.addEventListener("pointerdown",e=>{
  if(e.target.closest("button"))return;
  if(e.button!==undefined&&e.button!==0)return;
  const p=pagePoint(e);
  state.dragSelecting=true;state.dragMoved=false;state.dragStartX=p.x;state.dragStartY=p.y;
  updateDragBox(p.x,p.y,p.x,p.y);
  try{gallery.setPointerCapture(e.pointerId);}catch{}
});
gallery.addEventListener("pointermove",e=>{
  if(!state.dragSelecting)return;
  const p=pagePoint(e),dx=p.x-state.dragStartX,dy=p.y-state.dragStartY;
  if(!state.dragMoved && Math.hypot(dx,dy)<9)return;
  // Keep ordinary vertical touch scrolling usable; mouse/pen drag-select is always ready.
  if(e.pointerType==="touch" && Math.abs(dy)>Math.abs(dx)*1.25 && !state.dragMoved){state.dragSelecting=false;return;}
  state.dragMoved=true;e.preventDefault();dragSelectBox.classList.remove("hidden");
  updateDragBox(state.dragStartX,state.dragStartY,p.x,p.y);
});
function finishDragSelection(e){
  if(!state.dragSelecting)return;
  const p=pagePoint(e);state.dragSelecting=false;
  if(state.dragMoved){
    e.preventDefault();e.stopPropagation();
    const rect=updateDragBox(state.dragStartX,state.dragStartY,p.x,p.y);
    applyDragSelection(rect);
  }
  dragSelectBox.classList.add("hidden");
  setTimeout(()=>state.dragMoved=false,0);
}
gallery.addEventListener("pointerup",finishDragSelection);
gallery.addEventListener("pointercancel",()=>{state.dragSelecting=false;state.dragMoved=false;dragSelectBox.classList.add("hidden");});

$("#shadowEnabled").onchange=e=>applyScopedShadow("enabled",e.target.checked);
$("#shadowOpacity").oninput=e=>applyScopedShadow("opacity",Number(e.target.value));
$("#shadowBlur").oninput=e=>applyScopedShadow("blur",Number(e.target.value));
$("#shadowY").oninput=e=>applyScopedShadow("offsetY",Number(e.target.value));
$("#eraseTool").onclick=()=>{state.editor.mode="erase";updateEditorUI();};$("#restoreTool").onclick=()=>{state.editor.mode="restore";updateEditorUI();};$("#assistToggle").onchange=updateEditorUI;$("#undoEdit").onclick=undo;$("#redoEdit").onclick=redo;$("#smartRecover").onclick=smartRecover;$("#applyEdit").onclick=applyEditor;$("#closeEditor").onclick=closeEditor;$("#cutoutModal").onclick=e=>{if(e.target.id==="cutoutModal")closeEditor();};
$("#zoomOutEditor").onclick=()=>setEditorZoom((state.editor?.viewScale||1)/1.25);$("#zoomInEditor").onclick=()=>setEditorZoom((state.editor?.viewScale||1)*1.25);$("#fitEditor").onclick=()=>setEditorZoom(1);
let installPrompt=null;window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;$("#installBtn").classList.remove("hidden");});$("#installBtn").onclick=async()=>{if(!installPrompt){toast("On iPhone: Safari → Share → Add to Home Screen");return;}installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$("#installBtn").classList.add("hidden");};
window.addEventListener("resize",()=>{if(state.editor)requestAnimationFrame(fitEditorCanvasToStage);});
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(console.warn));


function enableScrollChaining(el){
  if(!el)return;

  // Desktop / trackpad scrolling:
  // - scroll the panel while it has more content
  // - once the panel reaches top/bottom, continue scrolling the whole page
  // - never hijack Ctrl/Cmd + wheel because that is browser pinch zoom
  el.addEventListener("wheel",e=>{
    if(e.ctrlKey||e.metaKey)return;

    const up=e.deltaY<0;
    const down=e.deltaY>0;
    const atTop=el.scrollTop<=1;
    const atBottom=Math.ceil(el.scrollTop+el.clientHeight)>=el.scrollHeight-1;

    if((up&&atTop)||(down&&atBottom)){
      e.preventDefault();
      window.scrollBy({top:e.deltaY,left:0,behavior:"auto"});
    }
  },{passive:false});

  // Mobile touch scrolling:
  // keep normal scrolling inside the panel, then hand movement back to the page
  // when the panel reaches either end. Two-finger pinch is left untouched.
  let lastY=null;

  el.addEventListener("touchstart",e=>{
    if(e.touches.length===1)lastY=e.touches[0].clientY;
    else lastY=null;
  },{passive:true});

  el.addEventListener("touchmove",e=>{
    if(e.touches.length!==1||lastY===null)return;

    const y=e.touches[0].clientY;
    const fingerDelta=y-lastY;
    lastY=y;

    const movingDown=fingerDelta>0; // user finger down => content/page goes toward top
    const movingUp=fingerDelta<0;   // user finger up => content/page goes toward bottom
    const atTop=el.scrollTop<=1;
    const atBottom=Math.ceil(el.scrollTop+el.clientHeight)>=el.scrollHeight-1;

    if((movingDown&&atTop)||(movingUp&&atBottom)){
      e.preventDefault();
      window.scrollBy({top:-fingerDelta,left:0,behavior:"auto"});
    }
  },{passive:false});

  el.addEventListener("touchend",()=>{lastY=null;},{passive:true});
  el.addEventListener("touchcancel",()=>{lastY=null;},{passive:true});
}

enableScrollChaining(document.querySelector(".controls"));
enableScrollChaining(document.querySelector(".gallery-shell"));

// Preload only where the device/network has comfortable headroom. Constrained
// devices load on demand so merely opening a shared link cannot crash the tab.
const connection=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
const memory=Number(navigator.deviceMemory||0),cores=Number(navigator.hardwareConcurrency||0);
const mobile=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const constrained=mobile||(memory>0&&memory<6)||(cores>0&&cores<6)||connection?.saveData||/2g/.test(connection?.effectiveType||"");
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
