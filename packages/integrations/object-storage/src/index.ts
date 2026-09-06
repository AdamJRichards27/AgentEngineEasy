import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const MAX_SIGNED_DOWNLOAD_SECONDS = 900;

export interface ObjectHead {
  key: string;
  size: number;
  contentType?: string;
  checksumSha256: string;
  etag?: string;
  lastModified?: Date;
}

export interface SignedDownload {
  url: string;
  expiresAt: Date;
}

export interface IntegrityResult {
  valid: boolean;
  expectedChecksum: string;
  actualChecksum: string;
}

export interface ReadinessResult {
  ready: boolean;
  message?: string;
}

export interface ObjectStorageProvider {
  putObject(key: string, content: string | Buffer, contentType?: string): Promise<{ key: string }>;
  getObject(key: string): Promise<Buffer>;
  headObject(key: string): Promise<ObjectHead>;
  deleteObject(key: string): Promise<void>;
  createSignedDownload(key: string, expiresInSeconds?: number): Promise<SignedDownload>;
  verifyIntegrity(key: string): Promise<IntegrityResult>;
  checkReadiness(): Promise<ReadinessResult>;
}

export class ObjectIntegrityError extends Error {
  constructor(readonly key: string) {
    super(`Object failed SHA-256 integrity verification: ${key}`);
    this.name = "ObjectIntegrityError";
  }
}

export class ObjectStorageRequestError extends Error {
  constructor(
    readonly operation: string,
    readonly statusCode: number,
  ) {
    super(`Object storage ${operation} failed with HTTP ${statusCode}`);
    this.name = "ObjectStorageRequestError";
  }
}

export function assertSafeObjectKey(key: string): void {
  if (
    !key ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.includes("?") ||
    key.includes("#")
  ) {
    throw new Error("Unsafe object storage key");
  }
  const segments = key.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment === ".object-storage-metadata",
    )
  ) {
    throw new Error("Unsafe object storage key");
  }
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateExpiry(expiresInSeconds: number): void {
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 1 ||
    expiresInSeconds > MAX_SIGNED_DOWNLOAD_SECONDS
  ) {
    throw new Error(
      `Signed download expiry must be an integer between 1 and ${MAX_SIGNED_DOWNLOAD_SECONDS} seconds`,
    );
  }
}

interface LocalMetadata {
  key: string;
  size: number;
  contentType?: string;
  checksumSha256: string;
  lastModified: string;
}

export interface LocalObjectStorageConfig {
  baseDir: string;
  signingSecret?: string | Buffer;
  maxSignedDownloadSeconds?: number;
}

/**
 * Local development/test storage. Keys are strictly relative, symlink
 * traversal is rejected, and a separately named sidecar records the digest.
 */
export class LocalObjectStorageProvider implements ObjectStorageProvider {
  private readonly baseDir: string;
  private readonly signingSecret: Buffer;
  private readonly maxSignedDownloadSeconds: number;

  constructor(config: string | LocalObjectStorageConfig) {
    const resolved =
      typeof config === "string" ? { baseDir: config } : config;
    if (!resolved.baseDir.trim()) throw new Error("Local object storage baseDir is required");
    this.baseDir = path.resolve(resolved.baseDir);
    this.signingSecret = Buffer.isBuffer(resolved.signingSecret)
      ? Buffer.from(resolved.signingSecret)
      : Buffer.from(resolved.signingSecret ?? randomBytes(32));
    if (this.signingSecret.length < 32) {
      throw new Error("Local signed-download secret must be at least 32 bytes");
    }
    this.maxSignedDownloadSeconds =
      resolved.maxSignedDownloadSeconds ?? MAX_SIGNED_DOWNLOAD_SECONDS;
    validateExpiry(this.maxSignedDownloadSeconds);
  }

  private resolveKey(key: string): string {
    assertSafeObjectKey(key);
    const resolved = path.resolve(this.baseDir, ...key.split("/"));
    if (!resolved.startsWith(this.baseDir + path.sep)) {
      throw new Error("Unsafe object storage key");
    }
    return resolved;
  }

  private metadataPath(key: string): string {
    const name = createHash("sha256").update(key).digest("hex") + ".json";
    return path.join(this.baseDir, ".object-storage-metadata", name);
  }

