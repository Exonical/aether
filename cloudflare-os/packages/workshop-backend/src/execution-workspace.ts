import type {ExecutionOperation, ExecutionResult} from '@gadgets/workshop-shared/execution-workspace';

/** Calls the private execution controller with a kernel-derived workspace identity. */
export async function executeWorkspace(env: Cloudflare.Env, id: string, operation: ExecutionOperation): Promise<ExecutionResult> {
  if (env.AETHER_EXECUTION_ENABLED !== 'true' || !env.AETHER_EXECUTION) throw new Error('Linux workspaces are disabled');
  const response = await env.AETHER_EXECUTION.fetch(`http://execution/v1/workspaces/${id}`, {
    method: 'POST', headers: {'content-type': 'application/json', 'x-aether-tenant': env.AETHER_EXECUTION_TENANT!},
    body: JSON.stringify(operation),
  });
  if (!response.ok) throw new Error(`Linux workspace unavailable (${response.status}). Refresh its status or start it first.`);
  return response.json<ExecutionResult>();
}
