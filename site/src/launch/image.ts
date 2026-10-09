// Coin images live on-chain (in the launch's Image log), so they are small: 256x256, at most 24 KB.
import { bytesToHex, hexToBytes, type Hex } from 'viem';

export const MAX_IMAGE = 24_576;

export function imageMime(b: Uint8Array): string | null {
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'image/webp';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  return null; // anything else (svg, html, …) is never rendered
}

const urls = new Map<string, string>();
/** Object URL for on-chain image bytes (raster formats only). */
export function imageUrl(hex: Hex | null | undefined): string | null {
  if (!hex || hex === '0x') return null;
  const hit = urls.get(hex);
  if (hit) return hit;
  const b = hexToBytes(hex);
  const mime = imageMime(b);
  if (!mime) return null;
  const u = URL.createObjectURL(new Blob([b as BlobPart], { type: mime }));
  urls.set(hex, u);
  return u;
}

/** Center-crops and re-encodes an uploaded file to a square image of at most MAX_IMAGE bytes. */
export async function encodeImage(file: File): Promise<{ hex: Hex; url: string; bytes: number }> {
  if (!/^image\/(png|jpe?g|webp|gif|avif)$/.test(file.type)) throw new Error('Use a PNG, JPG, WEBP or GIF.');
  if (file.size > 15 * 1024 * 1024) throw new Error('That file is over 15 MB.');
  const bmp = await createImageBitmap(file);
  for (const size of [256, 224, 192, 160, 128]) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const s = Math.min(bmp.width, bmp.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
    for (const type of ['image/webp', 'image/jpeg']) {
      for (const q of [0.9, 0.8, 0.7, 0.6, 0.5]) {
        const blob = await new Promise<Blob | null>(r => c.toBlob(r, type, q));
        if (!blob || blob.type !== type) break; // encoder not supported: try the next type
        if (blob.size <= MAX_IMAGE) {
          const b = new Uint8Array(await blob.arrayBuffer());
          return { hex: bytesToHex(b), url: URL.createObjectURL(blob), bytes: b.length };
        }
      }
    }
  }
  throw new Error('Could not get the image under 24 KB. Try a simpler picture.');
}
