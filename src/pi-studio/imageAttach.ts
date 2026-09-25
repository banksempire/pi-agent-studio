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

function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? '' : dataUrl.slice(comma + 1);
}

export function sniffedImageMime(base64: string): string | null {
  let head: string;
  try {
    head = atob(base64.slice(0, 24));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(head.length);
  for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i);
  const startsWith = (offset: number, marker: string) => {
    for (let i = 0; i < marker.length; i++) {
      if (bytes[offset + i] !== marker.charCodeAt(i)) return false;
    }
    return true;
  };
  if (startsWith(0, '\x89PNG')) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (startsWith(0, 'GIF8')) return 'image/gif';
  if (startsWith(0, 'RIFF') && startsWith(8, 'WEBP')) return 'image/webp';
  if (startsWith(0, 'BM')) return 'image/bmp';
  return null;
}

export async function processImageFile(file: File): Promise<AttachedImage> {
  const dataUrl = await readAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('not a valid image');
  const sniffed = sniffedImageMime(base64Of(dataUrl));
  if (
    (sniffed === 'image/png' || sniffed === 'image/jpeg') &&
    w <= MAX_EDGE &&
    h <= MAX_EDGE &&
    file.size <= MAX_KEEP_BYTES
  ) {
    return { data: base64Of(dataUrl), mimeType: sniffed };
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
  return { data: base64Of(out), mimeType: 'image/jpeg' };
}

export function dataUrlOf(im: AttachedImage): string {
  return `data:${im.mimeType};base64,${im.data}`;
}
