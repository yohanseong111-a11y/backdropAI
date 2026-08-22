/**
 * Full live proof: real jacket cutout, Assist only changes the tapped patch,
 * and the page does not throw. Run after `npm run build`.
 */
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {extname,join} from "node:path";
import puppeteer from "puppeteer-core";

const root=join(process.cwd(),"dist");
const photoPath=join(process.cwd(),"tests/fixtures/jacket-grass-closeup.png");
const port=4179;
const types={
  ".html":"text/html",".js":"text/javascript",".css":"text/css",
  ".png":"image/png",".wasm":"application/wasm",".json":"application/json",
  ".svg":"image/svg+xml",".onnx":"application/octet-stream",".ico":"image/x-icon",
  ".webmanifest":"application/manifest+json"
};

const IGNORE=/Unknown model class|content-length|beforeinstallprompt|apple-mobile-web-app-capable/;

const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://127.0.0.1:${port}`);
    const file=url.pathname==="/"? "/index.html":url.pathname;
    const body=await readFile(join(root,decodeURIComponent(file)));
    res.writeHead(200,{"content-type":types[extname(file)]||"application/octet-stream"});
    res.end(body);
  }catch{
    res.writeHead(404);res.end("missing");
  }
});
await new Promise(resolve=>server.listen(port,resolve));

const browser=await puppeteer.launch({
  executablePath:"/usr/local/bin/google-chrome",
  headless:true,
  args:["--no-sandbox","--disable-gpu","--use-gl=swiftshader"]
});
const page=await browser.newPage();
page.setDefaultTimeout(180000);
const logs=[];
const hardErrors=[];
page.on("console",msg=>{
  const line=`${msg.type()}: ${msg.text()}`;
  logs.push(line);
  if(msg.type()==="error"&&!IGNORE.test(line))hardErrors.push(line);
});
page.on("pageerror",err=>{
  hardErrors.push(`pageerror: ${err.message}`);
  logs.push(`pageerror: ${err.message}`);
});

await page.setViewport({width:1400,height:980});
await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:"networkidle0"});

const photo=await readFile(photoPath);
await page.waitForSelector("#photoInput");
await page.evaluateHandle(async(bytes)=>{
  const blob=new Blob([new Uint8Array(bytes)],{type:"image/png"});
  const transfer=new DataTransfer();
  transfer.items.add(new File([blob],"jacket-grass-closeup.png",{type:"image/png"}));
  const input=document.querySelector("#photoInput");
  input.files=transfer.files;
  input.dispatchEvent(new Event("change",{bubbles:true}));
},Array.from(photo));

await page.waitForSelector("#removeAllBtn:not([disabled])");
await page.click("#removeAllBtn");
await page.waitForFunction(()=>document.querySelector(".status.done")||document.querySelector(".status.failed"),{timeout:170000});
const status=await page.$eval(".status",el=>el.className);

const classify=(r,g,b)=>{
  const max=Math.max(r,g,b);
  const greenLead=g-Math.max(r,b);
  if(greenLead>18&&g>55)return "carpet";
  if(b>r+35&&g>r+15&&b>90&&r<140)return "cyan";
  if(max<110&&b+8>=g&&r<g+18&&greenLead<12)return "navy";
  if(max<70)return "navy";
  return "other";
};

const cutout=await page.evaluate(async(originalBytes,classifySrc)=>{
  const classify=eval(`(${classifySrc})`);
  const canvas=document.querySelector(".preview-canvas");
  if(!canvas)return {ok:false,reason:"no preview canvas"};
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  const {width,height}=canvas;
  const result=ctx.getImageData(0,0,width,height).data;
  const img=await createImageBitmap(new Blob([new Uint8Array(originalBytes)],{type:"image/png"}));
  const src=document.createElement("canvas");
  src.width=width;src.height=height;
  const sctx=src.getContext("2d",{willReadFrequently:true});
  sctx.drawImage(img,0,0,width,height);
  const original=sctx.getImageData(0,0,width,height).data;
  const counts={cyan:{n:0,kept:0},navy:{n:0,kept:0},carpet:{n:0,kept:0}};
  for(let y=0;y<height;y+=2){
    for(let x=0;x<width;x+=2){
      const o=(y*width+x)*4;
      const kind=classify(original[o],original[o+1],original[o+2]);
      if(!counts[kind])continue;
      counts[kind].n++;
      if(result[o+3]>180)counts[kind].kept++;
    }
  }
  const rate=kind=>counts[kind].n?counts[kind].kept/counts[kind].n:0;
  return {
    width,height,
    cyan:rate("cyan"),navy:rate("navy"),carpet:rate("carpet"),
    ok:rate("cyan")>0.88&&rate("navy")>0.78&&rate("carpet")<0.18
  };
},Array.from(photo),classify.toString());

