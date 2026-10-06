const encoder = new TextEncoder();
function encode(value) {
  return btoa(String.fromCharCode(...encoder.encode(value))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value) {
  return new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)));
}

/** Backend for the pinned native KV protocol Worker, without modifying upstream code. */
export class PostgresKeyValueStorage {
  constructor(object) { this.object = object; }
  async request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set("X-Aether-Namespace", this.object.name);
    const result = await this.object.env.POSTGRES.fetch(`http://postgres${path}`, { ...options, headers });
    if (!result.ok && result.status !== 404) {
      await result.body?.cancel();
      throw new Error("PostgreSQL KV operation failed");
    }
    return result;
  }
  async get(key) {
    const result = await this.request(`/entry?key=${encode(key)}`);
    if (result.status === 404) return null;
    const expiration = result.headers.get("X-Aether-Expiration");
    const metadata = result.headers.get("X-Aether-Metadata");
    return { key, value: result.body,
      ...(expiration === null ? {} : { expiration: Number(expiration) }),
      ...(metadata === null ? {} : { metadata: JSON.parse(decode(metadata)) }),
    };
  }
  async put(entry) {
    // Buffer at most KV's 25 MiB limit, then check its abort signal before committing.
    // The pinned validator discards excess chunks while raising AbortError.
    const value = await new Response(entry.value).arrayBuffer();
    entry.signal?.throwIfAborted();
    const headers = new Headers();
    if (entry.expiration !== undefined) headers.set("X-Aether-Expiration", String(entry.expiration));
    if (entry.metadata !== undefined) headers.set("X-Aether-Metadata", encode(JSON.stringify(await entry.metadata)));
    await this.request(`/entry?key=${encode(entry.key)}`, { method: "PUT", headers, body: value });
  }
  async delete(key) { await this.request(`/entry?key=${encode(key)}`, { method: "DELETE" }); }
  async list(options) {
    const params = new URLSearchParams({ limit: String(options.limit ?? 1000), prefix: options.prefix ?? "" });
    if (options.cursor !== undefined) params.set("cursor", options.cursor);
    return (await this.request(`/list?${params}`)).json();
  }
}
