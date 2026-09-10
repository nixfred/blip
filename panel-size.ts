// Rebuild: bun build panel-size.ts --target browser --format esm --outfile PanelSize.mjs
export interface PanelSize { width: number; height: number }
export function parseSize(value: unknown): PanelSize | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const {width,height} = value as PanelSize;
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1
    && width <= 16384 && height <= 16384 ? {width,height} : null;
}
export function fitSize(width:number,height:number,screenWidth:number,screenHeight:number,availableWidth:number,availableHeight:number): PanelSize {
  const maxWidth = Math.max(1, Math.floor(Math.min(500, screenWidth || width, availableWidth || width)));
  const maxHeight = Math.max(1, Math.floor(Math.min((screenHeight || height) * .8, availableHeight || height)));
  return {
    width: Math.round(Math.min(maxWidth, Math.max(Math.min(280,maxWidth),width))),
    height: Math.round(Math.min(maxHeight, Math.max(Math.min(240,maxHeight),height))),
  };
}
