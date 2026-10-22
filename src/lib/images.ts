const MAX_DIM = 1600;
const MAX_BYTES = 1_400_000; // server limit is 1.5 MB

/** Downscale and re-encode in the browser: faster uploads, smaller sites, lower storage cost. GIFs pass through. */
export async function prepareImage(file: File): Promise<Blob> {
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) throw new Error('Please choose a PNG, JPG, WebP or GIF image.');
  if (file.type === 'image/gif') {
    if (file.size > MAX_BYTES) throw new Error('That GIF is too large (max 1.4 MB).');
    return file;
  }
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('That image couldn’t be read.'); });
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  for (const q of [0.86, 0.72, 0.56]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', q));
    if (blob && blob.type === 'image/webp' && blob.size <= MAX_BYTES) return blob; // keeps transparency for logos
    const jpg = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (jpg && jpg.size <= MAX_BYTES) return jpg;
  }
  throw new Error('That image is too large even after compression. Try a smaller one.');
}
