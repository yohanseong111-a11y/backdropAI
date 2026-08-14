import "./style.css";
import "./editor.css";
import JSZip from "jszip";
import { removeBackground, preload } from "@imgly/background-removal";

const DEFAULT_ADJ = () => ({ scale: 1, offsetX: 0, offsetY: 0, brightness: 100, contrast: 100, saturation: 100 });

const state = {
  items: [],
  selected: new Set(),
  backgroundURL: null,
  backgroundName: "",
  bgMode: "transparent",
  solidColor: "#ffffff",
  shadow: { enabled: true, opacity: 0.22, blur: 24, offsetY: 18 },
  processing: false,
  completed: 0,
  failed: 0,
  quality: "smart",
  editor: null
};

const app = document.querySelector("#app");
app.innerHTML = `
<header class="topbar">
  <div><div class="brand">BackdropAI</div><div class="subtitle">Bulk background studio</div></div>
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
        <select id="qualitySelect">
          <option value="smart" selected>Smart — recommended</option>
          <option value="best">Best quality</option>
          <option value="fast">Fast</option>
        </select>
      </div>
      <button id="removeAllBtn" class="primary">Remove all backgrounds</button>
      <div id="progressWrap" class="progress-wrap hidden">
        <div class="progress-track"><div id="progressBar" class="progress-bar"></div></div>
        <div id="progressText" class="small"></div>
      </div>
      <p class="privacy-note">The model is cached after first use. Removal runs off the main UI thread when supported.</p>

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
        <div class="selection-actions"><button id="selectAll" class="text-btn">All</button><button id="selectNone" class="text-btn">None</button></div>
      </div>
      <p class="selection-help">Tap photos below. Changes only apply to selected photos.</p>
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
      <button id="downloadAllBtn" class="primary success">Download all as ZIP</button>
      <button id="clearBtn" class="danger ghost">Clear batch</button>
    </aside>

    <section class="gallery-shell">
      <div class="gallery-head">
        <div><h2>Your batch</h2><p id="batchCount">0 photos</p></div>
        <button id="addMoreBtn" class="ghost">+ Add more</button>
      </div>
      <div id="gallery" class="gallery"></div>
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
      <span id="editorHint">Assisted: tap a missed area and BackdropAI follows that region.</span>
      <button id="applyEdit" class="primary compact">Apply cutout</button>
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
  if (files.length) { workspace.classList.remove("hidden"); renderGallery(); updateSelectionUI(); }
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
        ${item.status === "processing" ? `<img class="processing-original" src="${item.originalURL}" alt="" /><div class="scan-line"></div><div class="scan-glow"></div>` : item.status === "revealing" ? `
          <img class="reveal-original" src="${item.originalURL}" alt="" />
          <img class="reveal-cutout" src="${item.cutoutURL}" alt="" />
          <div class="reveal-scan-line"></div>
        ` : `<canvas class="preview-canvas" data-index="${index}"></canvas>`}
        <button class="select-chip" data-select="${item.id}" type="button">${state.selected.has(item.id) ? "✓" : ""}</button>
        <div class="status ${item.status}">${statusText(item)}</div>
      </div>
      <div class="photo-actions">
        <button class="edit-cutout ${item.cutoutURL ? "" : "disabled"}" data-edit="${item.id}" ${item.cutoutURL ? "" : "disabled"}>Edit cutout</button>
        <button class="remove-one" data-remove="${item.id}">×</button>
      </div>
      <div class="photo-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
    </article>`).join("");

  document.querySelectorAll("[data-card]").forEach(card=>card.onclick=e=>{
    if(e.target.closest("button")) return;
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
  $("#selectedCount").textContent=`${items.length} selected`;
  $("#selectedControls").disabled=!items.length;
  if(first){
    $("#scaleRange").value=first.adj.scale; $("#xRange").value=first.adj.offsetX; $("#yRange").value=first.adj.offsetY;
    $("#brightnessRange").value=first.adj.brightness; $("#contrastRange").value=first.adj.contrast; $("#saturationRange").value=first.adj.saturation;
  }
}
function applyToSelected(key,value){
  const items=selectedItems(); if(!items.length){toast("Select one or more photos first.");return;}
  for(const item of items)item.adj[key]=value;
  renderAllPreviews();
}

function removalConfig(mode, progress, forceCPU = false) {
  const hasGPU = !!navigator.gpu && !forceCPU;
  const model = mode === "best" ? "isnet" : mode === "fast" ? "isnet_quint8" : "isnet_fp16";
  return {
    model,
    device: hasGPU ? "gpu" : "cpu",
    proxyToWorker: true,
    output: { format: "image/png", quality: 1 },
    progress
  };
}
async function removeStable(file, mode, progress) {
  try { return await removeBackground(file, removalConfig(mode, progress, false)); }
  catch (gpuError) {
    if (!navigator.gpu) throw gpuError;
    console.warn("GPU removal failed; retrying on CPU", gpuError);
    return await removeBackground(file, removalConfig(mode, progress, true));
  }
}
function preloadRemovalModel() {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 250));
  idle(async () => {
    try { await preload(removalConfig("smart", () => {}, false)); document.documentElement.dataset.removerReady = "true"; }
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
  const bmp=await createImageBitmap(blob), c=document.createElement("canvas");c.width=bmp.width;c.height=bmp.height;
  const ctx=c.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0);
  const img=ctx.getImageData(0,0,c.width,c.height),d=img.data,w=c.width,h=c.height;
  const alpha=new Uint8Array(w*h);for(let i=0,p=3;i<alpha.length;i++,p+=4)alpha[i]=d[p];
  // Conservative 1px edge decontamination: only modify semi-transparent boundary pixels.
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i=y*w+x,a=alpha[i];if(a===0||a===255)continue;
      const minA=Math.min(alpha[i-1],alpha[i+1],alpha[i-w],alpha[i+w]);
      let out=a;
      if(minA<20 && a<215) out=Math.max(0,Math.round((a-24)*0.88));
      if(a<28) out=0;
      d[i*4+3]=out;
      // Pull bright fringe colour toward a nearby opaque subject pixel.
      if(out>0 && out<210){
        const candidates=[i-1,i+1,i-w,i+w,i-w-1,i-w+1,i+w-1,i+w+1];
        let best=-1,bestA=0;for(const n of candidates){if(alpha[n]>bestA){bestA=alpha[n];best=n;}}
        if(best>=0&&bestA>225){const mix=(210-out)/210*.48;for(let k=0;k<3;k++)d[i*4+k]=Math.round(d[i*4+k]*(1-mix)+d[best*4+k]*mix);}
      }
    }
    // Yield regularly so the scanner and touch UI keep animating on large phone photos.
    if(y%96===0) await new Promise(r=>setTimeout(r,0));
  }
  ctx.putImageData(img,0,0);return await new Promise(res=>c.toBlob(res,"image/png",1));
}

