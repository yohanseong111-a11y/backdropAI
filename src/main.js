import "./style.css";
import "./editor.css";
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
        <div class="single-mode-badge">Backshot Engine <span id="engineStatus">Preparing…</span></div>
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

      <div class="divider"></div>
      <div class="selection-head">
        <div><div class="section-title no-margin">3. Selected photos</div><span id="selectedCount">0 selected</span></div>
        <div class="selection-actions">
          <button id="selectAll" class="text-btn" type="button">All</button>
          <button id="selectNone" class="text-btn" type="button">None</button>
        </div>
      </div>
      <p class="selection-help">Tap photos individually or click-drag across the batch to select several. Edits and “Remove selected” only affect those photos.</p>
      <fieldset id="selectedControls" disabled>
        <label class="control-row"><span>Scale</span><input id="scaleRange" type="range" min="0.55" max="1.35" step="0.01" value="1" /></label>
        <label class="control-row"><span>Horizontal</span><input id="xRange" type="range" min="-30" max="30" step="1" value="0" /></label>
        <label class="control-row"><span>Vertical</span><input id="yRange" type="range" min="-30" max="30" step="1" value="0" /></label>

        <div class="mini-title">Filters</div>
        <label class="control-row"><span>Brightness</span><input id="brightnessRange" type="range" min="50" max="150" step="1" value="100" /></label>
        <label class="control-row"><span>Contrast</span><input id="contrastRange" type="range" min="50" max="150" step="1" value="100" /></label>
        <label class="control-row"><span>Saturation</span><input id="saturationRange" type="range" min="0" max="200" step="1" value="100" /></label>
        <button id="resetSelected" class="ghost reset-btn" type="button">Reset selected edits</button>
      </fieldset>

      <div class="divider"></div>
      <div class="section-title">4. Shadow</div>
      <label class="toggle-row"><span>Shadow</span><input id="shadowEnabled" type="checkbox" checked /></label>
      <label class="control-row"><span>Strength</span><input id="shadowOpacity" type="range" min="0" max="0.5" step="0.01" value="0.22" /></label>
      <label class="control-row"><span>Softness</span><input id="shadowBlur" type="range" min="0" max="70" step="1" value="24" /></label>
      <label class="control-row"><span>Distance</span><input id="shadowY" type="range" min="-30" max="70" step="1" value="18" /></label>

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
      <div><span class="help-kicker">HOW TO USE BACKDROPAI</span><strong id="helpTitle">Quick tutorial</strong></div>
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
}
function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/"));
  for (const file of files) {
    state.items.push({
      id: crypto.randomUUID(), name: file.name, file,
      originalURL: URL.createObjectURL(file), cutoutBlob: null, cutoutURL: null,
      status: "waiting", error: null, adj: DEFAULT_ADJ()
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
  renderGallery(); updateSelectionUI();
}
function selectedItems(){ return state.items.filter(i=>state.selected.has(i.id)); }
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
  $("#selectedControls").disabled=!items.length;
  if(first){
    $("#scaleRange").value=first.adj.scale; $("#xRange").value=first.adj.offsetX; $("#yRange").value=first.adj.offsetY;
    $("#brightnessRange").value=first.adj.brightness; $("#contrastRange").value=first.adj.contrast; $("#saturationRange").value=first.adj.saturation;
    const shadowCfg=first.adj.shadow||{enabled:true,opacity:.22,blur:24,offsetY:18};
    $("#shadowEnabled").checked=shadowCfg.enabled; $("#shadowOpacity").value=shadowCfg.opacity; $("#shadowBlur").value=shadowCfg.blur; $("#shadowY").value=shadowCfg.offsetY;
  }
}
function applyToSelected(key,value){
  const items=selectedItems(); if(!items.length){toast("Select one or more photos first.");return;}
  for(const item of items)item.adj[key]=value;
  renderAllPreviews();
}
function applyShadowToSelected(key,value){
  const items=selectedItems(); if(!items.length){toast("Select one or more photos first.");return;}
  for(const item of items){
    item.adj.shadow ||= {enabled:true,opacity:.22,blur:24,offsetY:18};
    item.adj.shadow[key]=value;
  }
  renderAllPreviews();
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

async function conservativeCloseupFallback(file){
  // Only remove a dominant border background connected to the outer edge.
  // This is intentionally conservative: when uncertain, keep the product.
  const bmp=await createImageBitmap(file);
  const maxSide=420,s=Math.min(1,maxSide/Math.max(bmp.width,bmp.height));
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

  let spread=0;
  for(const p of samples)spread+=Math.hypot(p[0]-seed[0],p[1]-seed[1],p[2]-seed[2]);
  spread/=samples.length;
  const tol=Math.max(58,Math.min(125,spread*2.2+42));

  const candidate=new Uint8Array(w*h);
  for(let i=0;i<w*h;i++){
    const o=i*4;
    const dist=Math.hypot(d[o]-seed[0],d[o+1]-seed[1],d[o+2]-seed[2]);
    if(dist<tol)candidate[i]=1;
  }

  // Flood only from top/upper-side edge seeds, never from the whole frame.
  const bg=new Uint8Array(w*h),q=[];
  const push=(x,y)=>{const i=y*w+x;if(candidate[i]&&!bg[i]){bg[i]=1;q.push(i);}};
  for(let x=0;x<w;x++)push(x,0);
  for(let y=0;y<Math.round(h*.35);y++){push(0,y);push(w-1,y);}
  for(let qi=0;qi<q.length;qi++){
    const i=q[qi],x=i%w,y=(i/w)|0;
    if(x>0)push(x-1,y);if(x<w-1)push(x+1,y);if(y>0)push(x,y-1);if(y<h-1)push(x,y+1);
  }

  let bgCount=0;for(const v of bg)bgCount+=v;
  const ratio=bgCount/(w*h);
  if(ratio<.025||ratio>.48)return null;

  const full=document.createElement("canvas");full.width=bmp.width;full.height=bmp.height;
  const fctx=full.getContext("2d",{willReadFrequently:true});fctx.drawImage(bmp,0,0);
  const out=fctx.getImageData(0,0,full.width,full.height),od=out.data;

  for(let y=0;y<full.height;y++){
    const sy=Math.min(h-1,Math.floor(y*h/full.height));
    for(let x=0;x<full.width;x++){
      const sx=Math.min(w-1,Math.floor(x*w/full.width));
      if(bg[sy*w+sx])od[(y*full.width+x)*4+3]=0;
    }
    if(y%180===0)await new Promise(r=>setTimeout(r,0));
  }
  fctx.putImageData(out,0,0);
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

function getRemovalWorker(){
  if(removalWorker)return removalWorker;
  removalWorker=new Worker(new URL("./removal-worker.js",import.meta.url),{type:"module"});
  removalWorker.onmessage=e=>{
    const msg=e.data||{};
    const job=removalPending.get(msg.id);
    if(msg.type==="progress"){
      if(job?.onProgress)job.onProgress(msg);
      return;
    }
    if(!job)return;
    if(msg.type==="done"){
      removalPending.delete(msg.id);
      job.resolve(msg.blob);
    }else if(msg.type==="error"){
      removalPending.delete(msg.id);
      job.reject(new Error(msg.error||"Removal failed"));
    }
  };
  removalWorker.onerror=e=>console.error("Backshot Engine worker error",e);
  return removalWorker;
}



let engineWarmStarted=false;
function warmBackshotEngine(){
  if(engineWarmStarted)return;
  engineWarmStarted=true;
  const id=`warm-${Date.now()}`;
  const worker=getRemovalWorker();
  const status=$("#engineStatus");
  if(status)status.textContent="Downloading AI…";
  const handler=e=>{
    const msg=e.data||{};
    if(msg.id!==id)return;
    if(msg.type==="progress"&&msg.stage==="load"&&status){
      status.textContent=`Loading ${Math.round(msg.progress||0)}%`;
    }else if(msg.type==="ready"){
      worker.removeEventListener("message",handler);
      if(status)status.textContent=msg.acceleration==="webgpu"?"AI Ready ✓ GPU":"AI Ready ✓";
    }else if(msg.type==="error"){
      worker.removeEventListener("message",handler);
      engineWarmStarted=false;
      if(status)status.textContent="Loads on Remove";
    }
  };
  worker.addEventListener("message",handler);
  worker.postMessage({type:"warm",id});
}

function removeWithBackshotEngine(file,onProgress){
  return new Promise((resolve,reject)=>{
    const id=++removalSeq;
    removalPending.set(id,{resolve,reject,onProgress});
    getRemovalWorker().postMessage({type:"remove",id,file});
  });
}

async function chooseSafeCutout(file){
  $("#progressText").textContent="Backshot Engine: starting removal…";
  return removeWithBackshotEngine(file,msg=>{
    if(msg.stage==="load"&&Number.isFinite(msg.progress)){
      $("#progressText").textContent=`Backshot Engine: loading ${Math.round(msg.progress)}%`;
    }else if(msg.stage==="remove"){
      $("#progressText").textContent="Backshot Engine: removing background…";
    }
  });
}

function nextFrame(){return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}
async function removeOne(item, queueTotal) {
  item.status="processing";renderGallery();
  // Yield a couple frames first so scrolling/zooming remains responsive before work begins.
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  try {
    const progress=(key,current,total)=>{
      if(total>0&&/fetch|model/i.test(key))$("#progressText").textContent=`Loading removal model… ${Math.round(current/total*100)}%`;
    };

    const blob=await chooseSafeCutout(item.file);
    item.cutoutBlob=blob;
    if(item.cutoutURL)URL.revokeObjectURL(item.cutoutURL);
    item.cutoutURL=URL.createObjectURL(blob);
    item.status="revealing";item.error=null;renderGallery();
    await new Promise(resolve=>setTimeout(resolve,900));
    item.status="done";state.completed++;
  } catch(error) {
    console.error(error);
    item.status="failed";
    if(error?.message==="PHOTOROOM_KEY_MISSING"){
      item.error="Add your BackshotAI API key or switch to Fast mode.";
    }else if(error?.status===402){
      item.error="BackshotAI API credits are empty.";
    }else if(error?.status===401||error?.status===403){
      item.error="BackshotAI API key was rejected.";
    }else if(error?.name==="AbortError"){
      item.error="BackshotAI request timed out.";
    }else{
      item.error=error?.message||"Background removal failed";
    }
    state.failed++;
  }
  updateProgress(queueTotal);renderGallery();
}
async function processRemovalQueue(queue,label){
  if(state.processing)return;
  queue=queue.filter(i=>!i.cutoutBlob);
  if(!queue.length){toast(`${label} already have backgrounds removed.`);return;}
  state.processing=true;state.completed=0;state.failed=0;
  $("#removeSelectedBtn").disabled=true;$("#removeAllBtn").disabled=true;$("#progressWrap").classList.remove("hidden");

  // Real bulk mode: run several photos at once, but cap concurrency to avoid crashing phones.
  const concurrency=1;

  let cursor=0;
  async function worker(){
    while(cursor<queue.length){
      const item=queue[cursor++];
      await removeOne(item,queue.length);
      // Yield between jobs so page scrolling/pinch-zoom and scanner animation get paint time.
      await new Promise(r=>setTimeout(r,0));
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,queue.length)},()=>worker()));

  state.processing=false;$("#removeSelectedBtn").disabled=false;$("#removeAllBtn").disabled=false;
  updateProgress(queue.length);
  toast(state.failed?`${state.completed} finished, ${state.failed} failed.`:`Finished ${state.completed} cutouts.`);
}
async function removeSelectedBackgrounds() {
  const picked=selectedItems();
  if(!picked.length){toast("Select one or more photos first.");return;}
  await processRemovalQueue(picked, "Selected photos");
}
async function removeAllBackgrounds() {
  if(!state.items.length)return;
  await processRemovalQueue(state.items, "All photos");
}
function updateProgress(total=state.items.length){const finished=state.completed+state.failed,pct=total?Math.round(finished/total*100):0;$("#progressBar").style.width=`${pct}%`;$("#progressText").textContent=state.processing?`${finished}/${total} processed`:`${finished}/${total} finished${state.failed?` • ${state.failed} failed`:""}`;}

async function imageFromURL(url){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=url;});}
function drawCover(ctx,img,w,h){const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height,s=Math.max(w/iw,h/ih),dw=iw*s,dh=ih*s;ctx.drawImage(img,(w-dw)/2,(h-dh)/2,dw,dh);}
async function drawComposite(canvas,item,exportSize=null){
  const sourceURL=item.cutoutURL||item.originalURL;if(!sourceURL)return;const subject=await imageFromURL(sourceURL),sw=subject.naturalWidth||subject.width,sh=subject.naturalHeight||subject.height;
  const tw=exportSize?.width||sw,th=exportSize?.height||sh;canvas.width=tw;canvas.height=th;const ctx=canvas.getContext("2d");ctx.clearRect(0,0,tw,th);
  if(state.bgMode==="solid"){ctx.fillStyle=state.solidColor;ctx.fillRect(0,0,tw,th);}else if(state.bgMode==="image"&&state.backgroundURL){drawCover(ctx,await imageFromURL(state.backgroundURL),tw,th);}
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
async function renderAllPreviews(){for(const canvas of document.querySelectorAll(".preview-canvas")){const item=state.items[Number(canvas.dataset.index)];if(!item)continue;try{const img=await imageFromURL(item.cutoutURL||item.originalURL),ratio=(img.naturalHeight||img.height)/(img.naturalWidth||img.width),w=Math.max(260,canvas.parentElement.clientWidth*2);await drawComposite(canvas,item,{width:Math.round(w),height:Math.round(w*ratio)});}catch{}}}

/* ---------- Cutout editor ---------- */
async function openEditor(id){
  const item=state.items.find(x=>x.id===id);if(!item?.cutoutURL)return;
  const original=await imageFromURL(item.originalURL),cutout=await imageFromURL(item.cutoutURL),canvas=$("#editorCanvas"),max=1400,s=Math.min(1,max/Math.max(original.naturalWidth,original.naturalHeight));
  canvas.width=Math.round(original.naturalWidth*s);canvas.height=Math.round(original.naturalHeight*s);const ctx=canvas.getContext("2d",{willReadFrequently:true});ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(cutout,0,0,canvas.width,canvas.height);
  const oc=document.createElement("canvas");oc.width=canvas.width;oc.height=canvas.height;const octx=oc.getContext("2d",{willReadFrequently:true});octx.drawImage(original,0,0,canvas.width,canvas.height);
  state.editor={item,original,canvas,ctx,originalData:octx.getImageData(0,0,canvas.width,canvas.height),mode:"erase",history:[ctx.getImageData(0,0,canvas.width,canvas.height)],redo:[],drawing:false,last:null};
  $("#cutoutModal").classList.remove("hidden");
  requestAnimationFrame(()=>{ fitEditorCanvasToStage(); updateEditorUI(); setupEditorEvents(); });
}
function fitEditorCanvasToStage(){
  if(!state.editor)return;
  const stage=$(".editor-stage"),canvas=state.editor.canvas;
  const pad=24,availableW=Math.max(1,stage.clientWidth-pad*2),availableH=Math.max(1,stage.clientHeight-pad*2);
  const fit=Math.min(availableW/canvas.width,availableH/canvas.height,1);
  canvas.style.width=`${Math.max(1,Math.floor(canvas.width*fit))}px`;
  canvas.style.height=`${Math.max(1,Math.floor(canvas.height*fit))}px`;
}
function updateEditorUI(){if(!state.editor)return;$("#eraseTool").classList.toggle("active",state.editor.mode==="erase");$("#restoreTool").classList.toggle("active",state.editor.mode==="restore");const assisted=$("#assistToggle").checked;$("#brushSize").disabled=assisted;$("#editorHint").textContent=assisted?`Assisted: tap a ${state.editor.mode==="erase"?"missed background area":"missing product area"} and BackshotAI follows that region.`:state.editor.mode==="erase"?"Manual: brush over unwanted areas.":"Manual: brush over missing parts to restore them.";$("#undoEdit").disabled=state.editor.history.length<=1;$("#redoEdit").disabled=!state.editor.redo.length;}
function setupEditorEvents(){
  const e=state.editor,c=e.canvas;
  c.onpointerdown=ev=>{const p=pointFor(ev,c);c.setPointerCapture(ev.pointerId);if($("#assistToggle").checked){assistedTap(p);return;}e.drawing=true;e.last=p;paintAt(p);};
  c.onpointermove=ev=>{moveBrushCursor(ev);if(!e.drawing||$("#assistToggle").checked)return;const p=pointFor(ev,c);paintLine(e.last,p);e.last=p;};
  c.onpointerup=()=>{if(e.drawing){e.drawing=false;pushHistory();}};c.onpointercancel=()=>{e.drawing=false;};c.onpointerleave=()=>$("#brushCursor").classList.remove("show");c.onpointerenter=()=>$("#brushCursor").classList.add("show");
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
  const maxRegion=Math.round(w*h*.28),maxRadius=Math.max(70,Math.min(w,h)*.42);
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
  const expanded=new Set(region);
  for(const i of region){
    const x=i%w,y=(i/w)|0;
    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
      const nx=x+ox,ny=y+oy;if(nx>=0&&nx<w&&ny>=0&&ny<h)expanded.add(ny*w+nx);
    }
  }
  if(e.mode==="erase"){for(const i of expanded)cd[i*4+3]=0;}
  else{for(const i of expanded){const o=i*4;cd[o]=od[o];cd[o+1]=od[o+1];cd[o+2]=od[o+2];cd[o+3]=od[o+3];}}
  e.ctx.putImageData(cur,0,0);pushHistory();toast(`${e.mode==="erase"?"Removed":"Restored"} the selected area.`);
}
function pushHistory(){const e=state.editor;e.history.push(e.ctx.getImageData(0,0,e.canvas.width,e.canvas.height));if(e.history.length>18)e.history.shift();e.redo=[];updateEditorUI();}
function undo(){const e=state.editor;if(e.history.length<=1)return;const cur=e.history.pop();e.redo.push(cur);e.ctx.putImageData(e.history[e.history.length-1],0,0);updateEditorUI();}
function redo(){const e=state.editor;if(!e.redo.length)return;const img=e.redo.pop();e.history.push(img);e.ctx.putImageData(img,0,0);updateEditorUI();}
function moveBrushCursor(ev){const stage=$(".editor-stage").getBoundingClientRect(),size=$("#assistToggle").checked?28:Number($("#brushSize").value),el=$("#brushCursor");el.classList.add("show");el.style.width=`${size}px`;el.style.height=`${size}px`;el.style.left=`${ev.clientX-stage.left-size/2}px`;el.style.top=`${ev.clientY-stage.top-size/2}px`;}
async function smartRecover(){const e=state.editor;if(!e)return;$("#smartRecover").disabled=true;$("#smartRecover").textContent="Checking…";try{const clean=await chooseSafeCutout(e.item.file),img=await imageFromURL(URL.createObjectURL(clean));e.ctx.save();e.ctx.globalCompositeOperation="source-over";e.ctx.drawImage(img,0,0,e.canvas.width,e.canvas.height);e.ctx.restore();pushHistory();toast("Safer high-quality subject pass merged.");}catch(err){toast("Re-check failed on this device.");}$("#smartRecover").disabled=false;$("#smartRecover").textContent="Re-check subject";}
async function applyEditor(){const e=state.editor;if(!e)return;let blob=await new Promise(res=>e.canvas.toBlob(res,"image/png",1));blob=await cleanCutoutEdges(blob);e.item.cutoutBlob=blob;if(e.item.cutoutURL)URL.revokeObjectURL(e.item.cutoutURL);e.item.cutoutURL=URL.createObjectURL(blob);e.item.status="done";closeEditor();renderGallery();toast("Cutout updated.");}
function closeEditor(){$("#cutoutModal").classList.add("hidden");state.editor=null;}

