// Only the trusted Workshop has this outbound service. The fixed loopback adapter
// validates the original destination; no caller URL becomes a network binding.
export default {
  fetch(request, env) {
    const headers = new Headers({'content-type': request.headers.get('content-type') || '',
      'x-aether-model-url': request.url, 'x-aether-model-tenant': env.TENANT});
    return env.ADAPTER.fetch(new Request('http://adapter/inference', {
      method: request.method, headers, body: request.body, redirect: 'manual',
    }));
  },
};
