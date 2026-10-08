/** Only administrator-configured, self-hosted HTTPS origins may receive Git credentials. */
export function gitProviders(providers) {
  const approved = new Map();
  for (const provider of providers) {
    const url = new URL(provider.url);
    const api = new URL(provider.apiUrl || `${url.origin}/api/${provider.kind === 'github' ? 'v3' : 'v4'}/`);
    if (!/^[a-z0-9-]{1,64}$/.test(provider.id) || !['github', 'gitlab'].includes(provider.kind)
        || typeof provider.label !== 'string' || !provider.label || provider.label.length > 100 || approved.has(provider.id)
        || [url, api].some(u => u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
        || ['github.com', 'api.github.com', 'gitlab.com'].includes(url.hostname.toLowerCase())
        || url.pathname !== '/' || api.origin !== url.origin || !api.pathname.endsWith('/')) throw new Error('Invalid self-hosted Git provider');
    approved.set(provider.id, {...provider, url, api});
  }
  return approved;
}
