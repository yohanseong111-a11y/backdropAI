import { pipeline, RawImage } from "@huggingface/transformers";

let removerPromise=null;
let removerReady=false;

function getRemover(id){
  if(removerPromise)return removerPromise;

  const hasWebGPU=typeof navigator!=="undefined" && !!navigator.gpu;
  removerPromise=pipeline("background-removal","briaai/RMBG-1.4",{
    device:hasWebGPU?"webgpu":"wasm",
    dtype:hasWebGPU?"fp16":"q8",
    progress_callback(info){
      if(Number.isFinite(info?.progress)){
        self.postMessage({type:"progress",id,stage:"load",progress:Number(info.progress)});
      }
    }
  }).then(model=>{
    removerReady=true;
    return model;
  });

  return removerPromise;
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
    // Laptop/desktop WebGPU: enough resolution for clothing edges without wasting compute.
    maxSide=mem>=8?896:768;
  }else if(isiPhone||isiPad){
    // Safari/iOS path: prioritize responsiveness and memory safety.
    maxSide=576;
  }else{
    maxSide=mem<=4?512:640;
  }
  const scale=Math.min(1,maxSide/Math.max(original.width,original.height));
  const width=Math.max(1,Math.round(original.width*scale));
  const height=Math.max(1,Math.round(original.height*scale));

  if(scale===1){
    return {bitmap:original,width,height,originalWidth:original.width,originalHeight:original.height,sourceBlob:file};
  }

  // Ask the browser decoder to resize directly. This avoids an extra full-size canvas draw
  // before inference and is quicker on large phone photos.
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
    return {bitmap:original,width,height,originalWidth:original.width,originalHeight:original.height,sourceBlob};
  }

  const canvas=new OffscreenCanvas(width,height);
  const ctx=canvas.getContext("2d",{alpha:true});
  ctx.drawImage(small,0,0,width,height);
  const sourceBlob=await canvas.convertToBlob({type:"image/webp",quality:.92});
  small.close?.();

  return {bitmap:original,width,height,originalWidth:original.width,originalHeight:original.height,sourceBlob};
}

async function applyMaskToOriginal(originalBitmap,cutoutRaw){
  const ow=originalBitmap.width,oh=originalBitmap.height;

  // Draw the model result onto an inference-size canvas and extract just its alpha.
  const mw=cutoutRaw.width,mh=cutoutRaw.height;
  const maskCanvas=new OffscreenCanvas(mw,mh);
  const maskCtx=maskCanvas.getContext("2d",{willReadFrequently:true});
  const maskImageData=new ImageData(new Uint8ClampedArray(cutoutRaw.data),mw,mh);
  maskCtx.putImageData(maskImageData,0,0);

  // Scale the alpha matte back to the original dimensions.
  const scaledMaskCanvas=new OffscreenCanvas(ow,oh);
  const scaledMaskCtx=scaledMaskCanvas.getContext("2d",{willReadFrequently:true});
  scaledMaskCtx.imageSmoothingEnabled=true;
  scaledMaskCtx.imageSmoothingQuality="high";
  scaledMaskCtx.drawImage(maskCanvas,0,0,ow,oh);
  const mask=scaledMaskCtx.getImageData(0,0,ow,oh).data;

  // Preserve the original full-resolution RGB. Only alpha comes from the AI.
  const outputCanvas=new OffscreenCanvas(ow,oh);
  const outCtx=outputCanvas.getContext("2d",{willReadFrequently:true});
  outCtx.drawImage(originalBitmap,0,0);
  const out=outCtx.getImageData(0,0,ow,oh);
  const od=out.data;

  for(let i=0;i<ow*oh;i++){
    od[i*4+3]=mask[i*4+3];
  }

  outCtx.putImageData(out,0,0);
  return outputCanvas.convertToBlob({type:"image/png"});
}

async function removeBackgroundFast(file,id){
  const remover=await getRemover(id);
  self.postMessage({type:"progress",id,stage:"remove"});

  const prep=await resizeForInference(file);
  const image=await RawImage.fromBlob(prep.sourceBlob);
  const output=await remover(image);
  const cutout=output[0];

  // If we did not resize, return directly.
  if(prep.width===prep.originalWidth && prep.height===prep.originalHeight){
    return cutout.toBlob();
  }

  return applyMaskToOriginal(prep.bitmap,cutout);
}

self.onmessage=async e=>{
  const {type,id,file}=e.data||{};

  if(type==="warm"){
    try{
      const hasWebGPU=typeof navigator!=="undefined" && !!navigator.gpu;
      await getRemover(id);
      self.postMessage({type:"ready",id,acceleration:hasWebGPU?"webgpu":"wasm"});
    }catch(error){
      self.postMessage({type:"error",id,error:error?.message||String(error)});
    }
    return;
  }

  if(type!=="remove"||!file)return;

  try{
    const blob=await removeBackgroundFast(file,id);
    self.postMessage({type:"done",id,blob});
  }catch(error){
    console.error(error);
    self.postMessage({type:"error",id,error:error?.message||String(error)});
  }
};