async function chooseSafeCutout(file, mode, progress){
  let primary=await removeStable(file,mode,progress);
  let stats=await alphaStats(primary);
  if(mode==="smart" && (stats.visible<0.012 || stats.strong<0.006 || stats.visible>0.985)){
    $("#progressText").textContent="Protecting the product — running a safer pass…";
    const best=await removeStable(file,"best",progress), bstats=await alphaStats(best);
    if(bstats.strong>stats.strong*1.15 || stats.visible<0.012) primary=best;
  }
  return cleanCutoutEdges(primary);
}

function nextFrame(){return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}
async function removeOne(item, queueTotal) {
  item.status="processing"; renderGallery(); await nextFrame();
  try {
    const progress=(key,current,total)=>{if(total>0&&/fetch|model/i.test(key))$("#progressText").textContent=`Loading removal model… ${Math.round(current/total*100)}%`;};
    const blob=await chooseSafeCutout(item.file,state.quality,progress);
    item.cutoutBlob=blob;if(item.cutoutURL)URL.revokeObjectURL(item.cutoutURL);item.cutoutURL=URL.createObjectURL(blob);
    item.status="revealing";item.error=null;renderGallery();await new Promise(resolve=>setTimeout(resolve,760));
    item.status="done";state.completed++;
  } catch(error) {
    console.error(error);item.status="failed";item.error=error?.message||"Background removal failed";state.failed++;
  }
  updateProgress(queueTotal);renderGallery();
}
async function removeAllBackgrounds() {
  if(state.processing||!state.items.length)return;
  const queue=state.items.filter(i=>!i.cutoutBlob);if(!queue.length){toast("All backgrounds are already removed.");return;}
  state.processing=true;state.completed=0;state.failed=0;$("#removeAllBtn").disabled=true;$("#progressWrap").classList.remove("hidden");
  const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent),concurrency=isIOS?1:(navigator.gpu?2:1);let cursor=0;
  async function worker(){while(cursor<queue.length){const item=queue[cursor++];await removeOne(item,queue.length);}}
  await Promise.all(Array.from({length:Math.min(concurrency,queue.length)},worker));
  state.processing=false;$("#removeAllBtn").disabled=false;updateProgress(queue.length);toast(state.failed?`${state.completed} finished, ${state.failed} failed.`:`Finished ${state.completed} cutouts.`);
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
  if(state.shadow.enabled&&item.cutoutURL){ctx.shadowColor=`rgba(0,0,0,${state.shadow.opacity})`;ctx.shadowBlur=state.shadow.blur*(tw/Math.max(900,tw));ctx.shadowOffsetY=state.shadow.offsetY*(th/Math.max(900,th));}
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
function updateEditorUI(){if(!state.editor)return;$("#eraseTool").classList.toggle("active",state.editor.mode==="erase");$("#restoreTool").classList.toggle("active",state.editor.mode==="restore");const assisted=$("#assistToggle").checked;$("#brushSize").disabled=assisted;$("#editorHint").textContent=assisted?`Assisted: tap a ${state.editor.mode==="erase"?"missed background area":"missing product area"} and BackdropAI follows that region.`:state.editor.mode==="erase"?"Manual: brush over unwanted areas.":"Manual: brush over missing parts to restore them.";$("#undoEdit").disabled=state.editor.history.length<=1;$("#redoEdit").disabled=!state.editor.redo.length;}
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
  const e=state.editor,w=e.canvas.width,h=e.canvas.height,x0=Math.max(0,Math.min(w-1,Math.round(p.x))),y0=Math.max(0,Math.min(h-1,Math.round(p.y))),start=y0*w+x0;
  const cur=e.ctx.getImageData(0,0,w,h),cd=cur.data,od=e.originalData.data,seed=[od[start*4],od[start*4+1],od[start*4+2]],visited=new Uint8Array(w*h),stack=[start],region=[];
  const tolerance=e.mode==="erase"?58:48,maxRegion=Math.round(w*h*.34);
  while(stack.length&&region.length<maxRegion){const i=stack.pop();if(visited[i])continue;visited[i]=1;const x=i%w,y=(i/w)|0,off=i*4,alpha=cd[off+3];if(e.mode==="erase"&&alpha<6)continue;if(e.mode==="restore"&&alpha>245)continue;const dr=od[off]-seed[0],dg=od[off+1]-seed[1],db=od[off+2]-seed[2],dist=Math.sqrt(dr*dr+dg*dg+db*db);if(dist>tolerance)continue;region.push(i);if(x>0)stack.push(i-1);if(x<w-1)stack.push(i+1);if(y>0)stack.push(i-w);if(y<h-1)stack.push(i+w);}
  if(region.length<2){toast("Try tapping directly on the missed area.");return;}
  if(e.mode==="erase"){for(const i of region)cd[i*4+3]=0;}else{for(const i of region){const o=i*4;cd[o]=od[o];cd[o+1]=od[o+1];cd[o+2]=od[o+2];cd[o+3]=od[o+3];}}
  e.ctx.putImageData(cur,0,0);pushHistory();toast(`${e.mode==="erase"?"Removed":"Restored"} connected area.`);
}
function pushHistory(){const e=state.editor;e.history.push(e.ctx.getImageData(0,0,e.canvas.width,e.canvas.height));if(e.history.length>18)e.history.shift();e.redo=[];updateEditorUI();}
function undo(){const e=state.editor;if(e.history.length<=1)return;const cur=e.history.pop();e.redo.push(cur);e.ctx.putImageData(e.history[e.history.length-1],0,0);updateEditorUI();}
function redo(){const e=state.editor;if(!e.redo.length)return;const img=e.redo.pop();e.history.push(img);e.ctx.putImageData(img,0,0);updateEditorUI();}
function moveBrushCursor(ev){const stage=$(".editor-stage").getBoundingClientRect(),size=$("#assistToggle").checked?28:Number($("#brushSize").value),el=$("#brushCursor");el.classList.add("show");el.style.width=`${size}px`;el.style.height=`${size}px`;el.style.left=`${ev.clientX-stage.left-size/2}px`;el.style.top=`${ev.clientY-stage.top-size/2}px`;}
async function smartRecover(){const e=state.editor;if(!e)return;$("#smartRecover").disabled=true;$("#smartRecover").textContent="Checking…";try{const blob=await removeStable(e.item.file,"best",()=>{}),clean=await cleanCutoutEdges(blob),img=await imageFromURL(URL.createObjectURL(clean));e.ctx.save();e.ctx.globalCompositeOperation="source-over";e.ctx.drawImage(img,0,0,e.canvas.width,e.canvas.height);e.ctx.restore();pushHistory();toast("Safer high-quality subject pass merged.");}catch(err){toast("Re-check failed on this device.");}$("#smartRecover").disabled=false;$("#smartRecover").textContent="Re-check subject";}
async function applyEditor(){const e=state.editor;if(!e)return;let blob=await new Promise(res=>e.canvas.toBlob(res,"image/png",1));blob=await cleanCutoutEdges(blob);e.item.cutoutBlob=blob;if(e.item.cutoutURL)URL.revokeObjectURL(e.item.cutoutURL);e.item.cutoutURL=URL.createObjectURL(blob);e.item.status="done";closeEditor();renderGallery();toast("Cutout updated.");}
function closeEditor(){$("#cutoutModal").classList.add("hidden");state.editor=null;}

