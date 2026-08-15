export function analyzeMask(alpha,width,height,threshold=128){
  let area=0,minX=width,maxX=-1,minY=height,maxY=-1;
  for(let i=0;i<alpha.length;i++){
    if(alpha[i]<threshold)continue;
    area++;const x=i%width,y=Math.floor(i/width);
    minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
  }
  return {area,ratio:area/Math.max(1,width*height),width:maxX>=minX?maxX-minX+1:0,height:maxY>=minY?maxY-minY+1:0};
}

export function cleanupIsSafe(protectedAlpha,cleanedAlpha,width,height){
  const before=analyzeMask(protectedAlpha,width,height),after=analyzeMask(cleanedAlpha,width,height);
  if(!before.area)return true;
  return after.area/before.area>=0.97 &&
    (!before.width||after.width/before.width>=0.95) &&
    (!before.height||after.height/before.height>=0.95);
}

export function chooseSafeCleanup(protectedAlpha,cleanedAlpha,width,height){
  return cleanupIsSafe(protectedAlpha,cleanedAlpha,width,height)
    ? cleanedAlpha
    : new Uint8Array(protectedAlpha);
}

export function insideBrushFootprint(x,y,cx,cy,radius){
  return (x-cx)**2+(y-cy)**2<=radius**2;
}
