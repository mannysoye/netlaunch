/** Builds the downloadable zip in the browser from the published files, so it costs the server nothing. */
export async function downloadSiteZip(slug: string, assetNames: string[]): Promise<void> {
  const { zipSync, strToU8 } = await import('fflate');
  const get = async (path: string) => {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Couldn’t fetch ${path} (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  files['index.html'] = await get(`/${slug}/`);
  for (const name of assetNames) files[`assets/${name}`] = [await get(`/${slug}/assets/${name}`), { level: 0 }]; // images are already compressed
  files['README.txt'] = strToU8(`${slug}\n\nOpen index.html in any browser, or upload this folder to any static host (Cloudflare Pages, Netlify, GitHub Pages, S3...).\nBuilt with NetLaunch.\n`);
  const zip = zipSync(files as never);
  const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
  const a = document.createElement('a'); a.href = url; a.download = `${slug}.zip`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
