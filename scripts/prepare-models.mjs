import {createHash} from "node:crypto";
import {createReadStream,createWriteStream} from "node:fs";
import {mkdir,rename,rm,stat} from "node:fs/promises";
import {pipeline} from "node:stream/promises";
import {Readable} from "node:stream";
import path from "node:path";

if(process.env.CI!=="true"&&process.env.BACKSHOTAI_PREPARE_MODELS!=="1"){
  console.log("Skipping deployed AI models for local build.");
  process.exit(0);
}

const revision="5d9eda8f5384c94a951fcb225b34922bc03536dc";
const directory=path.resolve("public/models/briaai/RMBG-1.4/onnx");
const files=[
  {name:"model_quantized.onnx",sha256:"a6648479275dfd0ede0f3a8abc20aa5c437b394681b05e5af6d268250aaf40f3"},
  {name:"model_fp16.onnx",sha256:"9fdfdb41866d872e0acf4a010c35c1a8547bf0eebe0d1544406bbf1c824cb59d"}
];

await mkdir(directory,{recursive:true});

async function digest(file){
  const hash=createHash("sha256");
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest("hex");
}

for(const model of files){
  const target=path.join(directory,model.name),partial=`${target}.part`;
  try{
    if((await stat(target)).size>1024&&await digest(target)===model.sha256){
      console.log(`${model.name} already verified.`);continue;
    }
  }catch{}

  await rm(partial,{force:true});
  const url=`https://huggingface.co/briaai/RMBG-1.4/resolve/${revision}/onnx/${model.name}?download=true`;
  console.log(`Downloading ${model.name} for same-origin GitHub Pages use…`);
  const response=await fetch(url,{redirect:"follow"});
  if(!response.ok||!response.body)throw new Error(`Model download failed (${response.status}) for ${model.name}`);
  await pipeline(Readable.fromWeb(response.body),createWriteStream(partial));
  const actual=await digest(partial);
  if(actual!==model.sha256){await rm(partial,{force:true});throw new Error(`Checksum failed for ${model.name}`);}
  await rm(target,{force:true});
  await rename(partial,target);
}
