export default {
  async fetch(request, env) {
    const response = await env.ADAPTER.fetch(request);
    // Miniflare BlobStore.put() assumes that a resolved fetch means a successful write.
    // Throw on failed writes so R2 never commits metadata referencing a missing S3 blob.
    if (!response.ok && !(request.method !== "PUT" && [404, 416].includes(response.status))) {
      await response.body?.cancel();
      throw new Error("S3 blob operation failed");
    }
    return response;
  },
};
