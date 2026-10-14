/**
 * Object-storage abstraction. Bytes live here; metadata lives in Postgres.
 *
 * Drivers:
 *   - local : filesystem (dev / single-node self-host). Fully implemented.
 *   - s3    : any S3-compatible store — AWS S3, MinIO, Cloudflare R2 — via the
 *             AWS SDK (lazily imported so it is optional). Supports presigned
 *             URLs so large files upload/download directly to the store.
 *
 * The files API uses putObject/getObject for a portable direct path, and
 * presigned URLs when the driver offers them.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../config.js";

export interface StorageObject {
  body: Buffer;
  contentType: string;
}

export interface StorageDriver {
  readonly name: string;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<StorageObject | null>;
  deleteObject(key: string): Promise<void>;
  /** Optional: presigned direct-upload URL (S3). */
  presignPut?(key: string, contentType: string): Promise<string>;
  /** Optional: presigned direct-download URL (S3). */
  presignGet?(key: string): Promise<string>;
  /** Optional: ensure the backing bucket exists (idempotent). */
  ensureBucket?(): Promise<void>;
}

class LocalDriver implements StorageDriver {
  readonly name = "local";
  private base: string;
  constructor(baseDir: string) {
    this.base = resolve(baseDir);
  }
  private path(key: string): string {
    // Prevent path traversal: hash-namespaced keys only.
    const safe = key.replace(/[^a-zA-Z0-9/_.-]/g, "_");
    const full = resolve(join(this.base, safe));
    if (!full.startsWith(this.base)) throw new Error("invalid storage key");
    return full;
  }
  async putObject(key: string, body: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async getObject(key: string): Promise<StorageObject | null> {
    try {
      return { body: await readFile(this.path(key)), contentType: "application/octet-stream" };
    } catch {
      return null;
    }
  }
  async deleteObject(key: string): Promise<void> {
    await unlink(this.path(key)).catch(() => {});
  }
}

class S3Driver implements StorageDriver {
  readonly name = "s3";
  private client: import("@aws-sdk/client-s3").S3Client;
  private sdk: typeof import("@aws-sdk/client-s3");
  private presigner: typeof import("@aws-sdk/s3-request-presigner");
  constructor(
    sdk: typeof import("@aws-sdk/client-s3"),
    presigner: typeof import("@aws-sdk/s3-request-presigner"),
    private readonly config: Config,
  ) {
    this.sdk = sdk;
    this.presigner = presigner;
    this.client = new sdk.S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials:
        config.S3_ACCESS_KEY && config.S3_SECRET_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY }
          : undefined,
    });
  }
  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new this.sdk.PutObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  }
  async getObject(key: string): Promise<StorageObject | null> {
    try {
      const res = await this.client.send(new this.sdk.GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
      const body = Buffer.from(await res.Body!.transformToByteArray());
      return { body, contentType: res.ContentType ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new this.sdk.DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key })).catch(() => {});
  }
  async presignPut(key: string, contentType: string): Promise<string> {
    return this.presigner.getSignedUrl(
      this.client,
      new this.sdk.PutObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: 900 },
    );
  }
  async presignGet(key: string): Promise<string> {
    return this.presigner.getSignedUrl(this.client, new this.sdk.GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }), { expiresIn: 900 });
  }
  /**
   * Create the bucket if it is missing. Idempotent and best-effort: a store
   * with a pre-provisioned bucket (AWS S3, R2) or credentials lacking the
   * create permission is fine — uploads still work. This replaces the need
   * for an external bucket-bootstrap sidecar for self-hosted MinIO.
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new this.sdk.HeadBucketCommand({ Bucket: this.config.S3_BUCKET }));
      return; // already exists and is reachable
    } catch {
      // Fall through to attempt creation.
    }
    try {
      await this.client.send(new this.sdk.CreateBucketCommand({ Bucket: this.config.S3_BUCKET }));
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      // Already created (possibly by a peer replica) — not an error.
      if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") return;
      throw err;
    }
  }
}

export async function createStorageDriver(config: Config): Promise<StorageDriver> {
  if (config.STORAGE_DRIVER === "s3" || config.STORAGE_DRIVER === "minio") {
    try {
      const sdk = await import("@aws-sdk/client-s3");
      const presigner = await import("@aws-sdk/s3-request-presigner");
      return new S3Driver(sdk, presigner, config);
    } catch (err) {
      console.warn(`[storage] S3 SDK unavailable (${(err as Error).message}); using local driver.`);
    }
  }
  return new LocalDriver(config.STORAGE_LOCAL_DIR);
}

/** Deterministic, collision-resistant object key for a file. */
export function makeStorageKey(organizationId: string, fileId: string, filename: string): string {
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  const shard = createHash("sha256").update(fileId).digest("hex").slice(0, 2);
  return `${organizationId}/${shard}/${fileId}${ext}`;
}