  private async rejectSymlinks(target: string): Promise<void> {
    const relative = path.relative(this.baseDir, target);
    let current = this.baseDir;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error("Object storage path contains a symbolic link");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async readMetadata(key: string): Promise<LocalMetadata> {
    const metadataFile = this.metadataPath(key);
    await this.rejectSymlinks(metadataFile);
    const raw = await readFile(metadataFile, "utf8");
    const metadata = JSON.parse(raw) as Partial<LocalMetadata>;
    if (
      metadata.key !== key ||
      typeof metadata.size !== "number" ||
      typeof metadata.checksumSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.checksumSha256) ||
      typeof metadata.lastModified !== "string"
    ) {
      throw new ObjectIntegrityError(key);
    }
    return metadata as LocalMetadata;
  }

  async putObject(
    key: string,
    content: string | Buffer,
    contentType?: string,
  ): Promise<{ key: string }> {
    const resolved = this.resolveKey(key);
    await mkdir(this.baseDir, { recursive: true });
    await this.rejectSymlinks(resolved);
    await mkdir(path.dirname(resolved), { recursive: true });
    await this.rejectSymlinks(resolved);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const metadata: LocalMetadata = {
      key,
      size: bytes.length,
      ...(contentType ? { contentType } : {}),
      checksumSha256: sha256(bytes),
      lastModified: new Date().toISOString(),
    };
    const metadataFile = this.metadataPath(key);
    await this.rejectSymlinks(metadataFile);
    await mkdir(path.dirname(metadataFile), { recursive: true });
    await this.rejectSymlinks(metadataFile);
    const suffix = randomBytes(12).toString("hex");
    const objectTemp = `${resolved}.${suffix}.tmp`;
    const metadataTemp = `${metadataFile}.${suffix}.tmp`;
    try {
      await writeFile(objectTemp, bytes, { flag: "wx", mode: 0o600 });
      await writeFile(metadataTemp, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
      await rename(objectTemp, resolved);
      await rename(metadataTemp, metadataFile);
    } finally {
      await Promise.all([
        rm(objectTemp, { force: true }),
        rm(metadataTemp, { force: true }),
      ]);
    }
    return { key };
  }

  async getObject(key: string): Promise<Buffer> {
    const resolved = this.resolveKey(key);
    await this.rejectSymlinks(resolved);
    const canonical = await realpath(resolved);
    if (!canonical.startsWith(this.baseDir + path.sep)) {
      throw new Error("Object storage path escaped baseDir");
    }
    const [content, metadata] = await Promise.all([
      readFile(canonical),
      this.readMetadata(key),
    ]);
    if (content.length !== metadata.size || sha256(content) !== metadata.checksumSha256) {
      throw new ObjectIntegrityError(key);
    }
    return content;
  }

  async headObject(key: string): Promise<ObjectHead> {
    const resolved = this.resolveKey(key);
    await this.rejectSymlinks(resolved);
    const [file, metadata] = await Promise.all([stat(resolved), this.readMetadata(key)]);
    return {
      key,
      size: file.size,
      ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
      checksumSha256: metadata.checksumSha256,
      lastModified: new Date(metadata.lastModified),
    };
  }

  async deleteObject(key: string): Promise<void> {
    const resolved = this.resolveKey(key);
    await this.rejectSymlinks(resolved);
    await Promise.all([
      unlink(resolved).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }),
      unlink(this.metadataPath(key)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }),
    ]);
  }

  async createSignedDownload(
    key: string,
    expiresInSeconds = 300,
  ): Promise<SignedDownload> {
    this.resolveKey(key);
    validateExpiry(expiresInSeconds);
    if (expiresInSeconds > this.maxSignedDownloadSeconds) {
      throw new Error("Signed download expiry exceeds the configured local limit");
    }
    await this.headObject(key);
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const encodedKey = Buffer.from(key).toString("base64url");
    const signature = createHmac("sha256", this.signingSecret)
      .update(`${encodedKey}\n${expires}`)
      .digest("base64url");
    return {
      url: `local-object://download/${encodedKey}?expires=${expires}&signature=${signature}`,
      expiresAt: new Date(expires * 1000),
    };
  }

  /** Resolve a local signed URL for a development/test download handler. */
  async getSignedObject(url: string): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== "local-object:" || parsed.hostname !== "download") {
      throw new Error("Invalid local signed-download URL");
    }
    const encodedKey = parsed.pathname.slice(1);
    const expiresText = parsed.searchParams.get("expires") ?? "";
    const supplied = parsed.searchParams.get("signature") ?? "";
    if (!/^\d+$/.test(expiresText) || !encodedKey || !supplied) {
      throw new Error("Invalid local signed-download URL");
    }
    const expires = Number(expiresText);
    if (expires < Math.floor(Date.now() / 1000)) {
      throw new Error("Local signed-download URL has expired");
    }
    const expected = createHmac("sha256", this.signingSecret)
      .update(`${encodedKey}\n${expires}`)
      .digest();
    let suppliedBytes: Buffer;
    try {
      suppliedBytes = Buffer.from(supplied, "base64url");
    } catch {
      throw new Error("Invalid local signed-download signature");
    }
    if (
      suppliedBytes.length !== expected.length ||
      !timingSafeEqual(suppliedBytes, expected)
    ) {
      throw new Error("Invalid local signed-download signature");
    }
    const key = Buffer.from(encodedKey, "base64url").toString("utf8");
    assertSafeObjectKey(key);
    return this.getObject(key);
  }

  async verifyIntegrity(key: string): Promise<IntegrityResult> {
    const metadata = await this.readMetadata(key);
    const resolved = this.resolveKey(key);
    await this.rejectSymlinks(resolved);
    const actualChecksum = sha256(await readFile(resolved));
    return {
      valid: actualChecksum === metadata.checksumSha256,
      expectedChecksum: metadata.checksumSha256,
      actualChecksum,
    };
  }

  async checkReadiness(): Promise<ReadinessResult> {
    const probeKey = `.readiness-${randomBytes(12).toString("hex")}`;
    try {
      await this.putObject(probeKey, "ready", "text/plain");
      await this.getObject(probeKey);
      await this.deleteObject(probeKey);
      return { ready: true };
    } catch (error) {
      return {
        ready: false,
        message: error instanceof Error ? error.message : "Local storage readiness failed",
      };
    }
  }
}

