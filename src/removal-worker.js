import { pipeline, RawImage } from "@huggingface/transformers";

let segmenterPromise=null;

function getSegmenter(id){
  if(segmenterPromise)return segmenterPromise;

  const hasWebGPU=typeof navigator!=="undefined" && !!navigator.gpu;
  const options={
    device:hasWebGPU?"webgpu":"wasm",
    progress_callback(info){
      if(Number.isFinite(info?.progress)){
        self.postMessage({type:"progress",id,stage:"load",progress:Number(info.progress)});
      }
    }
  };

  // RMBG-1.4 provides an fp16 ONNX file for WebGPU.
  // On WASM we intentionally leave dtype unspecified so Transformers.js can
  // choose the repository's browser-compatible quantized/default file.
  if(hasWebGPU)options.dtype="fp16";

  segmenterPromise=pipeline(
    "image-segmentation",
    "briaai/RMBG-1.4",
    options
  );

  return segmenterPromise;
}

async function resizeForInference(file){
  const original=await createImageBitmap(file);
  const hasWebGPU=typeof navigator!=="undefined" && !!navigator.gpu;
  const ua=(self.navigator?.userAgent||"");
  const isiPhone=/iPhone/i.test(ua);
  const isiPad=/iPad/i.test(ua);
  const mem=Number(self.navigator?.deviceMemory||4);

  let maxSide;
  if(hasWebGPU){
    maxSide=mem>=8?896:768;
  }else if(isiPhone||isiPad){
    maxSide=576;
  }else{
    maxSide=mem<=4?512:640;
  }

  const scale=Math.min(1,maxSide/Math.max(original.width,original.height));
  const width=Math.max(1,Math.round(original.width*scale));
  const height=Math.max(1,Math.round(original.height*scale));

  if(scale===1){
    return {
      bitmap:original,
      width,height,
      originalWidth:original.width,
      originalHeight:original.height,
      sourceBlob:file
    };
  }

  let small;
  try{
    small=await createImageBitmap(file,{
      resizeWidth:width,
      resizeHeight:height,
      resizeQuality:"high"
    });
  }catch{
    const canvas=new OffscreenCanvas(width,height);
    const ctx=canvas.getContext("2d",{alpha:true});
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality="high";
    ctx.drawImage(original,0,0,width,height);
    const sourceBlob=await canvas.convertToBlob({type:"image/webp",quality:.92});
    return {
      bitmap:original,width,height,
      originalWidth:original.width,
      originalHeight:original.height,
      sourceBlob
    };
  }

  const canvas=new OffscreenCanvas(width,height);
  const ctx=canvas.getContext("2d",{alpha:true});
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality="high";
  ctx.drawImage(small,0,0,width,height);
  const sourceBlob=await canvas.convertToBlob({type:"image/webp",quality:.92});
  small.close?.();

  return {
    bitmap:original,width,height,
    originalWidth:original.width,
    originalHeight:original.height,
    sourceBlob
  };
}

async function getForegroundMask(result,width,height){
  const list=Array.isArray(result)?result:[result];
  const masks=list.map(x=>x?.mask).filter(Boolean);
  if(!masks.length){
    throw new Error("RMBG returned no foreground mask.");
  }

  // RMBG normally returns one foreground mask. If a browser/version returns
  // several segments, union them conservatively so we don't punch holes in products.
  const prepared=[];
  for(let mask of masks){
    if(mask.channels!==1)mask=mask.clone().grayscale();
    if(mask.width!==width||mask.height!==height){
      mask=await mask.resize(width,height);
    }
    prepared.push(mask);
  }

  if(prepared.length===1)return prepared[0];

  const data=new Uint8ClampedArray(width*height);
  for(const mask of prepared){
    for(let i=0;i<data.length;i++){
      if(mask.data[i]>data[i])data[i]=mask.data[i];
    }
  }
  return new RawImage(data,width,height,1);
}

async function applyMaskToOriginal(originalBitmap,mask){
  const ow=originalBitmap.width,oh=originalBitmap.height;
  if(mask.channels!==1)mask=mask.clone().grayscale();
  if(mask.width!==ow||mask.height!==oh){
    mask=await mask.resize(ow,oh);
  }

  const outputCanvas=new OffscreenCanvas(ow,oh);
  const outCtx=outputCanvas.getContext("2d",{willReadFrequently:true});
  outCtx.drawImage(originalBitmap,0,0);
  const out=outCtx.getImageData(0,0,ow,oh);
  const od=out.data;
  const md=mask.data;

  for(let i=0;i<ow*oh;i++){
    od[i*4+3]=md[i];
  }

  outCtx.putImageData(out,0,0);
  return outputCanvas.convertToBlob({type:"image/png"});
}

async function removeBackgroundFast(file,id){
  const segmenter=await getSegmenter(id);
  self.postMessage({type:"progress",id,stage:"remove"});

  const prep=await resizeForInference(file);
  const image=await RawImage.fromBlob(prep.sourceBlob);

  // This is the task BRIA explicitly documents for RMBG-1.4 in Transformers.js.
  const result=await segmenter(image);
  const mask=await getForegroundMask(result,prep.width,prep.height);

  return applyMaskToOriginal(prep.bitmap,mask);
}

self.onmessage=async e=>{
  const {type,id,file}=e.data||{};

  if(type==="warm"){
    try{
      const hasWebGPU=typeof navigator!=="undefined" && !!navigator.gpu;
      await getSegmenter(id);
      self.postMessage({
        type:"ready",
        id,
        acceleration:hasWebGPU?"webgpu":"wasm"
      });
    }catch(error){
      console.error("Backshot Engine warmup failed",error);
      // Reset so pressing Remove can retry instead of being stuck with a rejected promise.
      segmenterPromise=null;
      self.postMessage({
        type:"error",
        id,
        error:error?.message||String(error)
      });
    }
    return;
  }

  if(type!=="remove"||!file)return;

  try{
    const blob=await removeBackgroundFast(file,id);
    self.postMessage({type:"done",id,blob});
  }catch(error){
    console.error("Backshot Engine removal failed",error);
    // If model initialization failed, allow the next attempt to reinitialize.
    if(!segmenterPromise)segmenterPromise=null;
    self.postMessage({
      type:"error",
      id,
      error:error?.message||String(error)
    });
  }
};
