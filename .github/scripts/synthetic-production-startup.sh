#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temp_dir="$(mktemp -d)"
mock_pid=""
api_pid=""

cleanup() {
  if [[ -n "$api_pid" ]]; then kill "$api_pid" 2>/dev/null || true; fi
  if [[ -n "$mock_pid" ]]; then kill "$mock_pid" 2>/dev/null || true; fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$temp_dir/key.pem" \
  -out "$temp_dir/cert.pem" \
  -days 1 \
  -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1" \
  >/dev/null 2>&1

cat >"$temp_dir/mock-services.mjs" <<'EOF'
import https from "node:https";
import { readFileSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const [keyPath, certPath] = process.argv.slice(2);
const objects = new Map();
const accessKeyId = "ci-only-access-key";
const secretAccessKey = "ci-only-secret-key-not-a-real-secret";
const region = "ap-southeast-2";
const service = "s3";
const requestTimeToleranceMs = 15 * 60 * 1000;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function hmac(key, content) {
  return createHmac("sha256", key).update(content).digest();
}

function signingKey(day) {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), "aws4_request");
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(searchParams, excludedName) {
  return [...searchParams.entries()]
    .filter(([name]) => name !== excludedName)
    .map(([name, value]) => [awsEncode(name), awsEncode(value)])
    .sort(([aName, aValue], [bName, bValue]) =>
      aName === bName ? aValue.localeCompare(bValue) : aName.localeCompare(bName),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function parseTimestamp(value) {
  if (!/^\d{8}T\d{6}Z$/.test(value)) return undefined;
  const parsed = Date.parse(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` +
      `T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
  );
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = new Date(parsed).toISOString().replace(/[:-]|\.\d{3}/g, "");
  return normalized === value ? parsed : undefined;
}

function parseScope(credential, timestamp) {
  const parts = credential.split("/");
  if (
    parts.length !== 5 ||
    parts[0] !== accessKeyId ||
    parts[1] !== timestamp.slice(0, 8) ||
    parts[2] !== region ||
    parts[3] !== service ||
    parts[4] !== "aws4_request"
  ) {
    return undefined;
  }
  return {
    day: parts[1],
    scope: parts.slice(1).join("/"),
  };
}

function signedHeaderText(request, signedHeadersValue) {
  const names = signedHeadersValue.split(";");
  if (
    names.length === 0 ||
    names.includes("") ||
    !names.includes("host") ||
    names.some((name) => !/^[a-z0-9-]+$/.test(name)) ||
    new Set(names).size !== names.length ||
    names.join(";") !== [...names].sort().join(";")
  ) {
    return undefined;
  }
  const lines = [];
  for (const name of names) {
    const value = request.headers[name];
    if (value === undefined || Array.isArray(value)) return undefined;
    lines.push(`${name}:${String(value).trim().replace(/\s+/g, " ")}\n`);
  }
  return lines.join("");
}

function signaturesMatch(expected, supplied) {
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expectedBytes = Buffer.from(expected, "hex");
  const suppliedBytes = Buffer.from(supplied, "hex");
  return expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}

function expectedSignature(canonicalRequest, timestamp, scope, day) {
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  return createHmac("sha256", signingKey(day)).update(stringToSign).digest("hex");
}

function authenticateHeader(request, url, bytes, now) {
  const authorization = String(request.headers.authorization ?? "");
  const match = authorization.match(
    /^AWS4-HMAC-SHA256 Credential=([^,\s]+), SignedHeaders=([^,\s]+), Signature=([a-f0-9]+)$/,
  );
  if (!match) return false;
  const timestamp = request.headers["x-amz-date"];
  const payloadHash = request.headers["x-amz-content-sha256"];
  if (
    typeof timestamp !== "string" ||
    typeof payloadHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(payloadHash) ||
    payloadHash !== sha256(bytes)
  ) {
    return false;
  }
  const requestTime = parseTimestamp(timestamp);
  if (requestTime === undefined || Math.abs(now - requestTime) > requestTimeToleranceMs) {
    return false;
  }
  const scope = parseScope(match[1], timestamp);
  const canonicalHeaders = signedHeaderText(request, match[2]);
  if (!scope || !canonicalHeaders) return false;
  const canonicalRequest = [
    request.method,
    url.pathname,
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    match[2],
    payloadHash,
  ].join("\n");
  return signaturesMatch(
    expectedSignature(canonicalRequest, timestamp, scope.scope, scope.day),
    match[3],
  );
}

function oneQueryValue(url, name) {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function authenticatePresigned(request, url, now) {
  const algorithm = oneQueryValue(url, "X-Amz-Algorithm");
  const credential = oneQueryValue(url, "X-Amz-Credential");
  const timestamp = oneQueryValue(url, "X-Amz-Date");
  const expiresValue = oneQueryValue(url, "X-Amz-Expires");
  const signedHeaders = oneQueryValue(url, "X-Amz-SignedHeaders");
  const signature = oneQueryValue(url, "X-Amz-Signature");
  if (
    algorithm !== "AWS4-HMAC-SHA256" ||
    credential === undefined ||
    timestamp === undefined ||
    expiresValue === undefined ||
    signedHeaders === undefined ||
    signature === undefined ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !/^(?:[1-9]\d{0,5})$/.test(expiresValue)
  ) {
    return false;
  }
  const expiresSeconds = Number(expiresValue);
  const requestTime = parseTimestamp(timestamp);
  if (
    requestTime === undefined ||
    expiresSeconds > 604800 ||
    requestTime - now > requestTimeToleranceMs ||
    now > requestTime + expiresSeconds * 1000
  ) {
    return false;
  }
  const scope = parseScope(credential, timestamp);
  const canonicalHeaders = signedHeaderText(request, signedHeaders);
  if (!scope || !canonicalHeaders) return false;
  const canonicalRequest = [
    request.method,
    url.pathname,
    canonicalQuery(url.searchParams, "X-Amz-Signature"),
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  return signaturesMatch(
    expectedSignature(canonicalRequest, timestamp, scope.scope, scope.day),
    signature,
  );
}

const server = https.createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  async (request, response) => {
    if (request.method === "POST" && request.url === "/alerts") {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url, "https://127.0.0.1:9443");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const authenticated = url.searchParams.has("X-Amz-Signature")
      ? authenticatePresigned(request, url, Date.now())
      : authenticateHeader(request, url, bytes, Date.now());
    if (!authenticated) {
      response.writeHead(403);
      response.end();
      return;
    }
    const key = url.pathname;
    if (request.method === "PUT") {
        const contentSha256 = sha256(bytes);
        const required =
          request.headers["x-amz-acl"] === "private" &&
          request.headers["x-amz-server-side-encryption"] === "AES256" &&
          request.headers["x-amz-meta-sha256"] === contentSha256 &&
          request.headers["x-amz-checksum-sha256"] === Buffer.from(contentSha256, "hex").toString("base64") &&
          request.headers["x-amz-content-sha256"] === contentSha256;
        if (!required) {
          response.writeHead(400);
          response.end();
          return;
        }
        objects.set(key, {
          bytes,
          contentType: request.headers["content-type"] ?? "application/octet-stream",
          sha256: contentSha256,
        });
        response.writeHead(200);
        response.end();
      return;
    }
    const object = objects.get(key);
    if (request.method === "HEAD") {
      if (!object) {
        response.writeHead(404);
      } else {
        response.writeHead(200, {
          "content-length": object.bytes.length,
          "content-type": object.contentType,
          "x-amz-meta-sha256": object.sha256,
          etag: `"${object.sha256}"`,
        });
      }
      response.end();
      return;
    }
    if (request.method === "GET") {
      if (!object) {
        response.writeHead(404);
        response.end();
      } else {
        response.writeHead(200, {
          "content-length": object.bytes.length,
          "content-type": object.contentType,
        });
        response.end(object.bytes);
      }
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(405);
    response.end();
  },
);
server.listen(9443, "127.0.0.1", () => console.log("synthetic HTTPS services listening"));
EOF

node "$temp_dir/mock-services.mjs" "$temp_dir/key.pem" "$temp_dir/cert.pem" \
  >"$temp_dir/mock.log" 2>&1 &
mock_pid=$!

for _ in $(seq 1 50); do
  if grep -q "synthetic HTTPS services listening" "$temp_dir/mock.log"; then break; fi
  if ! kill -0 "$mock_pid" 2>/dev/null; then
    cat "$temp_dir/mock.log"
    exit 1
  fi
  sleep 0.1
done

NODE_EXTRA_CA_CERTS="$temp_dir/cert.pem" \
SYNTHETIC_S3_ENDPOINT="https://127.0.0.1:9443" \
pnpm --filter @aee/api exec tsx "$repo_root/.github/scripts/exercise-object-storage.ts"

printf 'Synthetic approved terms for isolated CI startup validation.\n' >"$temp_dir/terms.txt"
printf 'Synthetic approved privacy policy for isolated CI startup validation.\n' >"$temp_dir/privacy.txt"
terms_sha="$(sha256sum "$temp_dir/terms.txt" | cut -d' ' -f1)"
privacy_sha="$(sha256sum "$temp_dir/privacy.txt" | cut -d' ' -f1)"

(
  cd "$repo_root"
  NODE_ENV=production \
  PORT=8080 \
  NODE_EXTRA_CA_CERTS="$temp_dir/cert.pem" \
  CORS_ALLOWED_ORIGINS="https://ci.invalid" \
  METRICS_TOKEN="ci-only-metrics-token-not-a-real-secret" \
  PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED=true \
  OPERATIONAL_ALERTS_ENABLED=true \
  OPERATIONAL_ALERTS_PROVIDER=webhook \
  OPERATIONAL_ALERTS_WEBHOOK_URL="https://127.0.0.1:9443/alerts" \
  OPERATIONAL_ALERTS_TOKEN="ci-only-alert-token-not-a-real-secret" \
  LEGAL_DOCUMENTS_APPROVED=true \
  APPROVED_TERMS_ARTIFACT_PATH="$temp_dir/terms.txt" \
  APPROVED_TERMS_SHA256="$terms_sha" \
  APPROVED_PRIVACY_ARTIFACT_PATH="$temp_dir/privacy.txt" \
  APPROVED_PRIVACY_SHA256="$privacy_sha" \
  OBJECT_STORAGE_PROVIDER=s3 \
  OBJECT_STORAGE_ENDPOINT="https://127.0.0.1:9443" \
  OBJECT_STORAGE_REGION="ap-southeast-2" \
  OBJECT_STORAGE_BUCKET="synthetic-private-documents" \
  OBJECT_STORAGE_ACCESS_KEY_ID="ci-only-access-key" \
  OBJECT_STORAGE_SECRET_ACCESS_KEY="ci-only-secret-key-not-a-real-secret" \
  OBJECT_STORAGE_SERVER_SIDE_ENCRYPTION=AES256 \
  DOCUMENT_STORAGE_SIGNING_SECRET="ci-only-document-signing-secret-not-real" \
  node apps/api/dist/index.mjs
) >"$temp_dir/api.log" 2>&1 &
api_pid=$!

for _ in $(seq 1 100); do
  if curl --fail --silent "http://127.0.0.1:8080/api/health/ready" \
    >"$temp_dir/readiness.json" 2>/dev/null; then
    grep -q '"status":"ok"' "$temp_dir/readiness.json"
    echo "Synthetic production startup and durable-storage readiness passed."
    exit 0
  fi
  if ! kill -0 "$api_pid" 2>/dev/null; then
    cat "$temp_dir/api.log"
    exit 1
  fi
  sleep 0.2
done

cat "$temp_dir/api.log"
echo "Synthetic production startup did not become ready." >&2
exit 1