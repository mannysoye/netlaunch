export interface StoredObject {
  body: ArrayBuffer;
  contentType: string;
  size: number;
}

export interface PutOptions {
  contentType: string;
  cacheControl?: string;
}

/** The only thing the rest of the app knows about object storage. Swap S3 <-> R2 without touching callers. */
export interface Storage {
  put(key: string, body: Uint8Array | string, opts: PutOptions): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<{ size: number; contentType?: string } | null>;
  delete(key: string): Promise<void>;
  copy(srcKey: string, dstKey: string): Promise<void>;
}

export const siteKey = (slug: string, path: string): string => `sites/${slug}/${path}`;
export const draftKey = (conversationId: string, imageId: string): string => `drafts/${conversationId}/${imageId}`;