/* ---------- Export ---------- */
async function downloadAll(){if(!state.items.length)return;$("#downloadAllBtn").disabled=true;$("#downloadAllBtn").textContent="Preparing ZIP…";try{const zip=new JSZip();let counter=1;for(const item of state.items){const img=await imageFromURL(item.cutoutURL||item.originalURL),canvas=document.createElement("canvas");await drawComposite(canvas,item,{width:img.naturalWidth||img.width,height:img.naturalHeight||img.height});const transparent=state.bgMode==="transparent",mime=transparent?"image/png":"image/jpeg",ext=transparent?"png":"jpg",blob=await new Promise(r=>canvas.toBlob(r,mime,transparent?undefined:.94)),name=(item.name.replace(/\.[^.]+$/,"")||`image-${counter}`).replace(/[^\w\- ]+/g,"").trim().replace(/\s+/g,"-");zip.file(`${name||`image-${counter}`}-edited.${ext}`,blob);counter++;}const out=await zip.generateAsync({type:"blob",compression:"DEFLATE"});downloadBlob(out,`BackdropAI-${new Date().toISOString().slice(0,10)}.zip`);}catch(e){console.error(e);toast("Couldn't create ZIP.");}$("#downloadAllBtn").disabled=false;$("#downloadAllBtn").textContent="Download all as ZIP";}
function downloadBlob(blob,name){const a=document.createElement("a"),url=URL.createObjectURL(blob);a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}