/* ---------- Export ---------- */
async function downloadItems(items, button, filenamePrefix){
  if(!items.length){toast("Select one or more photos first.");return;}
  const originalText=button.textContent;
  button.disabled=true;button.textContent="Preparing…";
  try{
    const zip=new JSZip();let counter=1;
    for(const item of items){
      const img=await imageFromURL(item.cutoutURL||item.originalURL),canvas=document.createElement("canvas");
      await drawComposite(canvas,item,{width:img.naturalWidth||img.width,height:img.naturalHeight||img.height});
      const transparent=state.bgMode==="transparent",mime=transparent?"image/png":"image/jpeg",ext=transparent?"png":"jpg";
      const blob=await new Promise(r=>canvas.toBlob(r,mime,transparent?undefined:.95));
      const name=(item.name.replace(/\.[^.]+$/,"")||`image-${counter}`).replace(/[^\w\- ]+/g,"").trim().replace(/\s+/g,"-");
      zip.file(`${name||`image-${counter}`}-edited.${ext}`,blob);counter++;
    }
    const out=await zip.generateAsync({type:"blob",compression:"DEFLATE"});
    downloadBlob(out,`${filenamePrefix}-${new Date().toISOString().slice(0,10)}.zip`);
  }catch(e){console.error(e);toast("Couldn't create ZIP.");}
  button.disabled=false;button.textContent=originalText;
}
async function downloadSelected(){await downloadItems(selectedItems(),$("#downloadSelectedBtn"),"BackshotAI-selected");}
async function downloadAll(){await downloadItems(state.items,$("#downloadAllBtn"),"BackshotAI");}
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
if(localStorage.getItem("backshotaiDragGuideDismissed")==="1")dragGuide.classList.add("hidden");
$("#dragGuideGotIt").onclick=()=>{dragGuide.classList.add("guide-dismiss");localStorage.setItem("backshotaiDragGuideDismissed","1");setTimeout(()=>dragGuide.classList.add("hidden"),180);};

