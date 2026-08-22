/**
 * Browser proof that the scan line actually moves and that a cyan jacket on
 * green carpet is kept. Run after `npm run build`.
 */
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {extname,join} from "node:path";
import puppeteer from "puppeteer-core";

const root=join(process.cwd(),"dist");
const port=4177;
const types={
  ".html":"text/html",".js":"text/javascript",".css":"text/css",
  ".png":"image/png",".wasm":"application/wasm",".json":"application/json",
  ".svg":"image/svg+xml",".onnx":"application/octet-stream",".ico":"image/x-icon"
};

const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://127.0.0.1:${port}`);
    let file=url.pathname==="/"? "/index.html":url.pathname;
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
page.on("console",msg=>logs.push(`${msg.type()}: ${msg.text()}`));
page.on("pageerror",err=>logs.push(`pageerror: ${err.message}`));

await page.setViewport({width:1280,height:900});
await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:"networkidle0"});

const jacket=await page.evaluate(async()=>{
  const width=720,height=960;
  const canvas=document.createElement("canvas");
  canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext("2d");
  for(let y=0;y<height;y++){
    for(let x=0;x<width;x+=2){
      const n=((x*13+y*7)%17)-8;
      ctx.fillStyle=`rgb(${36+n},${110+n},${40+n*0.5})`;
      ctx.fillRect(x,y,2,2);
    }
  }
  ctx.fillStyle="rgb(10,168,226)";
  ctx.beginPath();
  ctx.moveTo(70,140);ctx.lineTo(650,120);ctx.lineTo(690,880);ctx.lineTo(40,900);ctx.closePath();
  ctx.fill();
  ctx.fillStyle="rgb(28,28,32)";
  ctx.beginPath();
  ctx.moveTo(70,140);ctx.lineTo(650,120);ctx.lineTo(620,280);ctx.lineTo(100,300);ctx.closePath();
  ctx.fill();
  ctx.fillStyle="rgb(18,18,20)";
  ctx.fillRect(348,200,24,620);
  ctx.fillStyle="rgb(200,200,204)";
  ctx.fillRect(354,430,12,40);
  ctx.fillStyle="rgb(214,210,204)";
  ctx.fillRect(620,180,100,420);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
  return {width,height,buffer:Array.from(new Uint8Array(await blob.arrayBuffer()))};
});

await page.waitForSelector("#photoInput");
await page.evaluateHandle(async(bytes)=>{
  const blob=new Blob([new Uint8Array(bytes)],{type:"image/png"});
  const transfer=new DataTransfer();
  transfer.items.add(new File([blob],"jacket.png",{type:"image/png"}));
  const input=document.querySelector("#photoInput");
  input.files=transfer.files;
  input.dispatchEvent(new Event("change",{bubbles:true}));
},jacket.buffer);

await page.waitForSelector("#workspace:not(.hidden)");
await page.waitForSelector(".photo-card");
await page.waitForSelector("#removeAllBtn:not([disabled])");
await page.click("#removeAllBtn");
await page.waitForSelector(".preview-wrap.scanning");

const scan=await page.evaluate(async()=>{
  const track=document.querySelector(".scan-beam");
  if(!track)return {ok:false,reason:"no scan-beam"};
  const read=()=>{
    const style=getComputedStyle(track);
    const matrix=new DOMMatrixReadOnly(style.transform);
    return {y:matrix.m42,height:track.getBoundingClientRect().height};
  };
  const samples=[];
  for(let i=0;i<6;i++){
    samples.push(read().y);
    await new Promise(resolve=>setTimeout(resolve,280));
  }
  const height=read().height;
  let down=false,up=false;
  for(let i=1;i<samples.length;i++){
    if(samples[i]-samples[i-1]>10)down=true;
    if(samples[i-1]-samples[i]>10)up=true;
  }
  const travel=Math.max(...samples)-Math.min(...samples);
  return {ok:down&&up&&travel>height*0.25,down,up,travel,samples,height};
});

await page.waitForFunction(()=>document.querySelector(".status.done")||document.querySelector(".status.failed"),{timeout:170000});
const status=await page.$eval(".status",el=>el.className);

const quality=await page.evaluate(async()=>{
  const canvas=document.querySelector(".preview-canvas");
  if(!canvas)return {ok:false,reason:"no preview canvas"};
  const ctx=canvas.getContext("2d");
  const {width,height}=canvas;
  const data=ctx.getImageData(0,0,width,height).data;
  const jacket={x0:Math.round(width*0.22),x1:Math.round(width*0.78),y0:Math.round(height*0.32),y1:Math.round(height*0.82)};
  const collar={x0:Math.round(width*0.28),x1:Math.round(width*0.72),y0:Math.round(height*0.16),y1:Math.round(height*0.27)};
  const carpet={x0:2,x1:Math.round(width*0.12),y0:2,y1:Math.round(height*0.12)};
  const score=(box)=>{
    let kept=0,count=0;
    for(let y=box.y0;y<box.y1;y+=2){
      for(let x=box.x0;x<box.x1;x+=2){
        count++;
        if(data[(y*width+x)*4+3]>80)kept++;
      }
    }
    return count?kept/count:0;
  };
  const jacketKept=score(jacket);
  const collarKept=score(collar);
  const carpetKept=score(carpet);
  return {ok:jacketKept>0.88&&collarKept>0.75&&carpetKept<0.2,jacketKept,collarKept,carpetKept,width,height};
});

await page.screenshot({path:"/tmp/backshot-verify.png",fullPage:true});
await browser.close();
server.close();

const result={scan,status,quality,logs:logs.slice(-20)};
console.log(JSON.stringify(result,null,2));
if(!scan.ok||!quality.ok||!status.includes("done")){
  console.error("VERIFY_FAILED");
  process.exit(1);
}
console.log("VERIFY_OK");
