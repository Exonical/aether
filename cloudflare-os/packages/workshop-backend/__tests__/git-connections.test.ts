import {describe, expect, it} from 'vitest';
import {env} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import type {UserDurableObject} from '../src/user';
import {GitConnections} from '../src/git-connections';

declare module 'cloudflare:workers' {
  interface ProvidedEnv {TEST_USER: DurableObjectNamespace<UserDurableObject>}
}

let counter = 0;
const environment = (calls: {path: string; body: any}[], beforeExchange?: () => Promise<void>) => ({
  AETHER_EXECUTION_ENABLED: 'true', AETHER_EXECUTION_TENANT: 'acme',
  AETHER_EXECUTION: {fetch: async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, body = JSON.parse(String(init.body)); calls.push({path, body});
    if (path.endsWith('/begin')) return Response.json({url: `https://git.internal/oauth/authorize?state=${body.state}`, verifier: 'server-only-verifier'});
    if (path.endsWith('/exchange')) {
      await beforeExchange?.();
      return Response.json({token: 'private-access', refreshToken: 'private-refresh', authentication: 'oauth', expiresAt: Date.now() + 1000});
    }
    if (path.endsWith('/refresh')) return Response.json({token: 'rotated-access', refreshToken: 'rotated-refresh', authentication: 'oauth', expiresAt: Date.now() + 7200000});
    if (path.endsWith('/verify')) return Response.json({login: 'bryce'});
    return Response.json({});
  }},
} as Cloudflare.Env);

describe('private, user-owned Git OAuth grants', () => {
  it('binds one-use state to the user and never returns tokens or verifiers', async () => {
    const calls: {path: string; body: any}[] = [], config = environment(calls);
    const owner = env.TEST_USER.getByName(`git-owner-${++counter}`), other = env.TEST_USER.getByName(`git-other-${counter}`);
    const flow = await runInDurableObject(owner, async (_instance, state) => new GitConnections(state.storage, config).begin('internal'));
    expect(Object.keys(flow).toSorted()).toEqual(['state', 'url']);
    await runInDurableObject(other, async (_instance, state) => {
      await new GitConnections(state.storage, config).cancel(flow.state);
      await expect(new GitConnections(state.storage, config).complete(flow.state, 'code')).rejects.toThrow(/expired/);
    });
    await runInDurableObject(owner, async (_instance, state) => {
      const git = new GitConnections(state.storage, config);
      const results = await Promise.allSettled([git.complete(flow.state, 'code'), git.complete(flow.state, 'code')]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(await git.list()).toEqual([{id: expect.any(String), providerId: 'internal', login: 'bryce'}]);
      expect(JSON.stringify(await git.list())).not.toContain('private');
      expect(calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(1);
      await expect(git.complete(flow.state, 'code')).rejects.toThrow(/expired/);
    });
  });

  it('refreshes once for concurrent launches, persists rotation and revokes the latest token on disconnect', async () => {
    const calls: {path: string; body: any}[] = [];
    await runInDurableObject(env.TEST_USER.getByName(`git-refresh-${++counter}`), async (_instance, state) => {
      const git = new GitConnections(state.storage, environment(calls));
      const flow = await git.begin('internal'), linked = await git.complete(flow.state, 'code');
      const credentials = await Promise.all([git.credential(linked.id), git.credential(linked.id)]);
      expect(credentials.map(item => item.token)).toEqual(['rotated-access', 'rotated-access']);
      expect(calls.filter(call => call.path.endsWith('/refresh'))).toHaveLength(1);
      expect(calls.filter(call => call.path.endsWith('/rotate'))).toHaveLength(1);
      const restarted = new GitConnections(state.storage, environment(calls));
      expect((await restarted.credential(linked.id)).refreshToken).toBe('rotated-refresh');
      await git.remove(linked.id);
      expect(calls.find(call => call.path.endsWith('/oauth/revoke'))?.body.token).toBe('rotated-access');
      expect(await git.list()).toEqual([]);
      await expect(git.credential(linked.id)).rejects.toThrow(/own linked/);
    });
  });

  it('expires abandoned states and bounds pending links', async () => {
    await runInDurableObject(env.TEST_USER.getByName(`git-pending-${++counter}`), async (_instance, state) => {
      const git = new GitConnections(state.storage, environment([]));
      for (let i = 0; i < 8; i++) await git.begin('internal');
      await expect(git.begin('internal')).rejects.toThrow(/Too many/);
      const pending = await state.storage.list<{expires: number}>({prefix: 'aether.git.oauth.'});
      const [key] = pending.keys();
      await state.storage.put(key!, {providerId: 'internal', verifier: 'expired', expires: 1});
      await expect(git.complete(key!.slice('aether.git.oauth.'.length), 'code')).rejects.toThrow(/expired/);
      await expect(git.begin('internal')).resolves.toHaveProperty('url');
    });
  });

  it('a disconnect queued behind refresh revokes the rotated token and blocks later launches', async () => {
    const calls: {path: string; body: any}[] = [];
    await runInDurableObject(env.TEST_USER.getByName(`git-disconnect-${++counter}`), async (_instance, state) => {
      const git = new GitConnections(state.storage, environment(calls));
      const flow = await git.begin('internal'), linked = await git.complete(flow.state, 'code');
      const refresh = git.credential(linked.id), disconnect = git.remove(linked.id), later = git.credential(linked.id);
      const rejected = later.catch(error => error);
      expect((await refresh).token).toBe('rotated-access'); await disconnect; expect((await rejected).message).toMatch(/own linked/);
      expect(calls.find(call => call.path.endsWith('/oauth/revoke'))?.body.token).toBe('rotated-access');
      expect(await git.list()).toEqual([]);
    });
  });

  it('cancellation during the token exchange prevents saving the grant and revokes the issued token', async () => {
    const calls: {path: string; body: any}[] = [];
    await runInDurableObject(env.TEST_USER.getByName(`git-cancel-${++counter}`), async (_instance, state) => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => {enter = resolve;});
      const gate = new Promise<void>(resolve => {release = resolve;});
      const git = new GitConnections(state.storage, environment(calls, async () => {enter(); await gate;}));
      const flow = await git.begin('internal');
      const completion = git.complete(flow.state, 'code').catch(error => error);
      await entered; await git.cancel(flow.state); release();
      expect((await completion).message).toMatch(/canceled/);
      expect(await git.list()).toEqual([]);
      expect(calls.find(call => call.path.endsWith('/oauth/revoke'))?.body.token).toBe('private-access');
      await expect(git.complete(flow.state, 'code')).rejects.toThrow(/expired/);
    });
  });
});
