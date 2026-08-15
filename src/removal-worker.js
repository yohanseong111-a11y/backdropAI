import {AutoModel,AutoProcessor,RawImage} from "@huggingface/transformers";

const PRIMARY_MODEL_ID="onnx-community/BiRefNet_lite";
const FALLBACK_MODEL_ID="briaai/RMBG-1.4";
const RMBG_PROCESSOR_CONFIG={do_normalize:true,do_pad:false,do_rescale:true,do_resize:true,image_mean:[0.5,0.5,0.5],image_std:[1,1,1],resample:2,rescale_factor:1/255,size:{width:1024,height:1024}};
let primaryPromise=null,primaryProcessorPromise=null,fallbackPromise=null,fallbackProcessorPromise=null;

const progressFor=(id,engine)=>info=>{if(Number.isFinite(info?.progress))self.postMessage({type:"progress",id,stage:"load",engine,progress:Number(info.progress)});};

async function loadPrimary(id){
  // Use the upstream model's documented Transformers.js configuration. The
  // fp16 graph currently fails in some ORT WebGPU/WASM builds at inference.
  primaryPromise??=AutoModel.from_pretrained(PRIMARY_MODEL_ID,{dtype:"fp32",progress_callback:progressFor(id,"BiRefNet")});
  primaryProcessorPromise??=AutoProcessor.from_pretrained(PRIMARY_MODEL_ID);
  try{return await Promise.all([primaryPromise,primaryProcessorPromise]);}
  catch(error){primaryPromise=null;primaryProcessorPromise=null;throw error;}
}

async function loadFallback(id){
  fallbackPromise??=AutoModel.from_pretrained(FALLBACK_MODEL_ID,{config:{model_type:"custom"},progress_callback:progressFor(id,"RMBG")});
  fallbackProcessorPromise??=AutoProcessor.from_pretrained(FALLBACK_MODEL_ID,{config:RMBG_PROCESSOR_CONFIG});
  try{return await Promise.all([fallbackPromise,fallbackProcessorPromise]);}
  catch(error){fallbackPromise=null;fallbackProcessorPromise=null;throw error;}
}

async function tensorToAlpha(tensor,width,height,applySigmoid=false){
  const converted=applySigmoid?tensor.sigmoid():tensor;
  const mask=await RawImage.fromTensor(converted.mul(255).to("uint8")).resize(width,height);
  const pixels=width*height,src=mask.data instanceof Uint8Array?mask.data:new Uint8Array(mask.data);
  if(src.length===pixels)return new Uint8Array(src);
  const channels=Math.max(1,Math.floor(src.length/pixels)),alpha=new Uint8Array(pixels);
  for(let i=0;i<pixels;i++)alpha[i]=src[i*channels];
  return alpha;
}

async function existingAlpha(image){
  const rgba=image.rgba().data,alpha=new Uint8Array(image.width*image.height);let transparent=0;
  for(let i=0;i<alpha.length;i++){const a=rgba[i*4+3];alpha[i]=a;if(a<250)transparent++;}
  return transparent>alpha.length*0.001?alpha:null;
}

async function getPrimaryMask(id,image){
  const [model,processor]=await loadPrimary(id);
  self.postMessage({type:"progress",id,stage:"remove",message:"Creating precision matte…"});
  const processed=await processor(image),input=processed.pixel_values||processed.input_image;
  const result=await model({input_image:input}),tensor=result.output_image?.[0]||result.output?.[0];
  if(!tensor)throw new Error("BiRefNet returned no matte.");
  return tensorToAlpha(tensor,image.width,image.height,true);
}

async function getFallbackMask(id,image){
  self.postMessage({type:"progress",id,stage:"fallback",message:"Using compatibility model…"});
  const [model,processor]=await loadFallback(id),{pixel_values}=await processor(image),{output}=await model({input:pixel_values});
  if(!output?.[0])throw new Error("RMBG returned no matte.");
  return tensorToAlpha(output[0],image.width,image.height,false);
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

async function remove(file,id){
  const image=await RawImage.fromBlob(file),preserved=await existingAlpha(image);
  if(preserved){self.postMessage({type:"progress",id,stage:"fast-path",message:"Existing transparency preserved."});return {alpha:preserved,width:image.width,height:image.height,engine:"existing-alpha"};}
  const alpha=await getFallbackMask(id,image),quality=diagnostics(alpha,image.width,image.height);
  if(quality.ratio<0.01||quality.ratio>0.985)throw new Error("The compatibility model returned an unsafe matte.");
  return {alpha,width:image.width,height:image.height,engine:"rmbg",quality};
}

self.onmessage=async event=>{
  const {type,id,file}=event.data||{};
  if(type==="warm"){
    try{await loadFallback(id);self.postMessage({type:"ready",id,acceleration:"wasm"});}
    catch(error){console.warn("Model warmup skipped",error);self.postMessage({type:"ready",id,acceleration:"fallback"});}
    return;
  }
  if(type!=="remove"||!file)return;
  try{
    const result=await remove(file,id);
    self.postMessage({type:"dual-mask",id,width:result.width,height:result.height,primaryBuffer:result.alpha.buffer,safetyBuffer:null,engine:result.engine,quality:result.quality},[result.alpha.buffer]);
  }catch(error){self.postMessage({type:"error",id,error:error?.message||String(error)});}
};