$("#removeSelectedBtn").onclick=removeSelectedBackgrounds;
$("#removeAllBtn").onclick=removeAllBackgrounds;
$("#downloadSelectedBtn").onclick=downloadSelected;$("#downloadAllBtn").onclick=downloadAll;
$("#clearBtn").onclick=()=>{for(const i of state.items)cleanupItem(i);state.items=[];state.selected.clear();workspace.classList.add("hidden");gallery.innerHTML="";updateSelectionUI();};
document.querySelectorAll(".seg").forEach(btn=>btn.onclick=()=>{state.bgMode=btn.dataset.bg;document.querySelectorAll(".seg").forEach(b=>b.classList.toggle("active",b===btn));$("#solidControls").classList.toggle("hidden",state.bgMode!=="solid");$("#backgroundPicker").classList.toggle("hidden",state.bgMode!=="image");renderAllPreviews();});
$("#solidColor").oninput=e=>{state.solidColor=e.target.value;renderAllPreviews();};
backgroundInput.onchange=e=>{const f=e.target.files?.[0];if(!f)return;if(state.backgroundURL)URL.revokeObjectURL(state.backgroundURL);state.backgroundURL=URL.createObjectURL(f);state.backgroundName=f.name;state.bgMode="image";$("#backgroundPreviewImage").src=state.backgroundURL;$("#backgroundPreviewName").textContent=f.name;$("#backgroundPreview").classList.remove("hidden");document.querySelectorAll(".seg").forEach(b=>b.classList.toggle("active",b.dataset.bg==="image"));renderAllPreviews();toast("Background applied to the whole batch.");};
$("#clearBackground").onclick=()=>{if(state.backgroundURL)URL.revokeObjectURL(state.backgroundURL);state.backgroundURL=null;state.backgroundName="";backgroundInput.value="";$("#backgroundPreview").classList.add("hidden");state.bgMode="transparent";document.querySelectorAll(".seg").forEach(b=>b.classList.toggle("active",b.dataset.bg==="transparent"));renderAllPreviews();};
$("#selectAll").onclick=()=>{state.selected=new Set(state.items.map(i=>i.id));renderGallery();updateSelectionUI();};$("#selectNone").onclick=()=>{state.selected.clear();renderGallery();updateSelectionUI();};
$("#scaleRange").oninput=e=>applyToSelected("scale",Number(e.target.value));$("#xRange").oninput=e=>applyToSelected("offsetX",Number(e.target.value));$("#yRange").oninput=e=>applyToSelected("offsetY",Number(e.target.value));$("#brightnessRange").oninput=e=>applyToSelected("brightness",Number(e.target.value));$("#contrastRange").oninput=e=>applyToSelected("contrast",Number(e.target.value));$("#saturationRange").oninput=e=>applyToSelected("saturation",Number(e.target.value));