await page.click(".edit-cutout");
await page.waitForSelector("#cutoutModal:not(.hidden)");
await page.waitForSelector("#editorCanvas");

const loupe=await page.evaluate(()=>{
  const canvas=document.querySelector("#editorCanvas");
  const rect=canvas.getBoundingClientRect();
  const clientX=rect.left+rect.width*0.5;
  const clientY=rect.top+rect.height*0.5;
  canvas.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,cancelable:true,pointerId:1,clientX,clientY}));
  const el=document.querySelector("#editorLoupe");
  return {visible:!!el&&!el.hidden,hasCanvas:!!document.querySelector("#loupeCanvas")};
});

await page.click("#restoreTool");

const clickEditor=async(fx,fy)=>{
  await page.evaluate((xFrac,yFrac)=>{
    const canvas=document.querySelector("#editorCanvas");
    const rect=canvas.getBoundingClientRect();
    const clientX=rect.left+rect.width*xFrac;
    const clientY=rect.top+rect.height*yFrac;
    const opts={bubbles:true,cancelable:true,pointerId:1,clientX,clientY,button:0};
    canvas.dispatchEvent(new PointerEvent("pointerdown",opts));
    canvas.dispatchEvent(new PointerEvent("pointerup",opts));
  },fx,fy);
};

const scoreEditor=async(box)=>page.evaluate(region=>{
  const canvas=document.querySelector("#editorCanvas");
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  const {width,height}=canvas;
  const data=ctx.getImageData(0,0,width,height).data;
  let kept=0,count=0;
  const x0=Math.round(region.x0*width),x1=Math.round(region.x1*width);
  const y0=Math.round(region.y0*height),y1=Math.round(region.y1*height);
  for(let y=y0;y<y1;y+=2){
    for(let x=x0;x<x1;x+=2){
      count++;
      if(data[(y*width+x)*4+3]>80)kept++;
    }
  }
  return count?kept/count:0;
},box);

const beforeLeft=await scoreEditor({x0:0,y0:0,x1:0.12,y1:0.10});
const beforeRight=await scoreEditor({x0:0.88,y0:0,x1:1,y1:0.10});
await clickEditor(0.06,0.06);
const afterRestoreLeft=await scoreEditor({x0:0,y0:0,x1:0.12,y1:0.10});
const afterRestoreRight=await scoreEditor({x0:0.88,y0:0,x1:1,y1:0.10});

await page.click("#eraseTool");
const liveErase=await page.evaluate(()=>{
  const canvas=document.querySelector("#editorCanvas");
  const rect=canvas.getBoundingClientRect();
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  const {width,height}=canvas;
  const before=ctx.getImageData(0,0,width,height).data;
  const clientX=rect.left+rect.width*0.50;
  const clientY=rect.top+rect.height*0.55;
  const opts={bubbles:true,cancelable:true,pointerId:1,clientX,clientY,button:0};
  canvas.dispatchEvent(new PointerEvent("pointerdown",opts));
  canvas.dispatchEvent(new PointerEvent("pointermove",{...opts,clientX:clientX+8,clientY:clientY+8}));
  const mid=ctx.getImageData(0,0,width,height).data;
  let changed=0;
  for(let i=3;i<before.length;i+=4) if(mid[i]<before[i]) changed++;
  canvas.dispatchEvent(new PointerEvent("pointerup",opts));
  return {changed,ok:changed>80};
});
const afterEraseLeft=await scoreEditor({x0:0,y0:0,x1:0.12,y1:0.10});
const afterEraseRight=await scoreEditor({x0:0.88,y0:0,x1:1,y1:0.10});
const afterEraseBody=await scoreEditor({x0:0.40,y0:0.48,x1:0.60,y1:0.68});

await page.screenshot({path:"/tmp/verify-app.png",fullPage:true});
await browser.close();
server.close();

const assist={
  beforeLeft,beforeRight,afterRestoreLeft,afterRestoreRight,afterEraseLeft,afterEraseRight,afterEraseBody,
  restoreOnlyOne:afterRestoreLeft>0.45&&afterRestoreRight<0.2,
  eraseLeavesOtherGreen:afterEraseRight<0.2&&afterEraseLeft>afterRestoreLeft-0.15,
  eraseHitsJacket:afterEraseBody<0.55,
  liveErase:liveErase.ok,
  loupe:loupe.visible&&loupe.hasCanvas
};
const ok=status.includes("done")&&cutout.ok&&assist.restoreOnlyOne&&assist.eraseLeavesOtherGreen&&assist.eraseHitsJacket&&assist.liveErase&&assist.loupe&&hardErrors.length===0;
const result={ok,status,cutout,assist,loupe,liveErase,hardErrors,logs:logs.slice(-24)};
console.log(JSON.stringify(result,null,2));
if(!ok){
  console.error("APP_VERIFY_FAILED");
  process.exit(1);
}
console.log("APP_VERIFY_OK");
