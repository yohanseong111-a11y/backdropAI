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
    try{
      const safety=await getImglyMask(file,id,primary.width,primary.height);
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

  try{
    const original=await RawImage.fromBlob(file);
    const safety=await getImglyMask(file,id,original.width,original.height);
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
