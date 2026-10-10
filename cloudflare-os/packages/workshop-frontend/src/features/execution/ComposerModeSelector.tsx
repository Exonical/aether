import {useId} from 'react';
import {Button} from '@cloudflare/kumo';
import {ChatCircle, Code} from '@phosphor-icons/react';
import type {ChatExecutionSelection} from '@gadgets/workshop-shared/execution-workspace';

export const ComposerModeSelector = ({value, onChange, disabled, unavailable}: {
  value: ChatExecutionSelection;
  onChange: (selection: ChatExecutionSelection) => void;
  disabled: boolean;
  unavailable: string;
}) => {
  const explanationId = useId();
  return <div className="mb-3 flex flex-col items-end gap-1">
    <div role="group" aria-label="Chat mode" className="inline-flex gap-1 rounded-full bg-kumo-tint p-1">
      <Button type="button" size="sm" variant={value.mode === 'agent' ? 'secondary' : 'ghost'}
        className="rounded-full" aria-pressed={value.mode === 'agent'} disabled={disabled || !!unavailable}
        aria-describedby={unavailable ? explanationId : undefined}
        onClick={() => onChange({...value, mode: 'agent'})}>
        <Code size={15} />Agent
      </Button>
      <Button type="button" size="sm" variant={value.mode === 'ask' ? 'secondary' : 'ghost'}
        className="rounded-full" aria-pressed={value.mode === 'ask'} disabled={disabled}
        onClick={() => onChange({...value, mode: 'ask'})}>
        <ChatCircle size={15} />Ask
      </Button>
    </div>
    {unavailable && <p id={explanationId} className="max-w-full text-right text-xs text-kumo-subtle">{unavailable}</p>}
  </div>;
};
