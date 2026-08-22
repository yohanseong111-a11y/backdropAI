import {AutoModel,AutoProcessor,RawImage,env} from "@huggingface/transformers";

// Load models from the deployed GitHub Pages origin. School/corporate filters
// often allow the app's github.io URL but block Hugging Face model downloads.
// The Pages workflow installs these files into dist/models during deployment.
env.allowLocalModels=true;
// Local/same-origin is attempted first. Remote access remains an emergency
// recovery path for an incomplete deployment instead of making every photo fail.
env.allowRemoteModels=true;
env.useBrowserCache=true;
env.localModelPath=new URL("../models/",self.location.href).href;

const FALLBACK_MODEL_ID="briaai/RMBG-1.4";
// RMBG-1.4 was trained at 1024px. Small inference squares are much cheaper but
// they blur away thin gaps (between two legs, between an arm and the body) and
// leave a halo of original background, so only the phone-friendly profiles drop
// below 512. main.js refines the mask against the real photo afterwards, which
// recovers most of the remaining detail without extra inference cost.
const WORKER_UA=self.navigator?.userAgent||"";
const IS_MOBILE=self.navigator?.userAgentData?.mobile===true||
  /iPhone|iPad|iPod|Android/i.test(WORKER_UA)||
  (/Macintosh/i.test(WORKER_UA)&&Number(self.navigator?.maxTouchPoints||0)>1);
const inferenceSizeFor=profile=>profile==="fast"?320:profile==="best"?(IS_MOBILE?768:1024):(IS_MOBILE?512:768);
const processorConfig=size=>({do_normalize:true,do_pad:false,do_rescale:true,do_resize:true,image_mean:[0.5,0.5,0.5],image_std:[1,1,1],resample:2,rescale_factor:1/255,size:{width:size,height:size}});
let fallbackPromise=null;
const fallbackProcessorPromises=new Map();
let fallbackDevice="wasm",webGPUDisabled=false;

function canUseStableWebGPU(){
  const memory=Number(self.navigator?.deviceMemory||0);
  const cores=Number(self.navigator?.hardwareConcurrency||0);
  const mobile=IS_MOBILE;
  // FP16 is fast but considerably heavier. Restrict it to machines with
  // enough headroom; shared/school Chromebooks stay on the stable q8 path.
  return !mobile&&memory>=8&&cores>=8&&!!self.navigator?.gpu;
}

const progressFor=(id,engine)=>info=>{if(Number.isFinite(info?.progress))self.postMessage({type:"progress",id,stage:"load",engine,progress:Number(info.progress)});};

async function loadFallback(id,profile="auto"){
  // Prefer GPU inference where ONNX WebGPU is available. The quantized WASM
  // graph remains the reliable low-memory fallback for Safari and mobile.
  fallbackPromise??=(async()=>{
    // Always load the quantized graph. The fp16 file is twice as large and
    // made the first visit sit on "Downloading AI" for a long time.
    if(!webGPUDisabled&&canUseStableWebGPU()){
      try{
        const model=await AutoModel.from_pretrained(FALLBACK_MODEL_ID,{config:{model_type:"custom"},device:"webgpu",dtype:"q8",progress_callback:progressFor(id,"RMBG")});
        fallbackDevice="webgpu";return model;
      }catch(error){
        console.warn("WebGPU model unavailable; using quantized WASM",error);
        webGPUDisabled=true;
      }
    }
    fallbackDevice="wasm";
    return AutoModel.from_pretrained(FALLBACK_MODEL_ID,{config:{model_type:"custom"},device:"wasm",dtype:"q8",progress_callback:progressFor(id,"RMBG")});
  })();
  const size=inferenceSizeFor(profile);
  if(!fallbackProcessorPromises.has(size))fallbackProcessorPromises.set(size,AutoProcessor.from_pretrained(FALLBACK_MODEL_ID,{config:processorConfig(size)}));
  try{return await Promise.all([fallbackPromise,fallbackProcessorPromises.get(size)]);}
  catch(error){
    fallbackPromise=null;fallbackProcessorPromises.delete(size);
    throw new Error(`The AI model could not load from this site. Check that the latest GitHub Pages deployment completed, then reload. ${error?.message||error}`);
  }
}

async function tensorToAlpha(tensor){
  // Keep the native inference mask compact. Expanding it to a 12–48 MP phone
  // image here previously duplicated large buffers and could reload the tab.
  const mask=await RawImage.fromTensor(tensor.mul(255).to("uint8"));
  const pixels=mask.width*mask.height,src=mask.data instanceof Uint8Array?mask.data:new Uint8Array(mask.data);
  if(src.length===pixels)return {alpha:new Uint8Array(src),width:mask.width,height:mask.height};
  const channels=Math.max(1,Math.floor(src.length/pixels)),alpha=new Uint8Array(pixels);
  for(let i=0;i<pixels;i++)alpha[i]=src[i*channels];
  return {alpha,width:mask.width,height:mask.height};
}

