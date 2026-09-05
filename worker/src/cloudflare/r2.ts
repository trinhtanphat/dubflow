export type R2UploadValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;

export type R2UploadedPartLike = {
  partNumber: number;
  etag: string;
};

export type R2ObjectLike = {
  key: string;
  size: number;
};

export type R2GetObjectLike = R2ObjectLike & {
  body: ReadableStream<Uint8Array>;
};

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
  get?(key: string): Promise<R2GetObjectLike | null>;
  put?(key: string, value: R2UploadValue): Promise<R2ObjectLike>;
}
