import {useEffect, useState} from 'react';
import {Button, Dialog} from '@cloudflare/kumo';
import type {RpcStub} from 'capnweb';
import type {Overseer} from '@gadgets/workshop-shared/api';
import {ExecutionPanel} from './ExecutionPanel';

export const WorkspaceDialog = ({chatId, getOverseer, onClose}: {
  chatId: number;
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>;
  onClose: () => void;
}) => {
  // This stub is borrowed from the conversation. The owner of getOverseer handles disposal.
  const [workspace, setWorkspace] = useState<{stub: RpcStub<Overseer>}>();
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(getOverseer).then(stub => {if (!cancelled) setWorkspace({stub});})
      .catch(err => {if (!cancelled) setError(String(err));});
    return () => {cancelled = true;};
  }, [getOverseer]);
  return <Dialog.Root open onOpenChange={open => {if (!open) onClose();}}>
    <Dialog size="xl" className="max-h-[85vh] overflow-auto bg-kumo-base p-4">
      <Dialog.Title className="text-lg font-medium text-kumo-default">RHEL 10 workspace</Dialog.Title>
      <Dialog.Description className="text-sm text-kumo-subtle">Commands run as your signed-in user, with sudo inside the environment.</Dialog.Description>
      {workspace ? <ExecutionPanel overseer={workspace.stub} chatId={chatId} /> : <p role="status">{error || 'Connecting…'}</p>}
      <Button variant="secondary" onClick={onClose}>Close</Button>
    </Dialog>
  </Dialog.Root>;
};