async function existingAlpha(image){
  const rgba=image.rgba().data,alpha=new Uint8Array(image.width*image.height);let transparent=0;
  for(let i=0;i<alpha.length;i++){const a=rgba[i*4+3];alpha[i]=a;if(a<250)transparent++;}
  return transparent>alpha.length*0.001?alpha:null;
}

async function getFallbackMask(id,image,profile){
  self.postMessage({type:"progress",id,stage:"remove",message:"Removing background…"});
  let [model,processor]=await loadFallback(id,profile),{pixel_values}=await processor(image),result;
  try{result=await model({input:pixel_values});}
  catch(error){
    if(fallbackDevice!=="webgpu")throw error;
    console.warn("WebGPU inference failed; retrying with quantized WASM",error);
    webGPUDisabled=true;fallbackPromise=null;
    [model,processor]=await loadFallback(id,profile);
    result=await model({input:pixel_values});
  }
  const {output}=result;
  if(!output?.[0])throw new Error("RMBG returned no matte.");
  return tensorToAlpha(output[0]);
}

function diagnostics(alpha,w,h){
  const total=w*h,seen=new Uint8Array(total),queue=new Int32Array(total);let strong=0,soft=0,minX=w,maxX=-1,minY=h,maxY=-1,components=0,largest=0;
  for(let i=0;i<total;i++){const a=alpha[i];if(a>=128){strong++;const x=i%w,y=(i/w)|0;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}else if(a>=16)soft++;}
  for(let start=0;start<total;start++){
    if(seen[start]||alpha[start]<128)continue;
    let head=0,tail=0,count=0;seen[start]=1;queue[tail++]=start;
    while(head<tail){const i=queue[head++],x=i%w,y=(i/w)|0;count++;const add=j=>{if(j>=0&&j<total&&!seen[j]&&alpha[j]>=128){seen[j]=1;queue[tail++]=j;}};if(x)add(i-1);if(x<w-1)add(i+1);if(y)add(i-w);if(y<h-1)add(i+w);}
    if(count>Math.max(20,total*0.00005)){components++;largest=Math.max(largest,count);}
  }
  const ratio=strong/Math.max(1,total),bboxArea=maxX>=minX?(maxX-minX+1)*(maxY-minY+1):0;let holes=0,samples=0;
  if(bboxArea){const step=Math.max(1,Math.floor(Math.sqrt(bboxArea/100000)));for(let y=minY;y<=maxY;y+=step)for(let x=minX;x<=maxX;x+=step){samples++;if(alpha[y*w+x]<24)holes++;}}
  return {ratio,softRatio:soft/Math.max(1,total),components,largestShare:strong?largest/strong:0,holeRatio:samples?holes/samples:0,width:maxX>=minX?maxX-minX+1:0,height:maxY>=minY?maxY-minY+1:0,suspicious:ratio<0.025||ratio>0.96||(strong&&largest/strong<0.82)||components>8};
}

async function remove(file,id,profile="auto"){
  const image=await RawImage.fromBlob(file),preserved=await existingAlpha(image);
  if(preserved){self.postMessage({type:"progress",id,stage:"fast-path",message:"Existing transparency preserved."});return {alpha:preserved,width:image.width,height:image.height,engine:"existing-alpha"};}
  const mask=await getFallbackMask(id,image,profile),quality=diagnostics(mask.alpha,mask.width,mask.height);
  if(quality.ratio<0.01||quality.ratio>0.985)throw new Error("The compatibility model returned an unsafe matte.");
  return {alpha:mask.alpha,width:mask.width,height:mask.height,engine:"rmbg",quality};
}

self.onmessage=async event=>{
  const {type,id,file,profile="auto"}=event.data||{};
  if(type==="warm"){
    try{await loadFallback(id);self.postMessage({type:"ready",id,acceleration:fallbackDevice});}
    catch(error){console.warn("Model warmup skipped",error);self.postMessage({type:"ready",id,acceleration:"fallback"});}
    return;
  }
  if(type!=="remove"||!file)return;
  try{
    const result=await remove(file,id,profile);
    self.postMessage({type:"dual-mask",id,width:result.width,height:result.height,primaryBuffer:result.alpha.buffer,safetyBuffer:null,engine:result.engine,quality:result.quality},[result.alpha.buffer]);
  }catch(error){self.postMessage({type:"error",id,error:error?.message||String(error)});}
};
