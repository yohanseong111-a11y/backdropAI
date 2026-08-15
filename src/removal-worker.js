import {
  AutoModel,
  AutoProcessor,
  RawImage,
} from "@huggingface/transformers";
import { removeBackground as imglyRemoveBackground } from "@imgly/background-removal";

const MODEL_ID="briaai/RMBG-1.4";

const PROCESSOR_CONFIG={
  do_normalize:true,
  do_pad:false,
  do_rescale:true,
  do_resize:true,
  image_mean:[0.5,0.5,0.5],
  feature_extractor_type:"ImageFeatureExtractor",
  image_std:[1,1,1],
  resample:2,
  rescale_factor:0.00392156862745098,
  size:{width:1024,height:1024},
};

let modelPromise=null;
let processorPromise=null;

function resetRMBG(){
  modelPromise=null;
  processorPromise=null;
}

async function loadRMBG(id){
  modelPromise ??= AutoModel.from_pretrained(MODEL_ID,{
    config:{model_type:"custom"},
    progress_callback(info){
      if(Number.isFinite(info?.progress)){
        self.postMessage({
          type:"progress",
          id,
          stage:"load",
          progress:Number(info.progress)
        });
      }
    }
  });

  processorPromise ??= AutoProcessor.from_pretrained(MODEL_ID,{
    config:PROCESSOR_CONFIG
  });

  try{
    return await Promise.all([modelPromise,processorPromise]);
  }catch(error){
    resetRMBG();
    throw error;
  }
}

async function getRMBGMask(file,id){
  const [model,processor]=await loadRMBG(id);
  const image=await RawImage.fromBlob(file);
  const {pixel_values}=await processor(image);
  const {output}=await model({input:pixel_values});

  if(!output?.[0])throw new Error("RMBG returned no alpha output.");

  const mask=await RawImage.fromTensor(
    output[0].mul(255).to("uint8")
  ).resize(image.width,image.height);

  const pixels=image.width*image.height;
  let src=mask.data;
  if(!(src instanceof Uint8Array)&&!(src instanceof Uint8ClampedArray)){
    src=new Uint8Array(src);
  }

  let alpha;
  if(src.length===pixels){
    alpha=new Uint8Array(src);
  }else{
    const channels=Math.max(1,Math.floor(src.length/pixels));
    alpha=new Uint8Array(pixels);
    for(let i=0;i<pixels;i++)alpha[i]=src[i*channels];
  }

  return {alpha,width:image.width,height:image.height};
}

async function getImglyMask(file,id,width,height){
  self.postMessage({
    type:"progress",
    id,
    stage:"safety",
    message:"Protecting product details…"
  });

  const cutout=await imglyRemoveBackground(file,{
    model:"isnet_fp16",
    device:"cpu",
    proxyToWorker:false,
    output:{format:"image/png",quality:1}
  });

  const image=await RawImage.fromBlob(cutout);
  const rgba=image.rgba().data;

  if(image.width===width&&image.height===height){
    const alpha=new Uint8Array(width*height);
    for(let i=0;i<alpha.length;i++)alpha[i]=rgba[i*4+3];
    return alpha;
  }

  const rawAlpha=new Uint8Array(image.width*image.height);
  for(let i=0;i<rawAlpha.length;i++)rawAlpha[i]=rgba[i*4+3];

  const raw=new RawImage(rawAlpha,image.width,image.height,1);
  const resized=await raw.resize(width,height);
  return new Uint8Array(resized.data);
}


