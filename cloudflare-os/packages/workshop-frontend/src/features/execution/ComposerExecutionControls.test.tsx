// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import type {RpcStub} from 'capnweb';
import type {AuthenticatedApi, Overseer} from '@gadgets/workshop-shared/api';
import type {ChatExecutionSelection, ExecutionProfile} from '@gadgets/workshop-shared/execution-workspace';
import {ComposerExecutionControls} from './ComposerExecutionControls';
import {ComposerModeSelector} from './ComposerModeSelector';
import {useExecutionProfile} from './useExecutionProfile';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};
vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
let root: Root, container: HTMLDivElement;
afterEach(async () => {await act(async () => root?.unmount()); container?.remove();});
const profile: ExecutionProfile = {enabled: true, identity: {username: 'bryce', uid: 12345, gid: 23456},
  providers: [{id: 'gitlab', label: 'Internal GitLab', kind: 'gitlab'}], connections: []};

const mount = async (result = profile) => {
  const getExecutionProfile = vi.fn<() => Promise<ExecutionProfile>>(async () => result);
  const linkGitConnection = vi.fn<(providerId: string, token: string) => Promise<import("@gadgets/workshop-shared/execution-workspace").GitConnection>>(async () => ({id: 'my-account', providerId: 'gitlab', login: 'bryce'}));
  const api = {getExecutionProfile, linkGitConnection, removeGitConnection: vi.fn<(id: string) => Promise<void>>(async () => {})} as unknown as RpcStub<AuthenticatedApi>;
  const selected = vi.fn<(value: ChatExecutionSelection) => void>();
  const Harness = () => {
    const [value, setValue] = useState<ChatExecutionSelection>({mode: 'ask', environment: 'rhel10'});
    const {profile: loadedProfile, setProfile, unavailable} = useExecutionProfile(api);
    const onChange = (next: ChatExecutionSelection) => {selected(next); setValue(next);};
    return <><ComposerModeSelector value={value} disabled={false} onChange={onChange} unavailable={unavailable} /><ComposerExecutionControls api={api} value={value} disabled={false} profile={loadedProfile} onProfileChange={setProfile} unavailable={unavailable} onChange={onChange} getOverseer={() => ({} as RpcStub<Overseer>)} /></>;
  };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
  return {selected, linkGitConnection, getExecutionProfile};
};
const click = async (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector); expect(element).not.toBeNull();
  await act(async () => element!.click());
};
const menu = async (text: string) => {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith(text));
  expect(item).toBeDefined(); await act(async () => item!.click());
};
const input = async (label: string, value: string) => {
  const field = [...document.querySelectorAll<HTMLInputElement>('input')]
    .find(field => document.querySelector(`label[for="${field.id}"]`)?.textContent?.includes(label));
  expect(field).toBeDefined();
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field!.dispatchEvent(new Event('input', {bubbles: true}));});
};

it('defaults to Ask, offers RHEL 10 in Agent, disables Windows, and links the caller’s Git account', async () => {
  const {selected, linkGitConnection, getExecutionProfile} = await mount();
  expect(container.querySelector('[aria-label="Chat mode"] button[aria-pressed="true"]')?.textContent).toBe('Ask');
  expect(container.querySelector('[aria-label="Select environment"]')).toBeNull();
  await click('[aria-label="Chat mode"] button:first-child');
  expect(selected).toHaveBeenLastCalledWith({mode: 'agent', environment: 'rhel10'});
  await click('[aria-label="Select environment"]');
  const windows = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.startsWith('Windows'));
  expect(windows?.getAttribute('aria-disabled')).toBe('true');
  await menu('Red Hat'); await click('[aria-label="Select Git connector"]');
  await input('Personal access token', 'my-private-token');
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(linkGitConnection).toHaveBeenCalledWith('gitlab', 'my-private-token');
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
  await input('Repository', 'team/project');
  const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use repository');
  await act(async () => save!.click());
  expect(selected).toHaveBeenLastCalledWith({mode: 'agent', environment: 'rhel10', git: {connectionId: 'my-account', repository: 'team/project'}});
  await click('[aria-label="Chat mode"] button:last-child');
  expect(selected).toHaveBeenLastCalledWith({mode: 'ask', environment: 'rhel10', git: {connectionId: 'my-account', repository: 'team/project'}});
  expect(container.querySelector('[aria-label="Select environment"]')).toBeNull();
  await click('[aria-label="Chat mode"] button:first-child');
  expect(container.querySelector('[aria-label="Select Git connector"]')?.textContent).toBe('team/project');
  expect(getExecutionProfile).toHaveBeenCalledTimes(1);
});

it('keeps Ask available and explains why Agent needs IdP UID/GID claims', async () => {
  await mount({...profile, identity: null});
  const agent = container.querySelector<HTMLButtonElement>('[aria-label="Chat mode"] button:first-child');
  expect(agent?.disabled).toBe(true);
  await click('[aria-label="Chat mode"] button:first-child');
  expect(document.body.textContent).toContain('UID/GID');
  await click('[aria-label="Chat mode"] button:last-child');
  expect(container.querySelector('[aria-label="Chat mode"] button[aria-pressed="true"]')?.textContent).toBe('Ask');
});
