// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import {StrictMode, act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import type {RpcStub} from 'capnweb';
import type {AuthenticatedApi} from '@gadgets/workshop-shared/api';
import type {GitConnection} from '@gadgets/workshop-shared/execution-workspace';
import {GitOAuthCallback} from './GitOAuthCallback';
import {GIT_OAUTH_BROWSER_KEY} from './gitOAuth';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
afterEach(async () => {await act(async () => root?.unmount()); container?.remove(); sessionStorage.clear(); window.history.replaceState(null, '', '/'); vi.restoreAllMocks(); vi.unstubAllGlobals();});
const mount = async (expected = 'a'.repeat(64), query = `state=${'a'.repeat(64)}&code=private-code`) => {
  window.history.replaceState(null, '', `/git/callback?${query}`);
  sessionStorage.setItem(GIT_OAUTH_BROWSER_KEY, JSON.stringify({state: expected, returnTo: '/workspace/my-chat'}));
  const postMessage = vi.fn<(message: unknown) => void>();
  vi.stubGlobal('BroadcastChannel', class {postMessage = postMessage; close() {}});
  vi.spyOn(window, 'close').mockImplementation(() => {});
  const completeGitOAuth = vi.fn<(state: string, code: string) => Promise<GitConnection>>(async () => ({id: 'own-account', providerId: 'internal', login: 'bryce'}));
  const api = {completeGitOAuth} as unknown as RpcStub<AuthenticatedApi>;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<StrictMode><GitOAuthCallback api={api} /></StrictMode>));
  return {completeGitOAuth, postMessage};
};

it('completes once in Strict Mode, scrubs the callback URL and sends no credentials to the parent', async () => {
  const f = await mount();
  expect(f.completeGitOAuth).toHaveBeenCalledTimes(1);
  expect(f.completeGitOAuth).toHaveBeenCalledWith('a'.repeat(64), 'private-code');
  expect(window.location.search).toBe(''); expect(sessionStorage.getItem(GIT_OAUTH_BROWSER_KEY)).toBeNull();
  expect(f.postMessage).toHaveBeenCalledWith({connectionId: 'own-account'});
  expect(container.textContent).toContain('Git account connected');
});

it('rejects callback state from another browser handoff without invoking the API', async () => {
  const f = await mount('b'.repeat(64));
  expect(f.completeGitOAuth).not.toHaveBeenCalled(); expect(f.postMessage).not.toHaveBeenCalled();
  expect(container.textContent).toContain('failed or expired');
});

it('handles denied authorization without reflecting provider error descriptions', async () => {
  const f = await mount('a'.repeat(64), `state=${'a'.repeat(64)}&error=denied&error_description=secret-provider-detail`);
  expect(f.completeGitOAuth).not.toHaveBeenCalled(); expect(f.postMessage).toHaveBeenCalledWith({error: true});
  expect(container.textContent).not.toContain('secret-provider-detail');
});