function analysePrimaryMask(alpha,w,h){
  const total=w*h;
  let strong=0;
  let soft=0;
  let minX=w,maxX=-1,minY=h,maxY=-1;

  for(let i=0;i<total;i++){
    const a=alpha[i];
    if(a>=128){
      strong++;
      const x=i%w,y=(i/w)|0;
      if(x<minX)minX=x;if(x>maxX)maxX=x;
      if(y<minY)minY=y;if(y>maxY)maxY=y;
    }else if(a>=24){
      soft++;
    }
  }

  const visibleRatio=strong/Math.max(1,total);
  const softRatio=soft/Math.max(1,total);

  if(maxX<minX||maxY<minY){
    return {
      suspicious:true,
      reason:"no foreground",
      visibleRatio,
      componentCount:0,
      holeRatio:1
    };
  }

  // Count substantial foreground components.
  const visited=new Uint8Array(total);
  const queue=new Int32Array(total);
  let componentCount=0;
  let largest=0;

  for(let start=0;start<total;start++){
    if(visited[start]||alpha[start]<128)continue;

    let head=0,tail=0,count=0;
    queue[tail++]=start;
    visited[start]=1;

    while(head<tail){
      const i=queue[head++];
      count++;
      const x=i%w,y=(i/w)|0;

      const add=j=>{
        if(j<0||j>=total||visited[j]||alpha[j]<128)return;
        visited[j]=1;
        queue[tail++]=j;
      };

      if(x>0)add(i-1);
      if(x<w-1)add(i+1);
      if(y>0)add(i-w);
      if(y<h-1)add(i+w);
    }

    if(count>Math.max(40,total*0.00015)){
      componentCount++;
      if(count>largest)largest=count;
    }
  }

  const largestShare=strong?largest/strong:0;

  // Detect enclosed transparent holes inside the foreground bounding box.
  // A large hole ratio is a strong signal that a jacket/body section was clipped.
  const bw=maxX-minX+1,bh=maxY-minY+1;
  const boxArea=Math.max(1,bw*bh);
  let lowInside=0;
  let samples=0;
  const step=Math.max(1,Math.floor(Math.sqrt(boxArea/90000)));

  for(let y=minY;y<=maxY;y+=step){
    for(let x=minX;x<=maxX;x+=step){
      samples++;
      if(alpha[y*w+x]<32)lowInside++;
    }
  }

  const holeRatio=samples?lowInside/samples:0;

  // Conservative thresholds:
  // - tiny/implausible subject -> safety pass
  // - fragmented subject -> safety pass
  // - many internal holes -> safety pass
  // - unusually fuzzy mask -> safety pass
  const suspicious =
    visibleRatio<0.045 ||
    largestShare<0.72 ||
    componentCount>5 ||
    holeRatio>0.52 ||
    softRatio>0.12;

  return {
    suspicious,
    visibleRatio,
    softRatio,
    componentCount,
    largestShare,
    holeRatio
  };
}

async function getDualMask(file,id){
  self.postMessage({type:"progress",id,stage:"remove"});

  let primary=null;
  let primaryError=null;

  try{
    primary=await getRMBGMask(file,id);
  }catch(error){
    primaryError=error;
    resetRMBG();
    console.warn("RMBG failed",error);
  }

  if(primary){
    const quality=analysePrimaryMask(
      primary.alpha,
      primary.width,
      primary.height
    );

    // Fast path: if RMBG already produced a structurally healthy mask,
    // skip the second model entirely.
    if(!quality.suspicious){
      self.postMessage({
        type:"progress",
        id,
        stage:"fast-path",
        message:"Clean mask found — finishing…"
      });

      return {
        width:primary.width,
        height:primary.height,
        primary:primary.alpha,
        safety:null
      };
    }

    // Safety model only runs on photos where the first mask looks unsafe.
    try{
      self.postMessage({
        type:"progress",
        id,
        stage:"safety",
        message:"Protecting missing product areas…"
      });

      const safety=await getImglyMask(
        file,
        id,
        primary.width,
        primary.height
      );

      return {
        width:primary.width,
        height:primary.height,
        primary:primary.alpha,
        safety
      };
    }catch(error){
      console.warn("Safety mask failed; using RMBG only",error);
      return {
        width:primary.width,
        height:primary.height,
        primary:primary.alpha,
        safety:null
      };
    }
  }

  // Primary model failed entirely, so compatibility model becomes the primary.
  try{
    const original=await RawImage.fromBlob(file);
    const safety=await getImglyMask(
      file,
      id,
      original.width,
      original.height
    );

    return {
      width:original.width,
      height:original.height,
      primary:safety,
      safety:null
    };
  }catch(fallbackError){
    throw new Error(
      `Primary remover: ${primaryError?.message||primaryError}. `+
      `Compatibility remover: ${fallbackError?.message||fallbackError}.`
    );
  }
}

self.onmessage=async event=>{
  const {type,id,file}=event.data||{};

  if(type==="warm"){
    try{
      await loadRMBG(id);
      self.postMessage({type:"ready",id,acceleration:"wasm"});
    }catch(error){
      resetRMBG();
      console.warn("Warmup skipped",error);
      self.postMessage({type:"ready",id,acceleration:"fallback"});
    }
    return;
  }

  if(type!=="remove"||!file)return;

  try{
    const result=await getDualMask(file,id);
    const transfer=[result.primary.buffer];
    const payload={
      type:"dual-mask",
      id,
      width:result.width,
      height:result.height,
      primaryBuffer:result.primary.buffer,
      safetyBuffer:null
    };

    if(result.safety){
      payload.safetyBuffer=result.safety.buffer;
      transfer.push(result.safety.buffer);
    }

    self.postMessage(payload,transfer);
  }catch(error){
    self.postMessage({
      type:"error",
      id,
      error:error?.message||String(error)
    });
  }
};
