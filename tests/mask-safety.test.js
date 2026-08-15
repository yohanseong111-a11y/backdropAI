import test from "node:test";
import assert from "node:assert/strict";
import {analyzeMask,chooseSafeCleanup,insideBrushFootprint,isHighConfidenceResidual,isNeutralBorderResidual} from "../src/mask-safety.js";

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

test("flags grass and white floor residuals without flagging jacket colours",()=>{
  assert.equal(isHighConfidenceResidual(32,108,54),true);
  assert.equal(isHighConfidenceResidual(228,231,226),true);
  assert.equal(isHighConfidenceResidual(28,48,67),false);
  assert.equal(isHighConfidenceResidual(0,168,224),false);
  assert.equal(isHighConfidenceResidual(240,118,35),false);
});

test("neutral border cleanup accepts floors but rejects dark navy jacket panels",()=>{
  assert.equal(isNeutralBorderResidual(158,155,149),true);
  assert.equal(isNeutralBorderResidual(224,226,220),true);
  assert.equal(isNeutralBorderResidual(35,51,68),false);
  assert.equal(isNeutralBorderResidual(61,70,79),false);
  assert.equal(isNeutralBorderResidual(21,153,205),false);
});

test("accepts cumulative speck removal while product bounds stay intact",()=>{
  const protectedMask=new Uint8Array(100).fill(255),cleaned=new Uint8Array(protectedMask);
  for(const i of [11,13,15,17,22,24,26,28,31,33,35,37])cleaned[i]=0;
  assert.equal(chooseSafeCleanup(protectedMask,cleaned,10,10),cleaned);
});
