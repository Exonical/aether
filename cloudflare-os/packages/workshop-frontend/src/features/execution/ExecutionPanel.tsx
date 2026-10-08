import {useEffect, useRef, useState} from 'react';
import {Button, Input, InputArea} from '@cloudflare/kumo';
import type {RpcStub} from 'capnweb';
import type {Overseer} from '@gadgets/workshop-shared/api';
import type {ExecutionOperation, ExecutionResult} from '@gadgets/workshop-shared/execution-workspace';

export const ExecutionPanel = ({overseer}: {overseer: RpcStub<Overseer>}) => {
  const [state, setState] = useState('unknown');
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState('git status --short');
  const [path, setPath] = useState('README.md');
  const [content, setContent] = useState('');
  const [output, setOutput] = useState('');
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setBusy(false); setState('unknown'); setOutput('');
    overseer.executionWorkspace({action: 'status'}).then(result => {
      if (current === generation.current) setState(result.state || 'unknown');
    }).catch(error => {if (current === generation.current) setOutput(String(error));});
    return () => {generation.current++;};
  }, [overseer]);

  const perform = async (operation: ExecutionOperation) => {
    const current = generation.current;
    setBusy(true);
    try {
      const result: ExecutionResult = await overseer.executionWorkspace(operation);
      if (current !== generation.current) return;
      if (result.state) setState(result.state);
      if (operation.action === 'read') setContent(result.content || '');
      setOutput(result.output === undefined ? JSON.stringify(result, null, 2)
        : `${result.output}\nExit: ${result.exitCode ?? result.signal}${result.timedOut ? ' (timed out)' : ''}${result.truncated ? ' (truncated)' : ''}`);
    } catch (error) {if (current === generation.current) setOutput(String(error));}
    finally {if (current === generation.current) setBusy(false);}
  };

  return <section aria-label="Linux workspace" className="space-y-3 border-b border-kumo-line p-3 text-kumo-default">
    <p className="text-sm text-kumo-subtle">Start an isolated Linux workspace to give your agents repository, command and file access. Files persist when suspended. Commands run directly in this workspace.</p>
    <div className="flex flex-wrap items-center gap-2">
      <span role="status">{state}</span>
      <Button disabled={busy} onClick={() => void perform({action: 'start'})}>Start / resume</Button>
      <Button disabled={busy} onClick={() => void perform({action: 'status'})}>Refresh status</Button>
      <Button disabled={busy} onClick={() => void perform({action: 'suspend'})}>Suspend</Button>
    </div>
    <form onSubmit={event => {event.preventDefault(); void perform({action: 'exec', command});}} className="flex items-end gap-2">
      <Input label="Shell command" value={command} onChange={event => setCommand(event.target.value)} className="flex-1" />
      <Button type="submit" disabled={busy || state !== 'ready' || !command.trim()}>Run</Button>
      <Button disabled={busy || state !== 'ready'} onClick={() => void perform({action: 'exec', command: 'git diff --no-ext-diff -- .'})}>Review diff</Button>
    </form>
    <details>
      <summary className="cursor-pointer">Workspace files</summary>
      <div className="space-y-2 pt-2">
        <Input label="Relative file path" value={path} onChange={event => setPath(event.target.value)} />
        <InputArea label="File contents" value={content} onChange={event => setContent(event.target.value)} rows={6} />
        <div className="flex gap-2">
          <Button disabled={busy || state !== 'ready'} onClick={() => void perform({action: 'read', path})}>Read file</Button>
          <Button disabled={busy || state !== 'ready'} onClick={() => void perform({action: 'write', path, content})}>Save file</Button>
          <Button disabled={busy || state !== 'ready'} onClick={() => void perform({action: 'list', path: '.'})}>List files</Button>
        </div>
      </div>
    </details>
    <pre aria-label="Workspace output" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-kumo-base p-2 text-xs">{output}</pre>
  </section>;
};
