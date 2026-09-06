export type R2UploadValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;

export type R2UploadedPartLike = {
  partNumber: number;
  etag: string;
};

export type R2ObjectLike = {
  key: string;
  size: number;
};

export type R2ObjectMetadataLike = R2ObjectLike & {
  httpEtag?: string;
  httpMetadata?: { contentType?: string };
};

export type R2Range = { offset: number; length: number };
export type R2GetOptions = { range?: R2Range };

export type R2ObjectBodyLike = R2ObjectMetadataLike & {
  body: ReadableStream<Uint8Array>;
  range?: R2Range;
};

export type R2GetObjectLike = R2ObjectBodyLike;

export interface R2MultipartUploadLike {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: R2UploadValue): Promise<R2UploadedPartLike>;
  complete(parts: R2UploadedPartLike[]): Promise<R2ObjectLike>;
  abort(): Promise<void>;
}

export interface R2BucketLike {
  createMultipartUpload(key: string): Promise<R2MultipartUploadLike>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadLike;
  head?(key: string): Promise<R2ObjectMetadataLike | null>;
  get?(key: string, options?: R2GetOptions): Promise<R2ObjectBodyLike | null>;
  put?(key: string, value: R2UploadValue): Promise<R2ObjectLike>;
  delete?(key: string): Promise<void>;
}

export interface R2ReadableBucketLike {
  head?(key: string): Promise<R2ObjectMetadataLike | null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBodyLike | null>;
}

export type R2MediaBucketLike = R2BucketLike & R2ReadableBucketLike;
