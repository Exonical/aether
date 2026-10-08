import {useRef, useEffect, useState} from 'react';
import {Button, Dialog, DropdownMenu, Input} from '@cloudflare/kumo';
import type {RpcStub} from 'capnweb';
import type {AuthenticatedApi} from '@gadgets/workshop-shared/api';
import type {ExecutionProfile, GitRepositorySelection} from '@gadgets/workshop-shared/execution-workspace';

export const GitConnectionDialog = ({api, profile, selection, onProfileChange, onSelect, onClose}: {
  api: RpcStub<AuthenticatedApi>;
  profile: ExecutionProfile;
  selection?: GitRepositorySelection;
  onProfileChange: (profile: ExecutionProfile) => void;
  onSelect: (selection?: GitRepositorySelection) => void;
  onClose: () => void;
}) => {
  const [connectionId, setConnectionId] = useState(selection?.connectionId ?? '');
  const [repository, setRepository] = useState(selection?.repository ?? '');
  const [providerId, setProviderId] = useState(profile.providers[0]?.id ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const connection = profile.connections.find(item => item.id === connectionId);
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try {await operation();} catch (err) {if (mounted.current) setError(String(err));}
    finally {if (mounted.current) setBusy(false);}
  };
  return <Dialog.Root open onOpenChange={open => {if (!open && !busy) onClose();}}>
    <Dialog size="lg" className="space-y-4 bg-kumo-base p-6">
      <Dialog.Title className="text-lg font-medium text-kumo-default">Git connector</Dialog.Title>
      <Dialog.Description className="text-sm text-kumo-subtle">Link your own Git account, then choose a repository for this chat.</Dialog.Description>
      <DropdownMenu>
        <DropdownMenu.Trigger render={<Button disabled={busy}>{connection ? `${connection.login} · ${connection.providerId}` : 'Choose linked account'}</Button>} />
        <DropdownMenu.Content>
          {profile.connections.map(item => <DropdownMenu.Item key={item.id} onClick={() => setConnectionId(item.id)}>{item.login} · {item.providerId}</DropdownMenu.Item>)}
        </DropdownMenu.Content>
      </DropdownMenu>
      <Input label="Repository" placeholder="team/project" value={repository} disabled={busy} onChange={event => setRepository(event.target.value)} />
      {connection && <Button variant="ghost" disabled={busy} onClick={() => void perform(async () => {
        await api.removeGitConnection(connection.id);
        if (!mounted.current) return;
        onProfileChange({...profile, connections: profile.connections.filter(item => item.id !== connection.id)});
        setConnectionId('');
      })}>Disconnect {connection.login}</Button>}
      <form className="space-y-3 border-t border-kumo-line pt-4" onSubmit={event => {event.preventDefault(); void perform(async () => {
        const linked = await api.linkGitConnection(providerId, token);
        if (!mounted.current) return;
        setToken(''); setConnectionId(linked.id); onProfileChange({...profile, connections: [...profile.connections, linked]});
      });}}>
        <p className="text-sm font-medium text-kumo-default">Link an account</p>
        {profile.providers.length ? <>
          <DropdownMenu>
            <DropdownMenu.Trigger render={<Button disabled={busy}>{profile.providers.find(item => item.id === providerId)?.label ?? 'Choose Git service'}</Button>} />
            <DropdownMenu.Content>{profile.providers.map(item => <DropdownMenu.Item key={item.id} onClick={() => setProviderId(item.id)}>{item.label}</DropdownMenu.Item>)}</DropdownMenu.Content>
          </DropdownMenu>
          <Input label="Personal access token" type="password" autoComplete="off" value={token} disabled={busy} onChange={event => setToken(event.target.value)} />
          <p className="text-xs text-kumo-subtle">Use a token limited to reading your repositories and identifying your account. It is stored privately and kept out of the environment.</p>
          <Button type="submit" disabled={busy || !providerId || !token.trim()}>Link account</Button>
        </> : <p className="text-sm text-kumo-subtle">Your administrator has not configured any Git services.</p>}
      </form>
      {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => onSelect(undefined)}>No repository</Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={busy || !connection || !repository.trim()} onClick={() => onSelect({connectionId, repository: repository.trim()})}>Use repository</Button>
      </div>
    </Dialog>
  </Dialog.Root>;
};