/* ---------- controls ---------- */
photoInput.onchange=e=>addFiles(e.target.files);$("#addMoreBtn").onclick=()=>photoInput.click();$("#removeAllBtn").onclick=removeAllBackgrounds;$("#downloadAllBtn").onclick=downloadAll;$("#qualitySelect").onchange=e=>state.quality=e.target.value;
$("#clearBtn").onclick=()=>{for(const i of state.items)cleanupItem(i);state.items=[];state.selected.clear();workspace.classList.add("hidden");gallery.innerHTML="";updateSelectionUI();};
document.querySelectorAll(".seg").forEach(btn=>btn.onclick=()=>{state.bgMode=btn.dataset.bg;document.querySelectorAll(".seg").forEach(b=>b.classList.toggle("active",b===btn));$("#solidControls").classList.toggle("hidden",state.bgMode!=="solid");$("#backgroundPicker").classList.toggle("hidden",state.bgMode!=="image");renderAllPreviews();});
$("#solidColor").oninput=e=>{state.solidColor=e.target.value;renderAllPreviews();};
backgroundInput.onchange=e=>{const f=e.target.files?.[0];if(!f)return;if(state.backgroundURL)URL.revokeObjectURL(state.backgroundURL);state.backgroundURL=URL.createObjectURL(f);state.backgroundName=f.name;state.bgMode="image";$("#backgroundPreviewImage").src=state.backgroundURL;$("#backgroundPreviewName").textContent=f.name;$("#backgroundPreview").classList.remove("hidden");document.querySelectorAll(".seg").forEach(b=>b.classList.toggle("active",b.dataset.bg==="image"));renderAllPreviews();toast("Background applied to the whole batch.");};
$("#clearBackground").onclick=()=>{if(state.backgroundURL)URL.revokeObjectURL(state.backgroundURL);state.backgroundURL=null;state.backgroundName="";backgroundInput.value="";$("#backgroundPreview").classList.add("hidden");state.bgMode="transparent";document.querySelectorAll(".seg").forEach(b=>b.classList.toggle("active",b.dataset.bg==="transparent"));renderAllPreviews();};
$("#selectAll").onclick=()=>{state.selected=new Set(state.items.map(i=>i.id));renderGallery();updateSelectionUI();};$("#selectNone").onclick=()=>{state.selected.clear();renderGallery();updateSelectionUI();};
$("#scaleRange").oninput=e=>applyToSelected("scale",Number(e.target.value));$("#xRange").oninput=e=>applyToSelected("offsetX",Number(e.target.value));$("#yRange").oninput=e=>applyToSelected("offsetY",Number(e.target.value));$("#brightnessRange").oninput=e=>applyToSelected("brightness",Number(e.target.value));$("#contrastRange").oninput=e=>applyToSelected("contrast",Number(e.target.value));$("#saturationRange").oninput=e=>applyToSelected("saturation",Number(e.target.value));
$("#resetSelected").onclick=()=>{for(const i of selectedItems())i.adj=DEFAULT_ADJ();updateSelectionUI();renderAllPreviews();};
$("#shadowEnabled").onchange=e=>{state.shadow.enabled=e.target.checked;renderAllPreviews();};$("#shadowOpacity").oninput=e=>{state.shadow.opacity=Number(e.target.value);renderAllPreviews();};$("#shadowBlur").oninput=e=>{state.shadow.blur=Number(e.target.value);renderAllPreviews();};$("#shadowY").oninput=e=>{state.shadow.offsetY=Number(e.target.value);renderAllPreviews();};
$("#eraseTool").onclick=()=>{state.editor.mode="erase";updateEditorUI();};$("#restoreTool").onclick=()=>{state.editor.mode="restore";updateEditorUI();};$("#assistToggle").onchange=updateEditorUI;$("#undoEdit").onclick=undo;$("#redoEdit").onclick=redo;$("#smartRecover").onclick=smartRecover;$("#applyEdit").onclick=applyEditor;$("#closeEditor").onclick=closeEditor;$("#cutoutModal").onclick=e=>{if(e.target.id==="cutoutModal")closeEditor();};
let installPrompt=null;window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;$("#installBtn").classList.remove("hidden");});$("#installBtn").onclick=async()=>{if(!installPrompt){toast("On iPhone: Safari → Share → Add to Home Screen");return;}installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$("#installBtn").classList.add("hidden");};
window.addEventListener("resize",()=>{if(state.editor)requestAnimationFrame(fitEditorCanvasToStage);});
preloadRemovalModel();if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(console.warn));
