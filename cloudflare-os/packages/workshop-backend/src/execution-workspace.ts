import type {ChatExecutionSelection, ExecutionIdentity, ExecutionOperation, ExecutionResult} from '@gadgets/workshop-shared/execution-workspace';

/** Private launch payload. Git credentials must never appear in the public execution API. */
export interface ExecutionLaunch {
  /** Verified identity from the caller's user object. */
  identity: ExecutionIdentity;
  /** Supported environment, selected by the owner. */
  environment: 'rhel10';
  /** Private connection credential and the selected repository, sent only to the controller. */
  git?: {connectionId: string; providerId: string; token: string; repository: string};
}

/** Normalize untrusted composer settings before storing them. Ask is the default. */
export function chatExecution(selection?: ChatExecutionSelection): ChatExecutionSelection {
  if (!selection) return {mode: 'ask', environment: 'rhel10'};
  if (!['ask', 'agent'].includes(selection.mode) || selection.environment !== 'rhel10') throw new Error('Unsupported chat environment');
  const git = selection.git;
  if (git && (typeof git.connectionId !== 'string' || git.connectionId.length > 64 || typeof git.repository !== 'string'
      || git.repository.length > 256 || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)+$/.test(git.repository)
      || git.repository.split('/').some(part => part === '..' || part.endsWith('.git')))) throw new Error('Use a repository path such as team/project');
  return {mode: selection.mode, environment: 'rhel10', ...(git ? {git: {connectionId: git.connectionId, repository: git.repository}} : {})};
}

/** Derive an isolated container identity for each chat; callers cannot choose pod or PVC names. */
export async function executionId(workspaceId: string, chatId: number): Promise<string> {
  if (!Number.isSafeInteger(chatId) || chatId < 0) throw new Error('Invalid chat');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${workspaceId}:${chatId}`));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

/** Private controller request used for user-owned Git connections. */
export async function executionGit<T>(env: Cloudflare.Env, path: 'providers' | 'verify' | 'revoke', body?: object): Promise<T> {
  if (env.AETHER_EXECUTION_ENABLED !== 'true' || !env.AETHER_EXECUTION) throw new Error('Agent environments are disabled');
  const response = await env.AETHER_EXECUTION.fetch(`http://execution/v1/git/${path}`, {
    method: body ? 'POST' : 'GET', headers: {'content-type': 'application/json', 'x-aether-tenant': env.AETHER_EXECUTION_TENANT!},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  if (!response.ok) throw new Error('Git connection operation failed');
  return response.json<T>();
}

/** Calls the private execution controller with a kernel-derived workspace identity. */
export async function executeWorkspace(env: Cloudflare.Env, id: string, operation: ExecutionOperation, launch?: ExecutionLaunch): Promise<ExecutionResult> {
  if (env.AETHER_EXECUTION_ENABLED !== 'true' || !env.AETHER_EXECUTION) throw new Error('Linux workspaces are disabled');
  const response = await env.AETHER_EXECUTION.fetch(`http://execution/v1/workspaces/${id}`, {
    method: 'POST', headers: {'content-type': 'application/json', 'x-aether-tenant': env.AETHER_EXECUTION_TENANT!},
    body: JSON.stringify({...operation, ...(operation.action === 'start' ? launch : {})}),
  });
  if (!response.ok) throw new Error(`Linux workspace unavailable (${response.status}). Refresh its status or start it first.`);
  return response.json<ExecutionResult>();
}
