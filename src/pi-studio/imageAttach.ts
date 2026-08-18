export interface AttachedImage {
  data: string;
  mimeType: string;
}

const MAX_EDGE = 1600;
const MAX_KEEP_BYTES = 1_500_000;
const JPEG_QUALITY = 0.85;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not read image'));
    img.src = url;
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('could not read file'));
    r.readAsDataURL(file);
  });
}

export async function processImageFile(file: File): Promise<AttachedImage> {
  const dataUrl = await readAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('not a valid image');
  if (w <= MAX_EDGE && h <= MAX_EDGE && file.size <= MAX_KEEP_BYTES) {
    const comma = dataUrl.indexOf(',');
    return { data: dataUrl.slice(comma + 1), mimeType: file.type || 'image/png' };
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const comma = out.indexOf(',');
  return { data: out.slice(comma + 1), mimeType: 'image/jpeg' };
}

export function dataUrlOf(im: AttachedImage): string {
  return `data:${im.mimeType};base64,${im.data}`;
}