$("#resetSelected").onclick=()=>{for(const i of selectedItems())i.adj=DEFAULT_ADJ();updateSelectionUI();renderAllPreviews();};

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
  if(hits){renderGallery();updateSelectionUI();}
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

$("#shadowEnabled").onchange=e=>applyShadowToSelected("enabled",e.target.checked);
$("#shadowOpacity").oninput=e=>applyShadowToSelected("opacity",Number(e.target.value));
$("#shadowBlur").oninput=e=>applyShadowToSelected("blur",Number(e.target.value));
$("#shadowY").oninput=e=>applyShadowToSelected("offsetY",Number(e.target.value));
$("#eraseTool").onclick=()=>{state.editor.mode="erase";updateEditorUI();};$("#restoreTool").onclick=()=>{state.editor.mode="restore";updateEditorUI();};$("#assistToggle").onchange=updateEditorUI;$("#undoEdit").onclick=undo;$("#redoEdit").onclick=redo;$("#smartRecover").onclick=smartRecover;$("#applyEdit").onclick=applyEditor;$("#closeEditor").onclick=closeEditor;$("#cutoutModal").onclick=e=>{if(e.target.id==="cutoutModal")closeEditor();};
let installPrompt=null;window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;$("#installBtn").classList.remove("hidden");});$("#installBtn").onclick=async()=>{if(!installPrompt){toast("On iPhone: Safari → Share → Add to Home Screen");return;}installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$("#installBtn").classList.add("hidden");};
window.addEventListener("resize",()=>{if(state.editor)requestAnimationFrame(fitEditorCanvasToStage);});
// Local model loads only when Fast mode is used.if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(console.warn));


function enableScrollChaining(el){
  if(!el)return;
  el.addEventListener("wheel",e=>{
    if(e.ctrlKey||e.metaKey)return;
    const up=e.deltaY<0,down=e.deltaY>0;
    const atTop=el.scrollTop<=0;
    const atBottom=Math.ceil(el.scrollTop+el.clientHeight)>=el.scrollHeight;
    if((up&&atTop)||(down&&atBottom)){
      e.preventDefault();
      window.scrollBy({top:e.deltaY,behavior:"auto"});
    }
  },{passive:false});
}
enableScrollChaining(document.querySelector(".controls"));
enableScrollChaining(document.querySelector(".gallery-shell"));

// Prepare/cache the AI model after the page becomes idle.
// This never processes a photo; removal still starts only from the Remove buttons.
if("requestIdleCallback" in window){
  requestIdleCallback(()=>warmBackshotEngine(),{timeout:1800});
}else{
  setTimeout(()=>warmBackshotEngine(),1200);
}
