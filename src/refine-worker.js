import {refineForegroundAlpha} from "./mask-refine.js";

self.onmessage=async event=>{
  const {id,rgbBuffer,alphaBuffer,width,height,options}=event.data||{};
  if(!rgbBuffer||!alphaBuffer||!width||!height){
    self.postMessage({id,type:"error",error:"Mask refinement received an empty image."});
    return;
  }
  try{
    const rgb=new Uint8ClampedArray(rgbBuffer);
    const alpha=new Uint8Array(alphaBuffer);
    const {alpha:refined,report}=await refineForegroundAlpha({rgb,alpha,width,height,options});
    self.postMessage({id,type:"done",alphaBuffer:refined.buffer,report},[refined.buffer]);
  }catch(error){
    self.postMessage({id,type:"error",error:error?.message||String(error)});
  }
};
