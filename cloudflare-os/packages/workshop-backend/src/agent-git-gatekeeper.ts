import {DurableObject} from 'cloudflare:workers';
import type {Gatekeeper, ResourceDescription} from '@gadgets/workshop-shared/gatekeeper';
import type {GitRepositorySelection, AgentGitResult} from '@gadgets/workshop-shared/execution-workspace';
import {executionGit, executionLaunchKey} from './execution-workspace';

/** Controller-verified push snapshot; never sent to a browser or execution pod. */
export interface AgentGitPrepared {
  action: 'push' | 'pull-request';
  branch: string;
  base: string;
  title?: string;
  body?: string;
  head?: string;
  pack?: string;
  old?: string;
  baseHead?: string;
  anchor?: string;
  anchorCommit?: string;
  sha256?: string;
  size?: number;
}

/** Owner-selected authority baked into a chat's private Gatekeeper facet. */
export interface AgentGitProps {
  ownerId: string;
  workspace: string;
  selection: GitRepositorySelection;
  identity: string;
}

type StoredAction = {request: AgentGitPrepared; chunks: number; state: AgentGitResult['state']; created: number; result?: AgentGitResult['result']};

/** Uses the ordinary Gatekeeper approval lifecycle; never exposes a writable sandbox credential. */
export class AgentGitGatekeeper extends DurableObject<Cloudflare.Env, AgentGitProps> implements Gatekeeper<never> {
  #applying = new Map<number, Promise<void>>();

  async describe(): Promise<ResourceDescription> {
    return {url: 'http://agent-git.local/', title: `Agent Git: ${this.ctx.props.selection.repository}`,
      snippet: 'Owner-approved task branch pushes and pull requests.', suggestedBindingName: 'AGENT_GIT', tsType: 'never'};
  }
  async getTypeScriptTypes(): Promise<string> {return '';}
  async getAutoApprovableActions() {return [];}
  async startSession(): Promise<never> {throw new Error('Agent Git is available only through owner-started Agent tools');}
  async addObserver(): Promise<void> {throw new Error('Agent Git is owner-only');}
  async removeObserver(): Promise<void> {}
  async revertAction(): Promise<never> {throw new Error('Agent Git actions cannot be automatically reverted');}

  /** Stage only a controller-verified, bounded immutable artifact before submitting its approval. */
  async stage(request: AgentGitPrepared): Promise<number> {
    return this.ctx.storage.transaction(async storage => {
      if (await storage.get('retired')) throw new Error('Git facet retired');
      const pending = await storage.list<StoredAction>({prefix: 'action.'});
      if ([...pending.values()].filter(item => item.state === 'pending').length >= 8) throw new Error('Too many pending Git actions');
      const id = (await storage.get<number>('next')) ?? 1;
      const {pack, ...metadata} = request;
      const chunks = pack ? Math.ceil(pack.length / 64000) : 0;
      for (let index = 0; index < chunks; index++) await storage.put(`pack.${id}.${index}`, pack!.slice(index * 64000, (index + 1) * 64000));
      await storage.put(`action.${id}`, {request: metadata, chunks, state: 'pending', created: Date.now()} satisfies StoredAction);
      await storage.put('next', id + 1);
      return id;
    });
  }

  applyAction(id: number): Promise<void> {
    const existing = this.#applying.get(id);
    if (existing) return existing;
    const applying = this.#apply(id).finally(() => this.#applying.delete(id));
    this.#applying.set(id, applying);
    return applying;
  }

  async #apply(id: number): Promise<void> {
    const item = await this.ctx.storage.get<StoredAction>(`action.${id}`);
    if (item?.state === 'approved') return;
    if (!item || item.state === 'rejected' || Date.now() - item.created > 86400000) throw new Error('Git action expired or rejected');
    const user = this.ctx.exports.UserDurableObject.get(this.ctx.exports.UserDurableObject.idFromString(this.ctx.props.ownerId));
    await user.getGatekeeperClassFor({agentGit: {workspace: this.ctx.props.workspace, selection: this.ctx.props.selection}}, 'http://agent-git.local/');
    const launch = await user.getExecutionLaunch(this.ctx.props.selection);
    if (executionLaunchKey(launch) !== this.ctx.props.identity) throw new Error('Agent identity changed');
    const parts: string[] = [];
    for (let index = 0; index < item.chunks; index++) {
      const part = await this.ctx.storage.get<string>(`pack.${id}.${index}`);
      if (part === undefined) throw new Error('Git snapshot unavailable');
      parts.push(part);
    }
    item.result = await executionGit<AgentGitResult['result']>(this.env, 'apply-action', {
      workspace: this.ctx.props.workspace, git: launch.git,
      action: {...item.request, ...(item.chunks ? {pack: parts.join('')} : {})},
    });
    item.state = 'approved';
    await this.ctx.storage.put(`action.${id}`, item);
    await this.#removePack(id, item.chunks);
  }

  async rejectAction(id: number): Promise<void> {
    if (this.#applying.has(id)) throw new Error('Git action is already applying');
    await this.ctx.storage.transaction(async storage => {
      const item = await storage.get<StoredAction>(`action.${id}`);
      if (!item || item.state === 'approved') throw new Error('Git action cannot be rejected');
      item.state = 'rejected';
      await storage.put(`action.${id}`, item);
      await storage.delete(Array.from({length: item.chunks}, (_, index) => `pack.${id}.${index}`));
    });
  }

  /** Redacted outcome; the pack, OAuth token and private controller request are never exposed. */
  async status(id: number): Promise<AgentGitResult> {
    const item = await this.ctx.storage.get<StoredAction>(`action.${id}`);
    if (!item) throw new Error('Unknown Git action');
    return {id, state: item.state, result: {branch: item.request.branch, ...item.result}};
  }

  /** Destroy all private artifacts before removing this chat's facet. */
  async retire(): Promise<void> {
    await Promise.all(this.#applying.values());
    // Facet storage cannot use deleteAll(): delete its own keys without touching the parent DO.
    await this.ctx.storage.put('retired', true);
    while (true) {
      const keys = [...(await this.ctx.storage.list({limit: 1000})).keys()].filter(key => key !== 'retired');
      if (!keys.length) break;
      await this.ctx.storage.delete(keys);
    }
  }

  async #removePack(id: number, chunks: number): Promise<void> {
    await this.ctx.storage.delete(Array.from({length: chunks}, (_, index) => `pack.${id}.${index}`));
  }
}
