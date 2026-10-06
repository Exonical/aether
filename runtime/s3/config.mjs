import { readFile } from "node:fs/promises";

/** Read direct S3 settings or a mounted COSI v1alpha1 BucketInfo document. */
export async function readConfig(env = process.env) {
  let source = env;
  if (env.AETHER_COSI_BUCKET_INFO) {
    const info = JSON.parse(await readFile(env.AETHER_COSI_BUCKET_INFO, "utf8"));
    const spec = info.spec;
    if (!spec?.secretS3 || !spec.protocols?.some(value => value.toLowerCase() === "s3")) {
      throw new Error("COSI BucketInfo must provide S3 access");
    }
    source = {
      ...env, AWS_ENDPOINT_URL: spec.secretS3.endpoint, BUCKET_NAME: spec.bucketName,
      AWS_DEFAULT_REGION: spec.secretS3.region,
      AWS_ACCESS_KEY_ID: spec.secretS3.accessKeyID, AWS_SECRET_ACCESS_KEY: spec.secretS3.accessSecretKey,
    };
  }
  if (source.COSI_PROTOCOL && source.COSI_PROTOCOL.toUpperCase() !== "S3") throw new Error("COSI protocol must be S3");
  for (const key of ["AWS_ENDPOINT_URL", "BUCKET_NAME", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AETHER_TENANT_ID"]) {
    if (!source[key]?.trim()) throw new Error(`Missing ${key}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(source.AETHER_TENANT_ID)) throw new Error("Invalid AETHER_TENANT_ID");
  const endpoint = new URL(source.AWS_ENDPOINT_URL);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("S3 endpoint must be an HTTP(S) origin without credentials or a path");
  }
  if (endpoint.protocol === "http:" && source.AETHER_S3_ALLOW_HTTP !== "true") throw new Error("HTTP S3 requires AETHER_S3_ALLOW_HTTP=true");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(source.BUCKET_NAME)) throw new Error("Invalid S3 bucket name");
  const style = source.AWS_S3_ADDRESSING_STYLE || "path";
  if (!["path", "virtual"].includes(style)) throw new Error("AWS_S3_ADDRESSING_STYLE must be path or virtual");
  const prefix = source.AETHER_S3_PREFIX || `aether/${source.AETHER_TENANT_ID}/`;
  if (!prefix.endsWith("/") || prefix.startsWith("/") || prefix.split("/").some(part => part === "." || part === "..") || !/^[a-zA-Z0-9/_-]+$/.test(prefix)) {
    throw new Error("AETHER_S3_PREFIX must be a relative path ending in / without traversal");
  }
  const port = source.AETHER_S3_PORT || "9001";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid AETHER_S3_PORT");
  const ca = source.AETHER_S3_CA_FILE
    ? await readFile(source.AETHER_S3_CA_FILE, "utf8") : source.COSI_CERTIFICATE_AUTHORITY;
  return {
    endpoint: endpoint.origin, bucket: source.BUCKET_NAME, region: source.AWS_DEFAULT_REGION,
    forcePathStyle: style === "path", prefix, tenantId: source.AETHER_TENANT_ID, port: Number(port), ca,
    credentials: {
      accessKeyId: source.AWS_ACCESS_KEY_ID, secretAccessKey: source.AWS_SECRET_ACCESS_KEY,
      ...(source.AWS_SESSION_TOKEN ? { sessionToken: source.AWS_SESSION_TOKEN } : {}),
    },
  };
}
