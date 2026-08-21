import test from "node:test";
import assert from "node:assert/strict";
import {analyzeMask,chooseSafeCleanup,insideBrushFootprint,recoverForegroundChannel} from "../src/mask-safety.js";

test("rolls back sudden foreground loss",()=>{
  const protectedMask=new Uint8Array(100).fill(255),cleaned=new Uint8Array(protectedMask);
  cleaned.fill(0,0,20);
  assert.deepEqual([...chooseSafeCleanup(protectedMask,cleaned,10,10)],[...protectedMask]);
});

test("accepts tiny disconnected cleanup without bbox shrink",()=>{
  const protectedMask=new Uint8Array(100).fill(255),cleaned=new Uint8Array(protectedMask);
  cleaned[44]=0;
  assert.equal(chooseSafeCleanup(protectedMask,cleaned,10,10),cleaned);
});

test("reports foreground dimensions at image edges",()=>{
  const mask=new Uint8Array(24);for(let y=0;y<4;y++)for(let x=0;x<3;x++)mask[y*6+x]=255;
  assert.deepEqual(analyzeMask(mask,6,4),{area:12,ratio:.5,width:3,height:4});
});

test("assisted edits cannot escape their local brush footprint",()=>{
  assert.equal(insideBrushFootprint(15,10,10,10,5),true);
  assert.equal(insideBrushFootprint(16,10,10,10,5),false);
  assert.equal(insideBrushFootprint(10,16,10,10,5),false);
});

test("matte decontamination reconstructs foreground colour from background spill",()=>{
  const alpha=128;
  assert.ok(Math.abs(recoverForegroundChannel(30,20,alpha)-40)<=1);
  assert.ok(Math.abs(recoverForegroundChannel(100,140,alpha)-60)<=1);
  assert.ok(Math.abs(recoverForegroundChannel(55,30,alpha)-80)<=1);
});

test("accepts cumulative speck removal while product bounds stay intact",()=>{
  const protectedMask=new Uint8Array(100).fill(255),cleaned=new Uint8Array(protectedMask);
  for(const i of [11,13,15,17,22,24,26,28,31,33,35,37])cleaned[i]=0;
  assert.equal(chooseSafeCleanup(protectedMask,cleaned,10,10),cleaned);
});