export type ServerSideEncryption = "AES256" | "aws:kms";

export interface S3ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  prefix?: string;
  serverSideEncryption: ServerSideEncryption;
  kmsKeyId?: string;
  maxSignedDownloadSeconds?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

interface ValidatedS3Config extends S3ObjectStorageConfig {
  endpointUrl: URL;
  prefix: string;
  maxSignedDownloadSeconds: number;
  requestTimeoutMs: number;
  fetch: typeof fetch;
}

function required(name: string, value: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function validateS3ObjectStorageConfig(
  config: S3ObjectStorageConfig,
): ValidatedS3Config {
  const endpoint = required("OBJECT_STORAGE_ENDPOINT", config.endpoint);
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error("OBJECT_STORAGE_ENDPOINT must be a valid HTTPS URL");
  }
  if (
    endpointUrl.protocol !== "https:" ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.search ||
    endpointUrl.hash
  ) {
    throw new Error("OBJECT_STORAGE_ENDPOINT must be HTTPS and contain no credentials, query, or fragment");
  }
  required("OBJECT_STORAGE_REGION", config.region);
  const bucket = required("OBJECT_STORAGE_BUCKET", config.bucket);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/.test(bucket)) {
    throw new Error("OBJECT_STORAGE_BUCKET contains unsafe characters");
  }
  required("OBJECT_STORAGE_ACCESS_KEY_ID", config.accessKeyId);
  required("OBJECT_STORAGE_SECRET_ACCESS_KEY", config.secretAccessKey);
  if (!["AES256", "aws:kms"].includes(config.serverSideEncryption)) {
    throw new Error("Server-side encryption must be AES256 or aws:kms");
  }
  if (config.serverSideEncryption === "aws:kms" && !config.kmsKeyId?.trim()) {
    throw new Error("OBJECT_STORAGE_KMS_KEY_ID is required for aws:kms encryption");
  }
  const prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");
  if (prefix) assertSafeObjectKey(prefix);
  const maxSignedDownloadSeconds =
    config.maxSignedDownloadSeconds ?? MAX_SIGNED_DOWNLOAD_SECONDS;
  validateExpiry(maxSignedDownloadSeconds);
  const requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
    throw new Error("Object storage request timeout must be between 1 and 120000 ms");
  }
  return {
    ...config,
    endpointUrl,
    endpoint,
    region: config.region.trim(),
    bucket: config.bucket.trim(),
    accessKeyId: config.accessKeyId.trim(),
    secretAccessKey: config.secretAccessKey.trim(),
    prefix,
    maxSignedDownloadSeconds,
    requestTimeoutMs,
    fetch: config.fetch ?? fetch,
  };
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(entries: Array<[string, string]>): string {
  return entries
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function hmac(key: Buffer | string, content: string): Buffer {
  return createHmac("sha256", key).update(content).digest();
}

function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
}

