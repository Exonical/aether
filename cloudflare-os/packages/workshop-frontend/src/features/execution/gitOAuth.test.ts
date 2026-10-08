// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {RpcStub} from 'capnweb';
import type {AuthenticatedApi} from '@gadgets/workshop-shared/api';
import type {GitOAuthStart} from '@gadgets/workshop-shared/execution-workspace';
import {GIT_OAUTH_BROWSER_KEY, openGitOAuth} from './gitOAuth';

afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();});
const fixture = () => {
  let receive: ((event: {data: unknown}) => void) | null = null;
  const channelClose = vi.fn<() => void>(), replace = vi.fn<(url: string) => void>(), close = vi.fn<() => void>(), setItem = vi.fn<(key: string, value: string) => void>();
  vi.stubGlobal('BroadcastChannel', class {
    constructor(public name: string) {}
    addEventListener(_type: string, value: (event: {data: unknown}) => void) {receive = value;}
    close = channelClose;
  });
  const popup = {closed: false, opener: window, close, sessionStorage: {setItem}, location: {replace}};
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const beginGitOAuth = vi.fn<(providerId: string) => Promise<GitOAuthStart>>(async () => ({url: 'https://git.internal/oauth/authorize', state: 'a'.repeat(64)}));
  const api = {beginGitOAuth} as unknown as RpcStub<AuthenticatedApi>;
  return {popup, beginGitOAuth, api, close, channelClose, setItem, replace, deliver: (data: unknown) => receive!({data})};
};

it('opens from the click, removes the opener and returns only an account identifier over a state-scoped channel', async () => {
  const f = fixture(), flow = openGitOAuth(f.api, 'internal');
  expect(window.open).toHaveBeenCalledBefore(f.beginGitOAuth);
  expect(f.popup.opener).toBeNull();
  await Promise.resolve();
  expect(f.setItem).toHaveBeenCalledWith(GIT_OAUTH_BROWSER_KEY, JSON.stringify({state: 'a'.repeat(64), returnTo: window.location.href}));
  expect(f.replace).toHaveBeenCalledWith('https://git.internal/oauth/authorize');
  f.deliver({connectionId: 'own-account'});
  await expect(flow.finished).resolves.toBe('own-account');
  expect(f.channelClose).toHaveBeenCalled(); expect(f.close).toHaveBeenCalled();
});

it('refuses blocked popups and clears the handoff when the user closes it', async () => {
  const f = fixture(); vi.spyOn(window, 'open').mockReturnValueOnce(null);
  expect(() => openGitOAuth(f.api, 'internal')).toThrow(/popups/);
  expect(f.beginGitOAuth).not.toHaveBeenCalled();
  vi.useFakeTimers();
  const flow = openGitOAuth(f.api, 'internal');
  const rejected = flow.finished.catch(error => error);
  await Promise.resolve(); f.popup.closed = true; await vi.advanceTimersByTimeAsync(500);
  expect((await rejected).message).toMatch(/closed/); expect(f.channelClose).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('cancellation while the start RPC is pending prevents later navigation', async () => {
  const f = fixture();
  let release!: (value: {url: string; state: string}) => void;
  f.beginGitOAuth.mockImplementation(() => new Promise(resolve => {release = resolve;}));
  const flow = openGitOAuth(f.api, 'internal');
  const rejected = flow.finished.catch(error => error); flow.cancel(); expect((await rejected).message).toMatch(/closed/);
  release({url: 'https://git.internal/oauth/authorize', state: 'a'.repeat(64)});
  await Promise.resolve(); expect(f.replace).not.toHaveBeenCalled();
});
