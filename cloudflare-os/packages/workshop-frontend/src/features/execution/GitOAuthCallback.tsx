import {useEffect, useRef, useState} from 'react';
import {Button} from '@cloudflare/kumo';
import type {RpcStub} from 'capnweb';
import type {AuthenticatedApi} from '@gadgets/workshop-shared/api';
import type {GitConnection} from '@gadgets/workshop-shared/execution-workspace';
import {GIT_OAUTH_BROWSER_KEY, GIT_OAUTH_CALLBACK_PATH} from './gitOAuth';

export const GitOAuthCallback = ({api}: {api: RpcStub<AuthenticatedApi>}) => {
  const [callback] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    let saved: {state?: string; returnTo?: string} = {};
    try {saved = JSON.parse(sessionStorage.getItem(GIT_OAUTH_BROWSER_KEY) ?? '{}');} catch { /* Invalid browser handoffs are refused below. */ }
    let returnTo = '/';
    try {const url = new URL(saved.returnTo ?? '/', window.location.origin); if (url.origin === window.location.origin && url.pathname !== GIT_OAUTH_CALLBACK_PATH) returnTo = url.href;} catch { /* Keep the local fallback. */ }
    return {state: query.get('state'), code: query.get('code'), denied: query.has('error'), expected: saved.state, returnTo};
  });
  const completion = useRef<Promise<GitConnection> | null>(null);
  const [status, setStatus] = useState('Connecting your Git account…');
  useEffect(() => {
    let cancelled = false;
    if (!completion.current) completion.current = (async () => {
      sessionStorage.removeItem(GIT_OAUTH_BROWSER_KEY);
      window.history.replaceState(null, '', GIT_OAUTH_CALLBACK_PATH);
      if (!callback.state || callback.state !== callback.expected || !/^[a-f0-9]{64}$/.test(callback.state)
          || callback.denied || !callback.code) throw new Error('Git authorization failed or expired. Connect again.');
      return api.completeGitOAuth(callback.state, callback.code);
    })();
    void completion.current.then(connection => {
      if (cancelled) return;
      setStatus('Git account connected. You can return to your chat.');
      const channel = new BroadcastChannel(`aether.git.oauth.${callback.state}`);
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is origin-scoped and has no targetOrigin argument.
      channel.postMessage({connectionId: connection.id}); channel.close();
      window.close();
    }, () => {
      if (cancelled) return;
      setStatus('Git authorization failed or expired. Close this window and connect again.');
      if (callback.state && callback.state === callback.expected && /^[a-f0-9]{64}$/.test(callback.state)) {
        const channel = new BroadcastChannel(`aether.git.oauth.${callback.state}`);
        // eslint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is origin-scoped and has no targetOrigin argument.
        channel.postMessage({error: true}); channel.close();
      }
    });
    return () => {cancelled = true;};
  }, [api, callback]);
  return <main className="flex min-h-full flex-col items-center justify-center gap-4 bg-kumo-base p-6">
    <h1 className="text-lg font-medium text-kumo-default">Git connection</h1>
    <p role="status" className="text-sm text-kumo-subtle">{status}</p>
    <Button onClick={() => window.location.assign(callback.returnTo)}>Return to Aether</Button>
  </main>;
};