function amzDate(date: Date): { timestamp: string; day: string } {
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { timestamp, day: timestamp.slice(0, 8) };
}

export class S3ObjectStorageProvider implements ObjectStorageProvider {
  private readonly config: ValidatedS3Config;

  constructor(config: S3ObjectStorageConfig) {
    this.config = validateS3ObjectStorageConfig(config);
  }

  private storageKey(key: string): string {
    assertSafeObjectKey(key);
    return this.config.prefix ? `${this.config.prefix}/${key}` : key;
  }

  private objectUrl(key: string): URL {
    const storageKey = this.storageKey(key);
    const basePath = this.config.endpointUrl.pathname.replace(/\/+$/, "");
    const encodedPath = [this.config.bucket, ...storageKey.split("/")]
      .map(awsEncode)
      .join("/");
    const url = new URL(this.config.endpointUrl);
    url.pathname = `${basePath}/${encodedPath}`;
    return url;
  }

  private async signedFetch(
    method: string,
    key: string,
    headers: Record<string, string> = {},
    body?: Buffer,
  ): Promise<Response> {
    const url = this.objectUrl(key);
    const now = new Date();
    const { timestamp, day } = amzDate(now);
    const payloadHash = body ? sha256(body) : sha256("");
    const canonicalHeaders: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
      ...Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name.toLowerCase(),
          value.trim().replace(/\s+/g, " "),
        ]),
      ),
    };
    if (this.config.sessionToken) {
      canonicalHeaders["x-amz-security-token"] = this.config.sessionToken;
    }
    const signedHeaders = Object.keys(canonicalHeaders).sort();
    const canonicalHeaderText = signedHeaders
      .map((name) => `${name}:${canonicalHeaders[name]}\n`)
      .join("");
    const canonicalRequest = [
      method,
      url.pathname,
      "",
      canonicalHeaderText,
      signedHeaders.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      timestamp,
      scope,
      sha256(canonicalRequest),
    ].join("\n");
    const signature = createHmac(
      "sha256",
      signingKey(this.config.secretAccessKey, day, this.config.region),
    )
      .update(stringToSign)
      .digest("hex");
    canonicalHeaders.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      return await this.config.fetch(url, {
        method,
        headers: canonicalHeaders,
        ...(body ? { body } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertResponse(response: Response, operation: string): void {
    if (!response.ok) {
      throw new ObjectStorageRequestError(operation, response.status);
    }
  }

  async putObject(
    key: string,
    content: string | Buffer,
    contentType = "application/octet-stream",
  ): Promise<{ key: string }> {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const digestHex = sha256(body);
    const headers: Record<string, string> = {
      "content-type": contentType,
      "content-length": String(body.length),
      "x-amz-acl": "private",
      "x-amz-checksum-sha256": Buffer.from(digestHex, "hex").toString("base64"),
      "x-amz-meta-sha256": digestHex,
      "x-amz-server-side-encryption": this.config.serverSideEncryption,
    };
    if (this.config.serverSideEncryption === "aws:kms") {
      headers["x-amz-server-side-encryption-aws-kms-key-id"] =
        this.config.kmsKeyId!;
    }
    const response = await this.signedFetch("PUT", key, headers, body);
    this.assertResponse(response, "put");
    return { key };
  }

  async headObject(key: string): Promise<ObjectHead> {
    const response = await this.signedFetch("HEAD", key);
    this.assertResponse(response, "head");
    const checksumSha256 = response.headers.get("x-amz-meta-sha256");
    const size = Number(response.headers.get("content-length"));
    if (!checksumSha256 || !/^[a-f0-9]{64}$/.test(checksumSha256) || !Number.isFinite(size)) {
      throw new ObjectIntegrityError(key);
    }
    const modified = response.headers.get("last-modified");
    return {
      key,
      size,
      ...(response.headers.get("content-type")
        ? { contentType: response.headers.get("content-type")! }
        : {}),
      checksumSha256,
      ...(response.headers.get("etag")
        ? { etag: response.headers.get("etag")!.replace(/^"|"$/g, "") }
        : {}),
      ...(modified ? { lastModified: new Date(modified) } : {}),
    };
  }

  async getObject(key: string): Promise<Buffer> {
    const expected = await this.headObject(key);
    const response = await this.signedFetch("GET", key);
    this.assertResponse(response, "get");
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length !== expected.size || sha256(content) !== expected.checksumSha256) {
      throw new ObjectIntegrityError(key);
    }
    return content;
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.signedFetch("DELETE", key);
    this.assertResponse(response, "delete");
  }

  async createSignedDownload(
    key: string,
    expiresInSeconds = 300,
  ): Promise<SignedDownload> {
    validateExpiry(expiresInSeconds);
    if (expiresInSeconds > this.config.maxSignedDownloadSeconds) {
      throw new Error("Signed download expiry exceeds the configured S3 limit");
    }
    const url = this.objectUrl(key);
    const now = new Date();
    const { timestamp, day } = amzDate(now);
    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const query: Array<[string, string]> = [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${this.config.accessKeyId}/${scope}`],
      ["X-Amz-Date", timestamp],
      ["X-Amz-Expires", String(expiresInSeconds)],
      ["X-Amz-SignedHeaders", "host"],
    ];
    if (this.config.sessionToken) {
      query.push(["X-Amz-Security-Token", this.config.sessionToken]);
    }
    const unsignedQuery = canonicalQuery(query);
    const canonicalRequest = [
      "GET",
      url.pathname,
      unsignedQuery,
      `host:${url.host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      timestamp,
      scope,
      sha256(canonicalRequest),
    ].join("\n");
    const signature = createHmac(
      "sha256",
      signingKey(this.config.secretAccessKey, day, this.config.region),
    )
      .update(stringToSign)
      .digest("hex");
    url.search = `${unsignedQuery}&X-Amz-Signature=${signature}`;
    return {
      url: url.toString(),
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
    };
  }

  async verifyIntegrity(key: string): Promise<IntegrityResult> {
    const expected = await this.headObject(key);
    const response = await this.signedFetch("GET", key);
    this.assertResponse(response, "integrity check");
    const actualChecksum = sha256(Buffer.from(await response.arrayBuffer()));
    return {
      valid: actualChecksum === expected.checksumSha256,
      expectedChecksum: expected.checksumSha256,
      actualChecksum,
    };
  }

  async checkReadiness(): Promise<ReadinessResult> {
    try {
      const response = await this.signedFetch("HEAD", `.readiness-${randomBytes(8).toString("hex")}`);
      // A signed, authenticated request reaching S3 is sufficient; the random
      // object should not exist, hence 404 is the expected non-mutating probe.
      if (response.ok || response.status === 404) return { ready: true };
      return { ready: false, message: `Object storage readiness returned HTTP ${response.status}` };
    } catch (error) {
      return {
        ready: false,
        message: error instanceof Error ? error.message : "Object storage readiness failed",
      };
    }
  }
}

export function createObjectStorageProvider(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStorageProvider {
  const provider = (env.OBJECT_STORAGE_PROVIDER ?? "local").toLowerCase();
  if (provider === "local") {
    return new LocalObjectStorageProvider({
      baseDir: env.OBJECT_STORAGE_LOCAL_DIR ?? "./storage",
      ...(env.OBJECT_STORAGE_LOCAL_SIGNING_SECRET
        ? { signingSecret: env.OBJECT_STORAGE_LOCAL_SIGNING_SECRET }
        : {}),
    });
  }
  if (provider === "s3") {
    const configuredEncryption =
      env.OBJECT_STORAGE_SERVER_SIDE_ENCRYPTION ??
      (env.OBJECT_STORAGE_KMS_KEY_ID ? "aws:kms" : "AES256");
    if (configuredEncryption !== "AES256" && configuredEncryption !== "aws:kms") {
      throw new Error("OBJECT_STORAGE_SERVER_SIDE_ENCRYPTION must be AES256 or aws:kms");
    }
    const encryption: ServerSideEncryption = configuredEncryption;
    return new S3ObjectStorageProvider({
      endpoint: env.OBJECT_STORAGE_ENDPOINT ?? "",
      region: env.OBJECT_STORAGE_REGION ?? "",
      bucket: env.OBJECT_STORAGE_BUCKET ?? "",
      accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY ?? "",
      ...(env.OBJECT_STORAGE_SESSION_TOKEN
        ? { sessionToken: env.OBJECT_STORAGE_SESSION_TOKEN }
        : {}),
      prefix: env.OBJECT_STORAGE_PREFIX,
      serverSideEncryption: encryption,
      kmsKeyId: env.OBJECT_STORAGE_KMS_KEY_ID,
    });
  }
  throw new Error(`Unsupported OBJECT_STORAGE_PROVIDER: ${provider}`);
}