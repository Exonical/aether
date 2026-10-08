// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';
import type {RpcStub} from 'capnweb';
import type {AuthenticatedApi} from '@gadgets/workshop-shared/api';
import type {ExecutionProfile} from '@gadgets/workshop-shared/execution-workspace';
import {GitConnectionDialog} from './GitConnectionDialog';
import {openGitOAuth} from './gitOAuth';

vi.mock('./gitOAuth', () => ({openGitOAuth: vi.fn<typeof openGitOAuth>()}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});

it('uses OAuth for an enterprise provider and refreshes the caller’s account choices without a token field', async () => {
  const profile: ExecutionProfile = {enabled: true, identity: null, providers: [{id: 'enterprise', kind: 'github', label: 'GitHub Enterprise Server', oauth: true}], connections: []};
  const updated = {...profile, connections: [{id: 'my-account', providerId: 'enterprise', login: 'bryce'}]};
  const getExecutionProfile = vi.fn<() => Promise<ExecutionProfile>>(async () => updated), onProfileChange = vi.fn<(value: ExecutionProfile) => void>(), cancel = vi.fn<() => void>();
  vi.mocked(openGitOAuth).mockReturnValue({finished: Promise.resolve('my-account'), cancel});
  const api = {getExecutionProfile} as unknown as RpcStub<AuthenticatedApi>;
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<GitConnectionDialog api={api} profile={profile} onProfileChange={onProfileChange} onSelect={() => {}} onClose={() => {}} />));
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).toContain('repo scope');
    const connect = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Connect GitHub Enterprise Server');
    await act(async () => connect!.click());
    expect(openGitOAuth).toHaveBeenCalledWith(api, 'enterprise');
    expect(getExecutionProfile).toHaveBeenCalledTimes(1); expect(onProfileChange).toHaveBeenCalledWith(updated);
  } finally {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();}
});
