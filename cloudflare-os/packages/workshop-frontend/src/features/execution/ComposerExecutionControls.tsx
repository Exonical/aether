import {useEffect, useState} from 'react';
import {Button, DropdownMenu} from '@cloudflare/kumo';
import {CaretDown, ChatCircle, Code, GitBranch, Terminal} from '@phosphor-icons/react';
import type {RpcStub} from 'capnweb';
import type {AuthenticatedApi, Overseer} from '@gadgets/workshop-shared/api';
import type {ChatExecutionSelection, ExecutionProfile} from '@gadgets/workshop-shared/execution-workspace';
import {GitConnectionDialog} from './GitConnectionDialog';
import {WorkspaceDialog} from './WorkspaceDialog';

const controlClass = 'inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-kumo-line disabled:cursor-not-allowed disabled:opacity-50';

export const ComposerExecutionControls = ({api, value, onChange, disabled, chatId, getOverseer, workspaceAvailable = false}: {
  api: RpcStub<AuthenticatedApi>;
  value: ChatExecutionSelection;
  onChange: (selection: ChatExecutionSelection) => void;
  disabled: boolean;
  chatId?: number | null;
  workspaceAvailable?: boolean;
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>;
}) => {
  const [profile, setProfile] = useState<ExecutionProfile>();
  const [error, setError] = useState('');
  const [gitOpen, setGitOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => api.getExecutionProfile()).then(result => {
      if (!cancelled) {setProfile(result); setError('');}
    }).catch(() => {if (!cancelled) setError('Execution settings could not be loaded');});
    return () => {cancelled = true;};
  }, [api]);
  const unavailable = error || (!profile ? 'Loading environments…' : !profile.enabled
    ? 'Agent environments are disabled by your administrator' : !profile.identity
    ? 'Your identity provider must supply a username and UID/GID to use Agent' : '');
  const connection = profile?.connections.find(item => item.id === value.git?.connectionId);
  return <div className="flex flex-wrap items-center gap-1" aria-label="Chat execution settings">
    <DropdownMenu>
      <DropdownMenu.Trigger render={<button type="button" className={controlClass} disabled={disabled} aria-label="Select chat mode">
        {value.mode === 'ask' ? <ChatCircle size={15} /> : <Code size={15} />}
        {value.mode === 'ask' ? 'Ask' : 'Agent'}<CaretDown size={11} />
      </button>} />
      <DropdownMenu.Content>
        <DropdownMenu.Item onClick={() => onChange({...value, mode: 'ask'})}>Ask · Chat, docs, slides and sheets</DropdownMenu.Item>
        <DropdownMenu.Item disabled={!!unavailable} onClick={() => onChange({...value, mode: 'agent'})}>Agent · Work in an environment</DropdownMenu.Item>
        {unavailable && <p className="max-w-72 px-3 py-2 text-xs text-kumo-subtle">{unavailable}</p>}
      </DropdownMenu.Content>
    </DropdownMenu>
    {value.mode === 'agent' && <>
      <DropdownMenu>
        <DropdownMenu.Trigger render={<button type="button" className={controlClass} disabled={disabled} aria-label="Select environment">RHEL 10<CaretDown size={11} /></button>} />
        <DropdownMenu.Content>
          <DropdownMenu.Item>Red Hat Enterprise Linux 10</DropdownMenu.Item>
          <DropdownMenu.Item disabled>Windows · Coming later</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
      <button type="button" className={controlClass} disabled={disabled || !profile} onClick={() => setGitOpen(true)} aria-label="Select Git connector">
        <GitBranch size={15} /><span className="max-w-48 truncate">{connection && value.git ? value.git.repository : 'Connect Git'}</span><CaretDown size={11} />
      </button>
      {chatId != null && workspaceAvailable && <Button variant="ghost" onClick={() => setWorkspaceOpen(true)} aria-label="Open Agent workspace"><Terminal size={15} />Workspace</Button>}
      {!!unavailable && <p role="alert" className="w-full px-2 text-xs text-kumo-danger">{unavailable}</p>}
    </>}
    {gitOpen && profile && <GitConnectionDialog api={api} profile={profile} selection={value.git} onProfileChange={setProfile}
      onSelect={git => {onChange({...value, git}); setGitOpen(false);}} onClose={() => setGitOpen(false)} />}
    {workspaceOpen && chatId != null && <WorkspaceDialog chatId={chatId} getOverseer={getOverseer} onClose={() => setWorkspaceOpen(false)} />}
  </div>;
};
