import type {GitConnection, GitOAuthStart} from '@gadgets/workshop-shared/execution-workspace';
import {executionGit} from './execution-workspace';

type Credential = {token: string; authentication?: 'oauth'; refreshToken?: string; expiresAt?: number};
type StoredConnection = GitConnection & Credential;
type PendingOAuth = {providerId: string; verifier: string; expires: number; completing?: boolean};
const connectionsKey = 'aether.git.connections';
const pendingPrefix = 'aether.git.oauth.';

/** User-private Git grants. No method exposes credentials through the authenticated API. */
export class GitConnections {
  private mutations = new Map<string, Promise<unknown>>();

  constructor(private storage: DurableObjectStorage, private env: Cloudflare.Env) {}

  async list(): Promise<GitConnection[]> {
    return (await this.storage.get<StoredConnection[]>(connectionsKey) ?? [])
      .map(({id, providerId, login}) => ({id, providerId, login}));
  }

  private async save(providerId: string, credential: Credential, state?: string): Promise<GitConnection> {
    const {login} = await executionGit<{login: string}>(this.env, 'verify', {providerId, ...credential});
    const connection = {id: crypto.randomUUID(), providerId, login};
    await this.storage.transaction(async txn => {
      if (state) {
        const pending = await txn.get<PendingOAuth>(pendingPrefix + state);
        if (!pending?.completing || pending.expires <= Date.now()) throw new Error('Git OAuth link canceled or expired');
        await txn.delete(pendingPrefix + state);
      }
      const stored = await txn.get<StoredConnection[]>(connectionsKey) ?? [];
      if (stored.length >= 16) throw new Error('Git connection limit reached');
      await txn.put(connectionsKey, [...stored, {...connection, ...credential}]);
    });
    return connection;
  }

  async link(providerId: string, token: string): Promise<GitConnection> {
    if (!providerId || providerId.length > 64 || !token || token.length > 4096
        || [...token].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid Git connection');
    return this.save(providerId, {token});
  }

  async begin(providerId: string): Promise<GitOAuthStart> {
    const state = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const {url, verifier} = await executionGit<{url: string; verifier: string}>(this.env, 'oauth/begin', {providerId, state});
    await this.storage.transaction(async txn => {
      const pending = await txn.list<PendingOAuth>({prefix: pendingPrefix});
      for (const [key, value] of pending) if (value.expires <= Date.now()) {await txn.delete(key); pending.delete(key);}
      if (pending.size >= 8) throw new Error('Too many pending Git connections');
      await txn.put(pendingPrefix + state, {providerId, verifier, expires: Date.now() + 600000});
    });
    return {url, state};
  }

  async complete(state: string, code: string): Promise<GitConnection> {
    if (!/^[a-f0-9]{64}$/.test(state) || typeof code !== 'string' || !code || code.length > 4096) throw new Error('Invalid Git OAuth callback');
    const pending = await this.storage.transaction(async txn => {
      const value = await txn.get<PendingOAuth>(pendingPrefix + state);
      // Claim once before the exchange; keep a cancellable record until the grant commits.
      if (!value || value.completing || value.expires <= Date.now()) throw new Error('Git OAuth link expired; connect again');
      await txn.put(pendingPrefix + state, {...value, completing: true});
      return value;
    });
    let credential: Credential | undefined;
    try {
      credential = await executionGit<Credential>(this.env, 'oauth/exchange', {...pending, code});
      return await this.save(pending.providerId, credential, state);
    }
    catch (error) {
      if (credential) await executionGit(this.env, 'oauth/revoke', {providerId: pending.providerId, token: credential.token});
      throw error;
    }
    finally {await this.storage.delete(pendingPrefix + state);}
  }

  async cancel(state: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(state)) throw new Error('Invalid Git OAuth state');
    await this.storage.delete(pendingPrefix + state);
  }

  private async serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.mutations.set(id, current);
    try {return await current;}
    finally {if (this.mutations.get(id) === current) this.mutations.delete(id);}
  }

  /** Private launch credential; refresh and disconnect serialize to avoid resurrecting a grant. */
  async credential(id: string): Promise<StoredConnection> {
    return this.serialized(id, async () => {
      const stored = await this.storage.get<StoredConnection[]>(connectionsKey) ?? [];
      const connection = stored.find(item => item.id === id);
      if (!connection) throw new Error('Select one of your own linked Git accounts');
      if (connection.authentication === 'oauth' && connection.expiresAt && connection.expiresAt <= Date.now() + 60000) {
        const updated = {...connection, ...await executionGit<Credential>(this.env, 'oauth/refresh', {providerId: connection.providerId, refreshToken: connection.refreshToken})};
        await this.storage.transaction(async txn => {
          const current = await txn.get<StoredConnection[]>(connectionsKey) ?? [];
          await txn.put(connectionsKey, current.map(item => item.id === id ? updated : item));
        });
        // Leases issued with the rotated access token must not keep stale credentials alive.
        await executionGit(this.env, 'rotate', {connectionId: id});
        return updated;
      }
      return connection;
    });
  }

  async remove(id: string): Promise<void> {
    return this.serialized(id, async () => {
      const stored = await this.storage.get<StoredConnection[]>(connectionsKey) ?? [];
      const connection = stored.find(item => item.id === id);
      if (!connection) throw new Error('No such Git connection');
      await executionGit(this.env, 'revoke', {connectionId: id});
      if (connection.authentication === 'oauth') await executionGit(this.env, 'oauth/revoke', {providerId: connection.providerId, token: connection.token});
      await this.storage.transaction(async txn => {
        const current = await txn.get<StoredConnection[]>(connectionsKey) ?? [];
        await txn.put(connectionsKey, current.filter(item => item.id !== id));
      });
    });
  }
}
