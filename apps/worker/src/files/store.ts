// The object storage the file jobs need (m2-attachments design D3, D5), as
// business code sees it. The S3 implementation is apps/worker/infra/s3-store.ts;
// MemoryFileStore (memory.ts) stands in for it in tests and local runs.
// Object bodies never reach a log line.

export interface ObjectHead {
  /** The first bytes of the object (at most what was asked for). */
  bytes: Uint8Array;
  /** The object's full size in bytes. */
  size: number;
}

export interface FileStore {
  /** The first `length` bytes and the size of an object; null when it does not exist. */
  head(key: string, length: number): Promise<ObjectHead | null>;
  /**
   * Copy an object within the bucket, keeping its tags (the scanner's
   * `GuardDutyMalwareScanStatus`, ADR 0005 item 7) and setting the stored
   * Content-Type to the type read from the bytes.
   */
  copy(from: string, to: string, contentType: string): Promise<void>;
  /** Delete an object; deleting one that does not exist succeeds. */
  delete(key: string): Promise<void>;
}
