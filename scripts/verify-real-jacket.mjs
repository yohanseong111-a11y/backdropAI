/**
 * Run the live RMBG + refine path on the real two-tone jacket photo
 * (cyan body, navy shoulders/hood, green shag). Synthetic graphics are not
 * enough — this is the photo that was eating navy.
 */
import {createServer} from "node:http";
import {readFile,writeFile} from "node:fs/promises";
import {extname,join} from "node:path";
import puppeteer from "puppeteer-core";

const root=join(process.cwd(),"dist");
const photoPath=process.argv[2]||join(process.cwd(),"tests/fixtures/jacket-grass-closeup.png");
const port=4178;
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

await page.waitForSelector("#workspace:not(.hidden)");
await page.waitForSelector(".photo-card");
await page.waitForSelector("#removeAllBtn:not([disabled])");
await page.click("#removeAllBtn");
await page.waitForFunction(()=>document.querySelector(".status.done")||document.querySelector(".status.failed"),{timeout:170000});
const status=await page.$eval(".status",el=>el.className);

const quality=await page.evaluate(async(originalBytes)=>{
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

  const classify=(r,g,b)=>{
    const max=Math.max(r,g,b);
    const min=Math.min(r,g,b);
    const greenLead=g-Math.max(r,b);
    if(greenLead>18 && g>55)return "carpet";
    if(b>r+35 && g>r+15 && b>90 && r<140)return "cyan";
    if(max<110 && b+8>=g && r<g+18 && greenLead<12 && (b>r-6 || max<55))return "navy";
    if(max-min<18 && max<70)return "navy";
    return "other";
  };

  const counts={cyan:{n:0,kept:0,semi:0},navy:{n:0,kept:0,semi:0},carpet:{n:0,kept:0,semi:0},other:{n:0,kept:0,semi:0}};
  const leftoverGreen={n:0};
  const step=2;
  for(let y=0;y<height;y+=step){
    for(let x=0;x<width;x+=step){
      const o=(y*width+x)*4;
      const kind=classify(original[o],original[o+1],original[o+2]);
      const a=result[o+3];
      counts[kind].n++;
      if(a>180)counts[kind].kept++;
      else if(a>40)counts[kind].semi++;
      if(a>180 && kind==="carpet")leftoverGreen.n++;
    }
  }

  const rate=kind=>({
    kept:counts[kind].n?counts[kind].kept/counts[kind].n:0,
    semi:counts[kind].n?counts[kind].semi/counts[kind].n:0,
    n:counts[kind].n
  });
  const cyan=rate("cyan");
  const navy=rate("navy");
  const carpet=rate("carpet");

  // Region boxes as a second opinion (fractions of the close-up crop).
  const scoreBox=(box)=>{
    let kept=0,count=0,greenKept=0;
    for(let y=Math.round(box.y0*height);y<Math.round(box.y1*height);y+=2){
      for(let x=Math.round(box.x0*width);x<Math.round(box.x1*width);x+=2){
        count++;
        const o=(y*width+x)*4;
        if(result[o+3]>80){
          kept++;
          if(classify(original[o],original[o+1],original[o+2])==="carpet")greenKept++;
        }
      }
    }
    return {kept:count?kept/count:0,greenKept:count?greenKept/count:0,count};
  };
  const regions={
    cyanBody:scoreBox({x0:0.28,y0:0.38,x1:0.72,y1:0.78}),
    collar:scoreBox({x0:0.30,y0:0.06,x1:0.70,y1:0.24}),
    leftShoulder:scoreBox({x0:0.06,y0:0.10,x1:0.28,y1:0.30}),
    rightShoulder:scoreBox({x0:0.72,y0:0.10,x1:0.94,y1:0.30}),
    topLeftCarpet:scoreBox({x0:0.00,y0:0.00,x1:0.12,y1:0.10}),
    topRightCarpet:scoreBox({x0:0.88,y0:0.00,x1:1.00,y1:0.10})
  };

  const png=await new Promise(resolve=>canvas.toBlob(blob=>blob.arrayBuffer().then(resolve),"image/png"));
  return {
    width,height,
    cyan,navy,carpet,
    leftoverGreen:leftoverGreen.n,
    regions,
    ok:
      cyan.kept>0.88 &&
      navy.kept>0.78 &&
      carpet.kept<0.18 &&
      regions.cyanBody.kept>0.9 &&
      regions.collar.kept>0.7 &&
      regions.leftShoulder.kept>0.65 &&
      regions.rightShoulder.kept>0.65 &&
      regions.topLeftCarpet.kept<0.25 &&
      regions.topRightCarpet.kept<0.25,
    png:Array.from(new Uint8Array(png))
  };
},Array.from(photo));

await page.screenshot({path:"/tmp/real-jacket-verify.png",fullPage:true});
if(quality.png){
  await writeFile("/tmp/real-jacket-cutout.png",Buffer.from(quality.png));
  delete quality.png;
}
await browser.close();
server.close();

const result={status,quality,logs:logs.slice(-24)};
console.log(JSON.stringify(result,null,2));
if(!quality.ok||!status.includes("done")){
  console.error("REAL_JACKET_VERIFY_FAILED");
  process.exit(1);
}
console.log("REAL_JACKET_VERIFY_OK");
