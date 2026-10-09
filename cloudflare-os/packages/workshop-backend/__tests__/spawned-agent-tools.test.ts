// The tool surface of a spawned agent: no user is present to review its work, so it gets no tool
// that modifies a gadget or requests a connection, but it can read gadgets and create, read and
// edit worktrees. Drives the real runAgent against a real OverseerImpl, with pi's faux provider
// standing in for the model so each step's offered tools can be inspected and its tool calls
// scripted.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  AgentSpawnerConfig, AiChatAuthorInfo, AiChatMessage, AiToolCall,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AgentSpawnerBinding } from "../src/agent-spawner-binding";
import {buildPackBytes, concatBytes} from '../src/git-codec';
import {COMMIT_1, COMMIT_2, FIXTURE_OBJECTS, b64Bytes} from './git-cache-fixtures';
import { runAgent } from "../src/agent";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const GADGET_ID = 100;

let doCounter = 0;

async function withImpl(fn: (impl: any, instance: OverseerDurableObject) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`spawned-agent-tools-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = OWNER_USER_ID;
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({ getChatContext: async () => ({ profile: OWNER }), getExecutionLaunch: async () => ({environment: 'rhel10', identity: {username: 'owner', uid: 12345, gid: 23456}}) }),
    };
    // The turn is driven by hand below, not by the spawn.
    impl.startAgent = () => {};
    await fn(impl, instance);
  });
}

// A permanent gadget, offered to the spawned agent as env.GADGET.
function seedGadget(impl: any): void {
  impl.storage.gadgets.put({
    type: "gadget", id: GADGET_ID, title: "Gadget", created: new Date(0), bindingName: "GADGET",
    bindings: {},
  });
}

async function commitFiles(impl: any, files: Record<string, string>): Promise<string> {
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents: [],
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: new Date(1700000000_000),
  });
}

// Spawns a chat through the spawner binding a gadget would hold, returning its chat id.
async function spawnChat(impl: any, config: AgentSpawnerConfig): Promise<number> {
  let cls = impl.ctx.exports.AgentSpawnerGatekeeper({ props: {
    overseerId: impl.ctx.id.toString(), config, creatorUserId: OWNER_USER_ID,
  } });
  let facet = await impl.getGatekeeperFacet(900, cls);
  let binding: AgentSpawnerBinding = await facet.startSession(undefined);
  await binding.spawn("Task", "Do the task.");
  let [meta] = [...impl.storage.chatMeta.list()];
  return meta.id;
}

// Runs one agent turn whose model answers each step with the next scripted response, recording
// the tool names offered at every step.
async function runScriptedTurn(
    impl: any, chatId: number,
    steps: ReturnType<typeof fauxAssistantMessage>[]): Promise<string[][]> {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let offered: string[][] = [];
  faux.setResponses(steps.map(step => (context: TranscriptContext) => {
    offered.push(getCurrentTools(context.messages).map(tool => tool.name).toSorted());
    return step;
  }));
  let model = faux.getModel();
  await runAgent(impl, { model, stream: faux.stream }, chatId,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
  return offered;
}

function toolCalls(impl: any, chatId: number): AiToolCall[] {
  return ([...impl.storage.chats.list()] as AiChatMessage[])
      .filter(msg => msg.chatId === chatId)
      .flatMap(msg => msg.type === "message" ? msg.toolCalls ?? [] : []);
}

describe('owner-authorized Linux workspace tools', () => {
  it('holds restricted observations until in-flight pushes finish and refuses a later push', async () => {
    await withImpl(async impl => {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => {entered = resolve;});
      const held = new Promise<void>(resolve => {release = resolve;});
      impl.getGatekeeperFacet = async () => ({applyAction: async () => {entered(); await held;}});
      const record = {id: 100, gatekeeperId: 1, action: 1, type: 'action', state: 'pending', caller: {from: 'user'},
        createdAt: new Date(), description: {title: 'Push', description: 'Captured pack', pushedCommits: [COMMIT_2]}};
      const push = impl.applyPendingAction(record, OWNER, false);
      await started;
      let delivered = false;
      const observation = impl.authorizeObservation(1, {title: 'Sensitive', description: 'Private data', containsRestrictedData: true}, {from: 'user'})
        .then(() => {delivered = true;});
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(delivered).toBe(false);
      expect(impl.storage.containsRestrictedData.get()).toBe(false);
      release(); await push; await observation;
      expect(delivered).toBe(true);
      expect(impl.storage.containsRestrictedData.get()).toBe(true);
      await expect(impl.applyPendingAction({...record, id: 101, state: 'pending'}, OWNER, false)).rejects.toThrow('sensitive');
      impl.storage.containsRestrictedData.put(false);
      const ambiguous = {...record, id: 102, state: 'pending'};
      impl.storage.actions.put(ambiguous);
      impl.getGatekeeperFacet = async () => ({applyAction: async () => {throw new Error('Unknown remote outcome');}});
      await expect(impl.applyPendingAction(ambiguous, OWNER, false)).rejects.toThrow('Unknown remote outcome');
      expect(impl.storage.gitPublicationActionId.get()).toBe(102);
      expect(() => impl.removeGatekeeper(1)).toThrow('pending Git publication');
      await expect(impl.authorizeObservation(1, {title: 'Sensitive', description: 'Private data', containsRestrictedData: true}, {from: 'user'})).rejects.toThrow('outcome unresolved');
      expect(impl.storage.containsRestrictedData.get()).toBe(false);
      impl.getGatekeeperFacet = async () => ({applyAction: async () => {}});
      await impl.applyPendingAction(ambiguous, OWNER, false);
      expect(impl.storage.gitPublicationActionId.get()).toBeUndefined();
      await impl.authorizeObservation(1, {title: 'Sensitive', description: 'Private data', containsRestrictedData: true}, {from: 'user'});
      expect(impl.storage.containsRestrictedData.get()).toBe(true);

    });
  });

  it('imports sandbox packs without granting new commits remote provenance and blocks stale sensitive approvals', async () => {
    await withImpl(async (impl, instance) => {
      const chatId = 1;
      impl.storage.chatMeta.put({id: chatId, title: 'Git task', execution: {mode: 'agent', environment: 'rhel10', git: {connectionId: 'owned', repository: 'team/project'}}, started: new Date(), lastActive: new Date()});
      impl.storage.activeAgents.put({chatId, initiatorUserId: OWNER_USER_ID, modelId: 'faux-model', initiator: OWNER, callbackInitiated: false});
      impl.users.get = () => ({getExecutionLaunch: async (selection: {connectionId: string}) => ({environment: 'rhel10', identity: {username: 'owner', uid: 12345, gid: 23456},
        git: {connectionId: selection.connectionId, providerId: 'internal', repository: 'team/project', token: 'private-owner-token'}}),
        getGatekeeperClassFor: async (input: any) => ({class: impl.ctx.exports.AgentGitGatekeeper({props: {ownerId: OWNER_USER_ID, ...input.agentGit, identity: 'test'}})})});
      const bytes = concatBytes(await buildPackBytes(FIXTURE_OBJECTS.map(object => ({type: object.type, payload: b64Bytes(object.payload)}))));
      let pack = btoa(String.fromCharCode(...bytes));
      const calls: string[] = [];
      impl.env = {...impl.env, AETHER_EXECUTION_ENABLED: 'true', AETHER_EXECUTION_TENANT: 'acme',
        AETHER_EXECUTION: {fetch: async (url: string, init: RequestInit) => {
          calls.push(url); const request = JSON.parse(String(init.body));
          if (request.action === 'git-snapshot') return Response.json({head: COMMIT_2, pack, anchor: COMMIT_1});
          return Response.json({...request.action, old: '0'.repeat(40), baseHead: COMMIT_1, anchor: COMMIT_1, anchorCommit: FIXTURE_OBJECTS.find(object => object.oid === COMMIT_1)!.payload, sha256: 'a'.repeat(64), size: bytes.length});
        }}};
      await impl.ctx.storage.put('aether.execution.enabled.1', true);
      const result = await impl.agentGitOperation(chatId, {action: 'push', branch: 'fix/login', base: 'main'});
      expect(result.state).toBe('pending');
      const record = [...impl.storage.actions.list()].find((action: any) => action.type === 'action') as any;
      expect(record.description.pushedCommits).toEqual([COMMIT_2]);
      expect(record.description.descriptionIsComplete).toBe(false);
      expect(impl.storage.gitObjectMetadata.get(COMMIT_1).onRemote).toContain(record.gatekeeperId);
      expect(impl.storage.gitObjectMetadata.get(COMMIT_2).onRemote).not.toContain(record.gatekeeperId);
      expect(impl.storage.gitObjectMetadata.get(COMMIT_2).pendingPush).toContainEqual({gatekeeperId: record.gatekeeperId, actionId: record.id});
      expect(JSON.stringify(result)).not.toContain(pack);
      impl.storage.containsRestrictedData.put(true);
      await expect(impl.applyPendingAction(record, OWNER, false)).rejects.toThrow('sensitive');
      expect(calls).toHaveLength(2);
      impl.storage.containsRestrictedData.put(false);
      pack = btoa('not a Git pack');
      await expect(impl.agentGitOperation(chatId, {action: 'push', branch: 'fix/other', base: 'main'})).rejects.toThrow();
      expect(calls.filter(url => url.includes('/prepare-action'))).toHaveLength(1);
      // A random boundary blob must really fit storage, not just the decoder's inflated limit.
      const blob = new Uint8Array(1048576);
      for (let offset = 0; offset < blob.length; offset += 65536) crypto.getRandomValues(blob.subarray(offset, offset + 65536));
      const encode = (data: Uint8Array) => {
        let binary = '';
        for (let offset = 0; offset < data.length; offset += 32768) binary += String.fromCharCode(...data.subarray(offset, offset + 32768));
        return btoa(binary);
      };
      pack = encode(concatBytes(await buildPackBytes([
        ...FIXTURE_OBJECTS.map(object => ({type: object.type, payload: b64Bytes(object.payload)})), {type: 'blob', payload: blob},
      ])));
      expect((await impl.agentGitOperation(chatId, {action: 'push', branch: 'fix/boundary', base: 'main'})).state).toBe('pending');
      pack = encode(concatBytes(await buildPackBytes([{type: 'blob', payload: new Uint8Array(1048577)}])));
      await expect(impl.agentGitOperation(chatId, {action: 'push', branch: 'fix/oversized', base: 'main'})).rejects.toThrow();
      expect(calls.filter(url => url.includes('/prepare-action'))).toHaveLength(2);
      const retained = await impl.getGatekeeperFacet(record.gatekeeperId);
      impl.ensureAmbientCapsules = async () => {};
      impl.markOutputsDirty = () => {};
      impl.users.get = () => ({whoami: async () => OWNER, getChatContext: async () => ({profile: OWNER}), listGatekeeperVendors: async () => []});
      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      using client = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
      await client.deleteChat(chatId);
      expect(impl.storage.gitObjectMetadata.get(COMMIT_2)?.pendingPush ?? []).toEqual([]);
      expect(impl.storage.gatekeepers.get(record.gatekeeperId)).toBeUndefined();
      expect(impl.storage.actions.get(record.id).state).toBe('rejected');
      try {await retained.status(result.id); throw new Error('Retained private pack');} catch (error) {expect((error as Error).message).toMatch(/Unknown|deleted|reset|broken/i);}


    });
  });

  it('queues enterprise Git writes as owner-scoped Gatekeeper actions and denies Ask, collaborators and sensitive pushes', async () => {
    await withImpl(async (impl, instance) => {
      const chatId = 1;
      impl.storage.chatMeta.put({id: chatId, title: 'Git task', execution: {mode: 'agent', environment: 'rhel10', git: {connectionId: 'owned', repository: 'team/project'}}, started: new Date(), lastActive: new Date()});
      impl.storage.activeAgents.put({chatId, initiatorUserId: OWNER_USER_ID, modelId: 'faux-model', initiator: OWNER, callbackInitiated: false});
      impl.users.get = () => ({getExecutionLaunch: async (selection: {connectionId: string}) => ({environment: 'rhel10', identity: {username: 'owner', uid: 12345, gid: 23456},
        git: {connectionId: selection.connectionId, providerId: 'internal', repository: 'team/project', token: 'private-owner-token'}}),
        getGatekeeperClassFor: async (input: any) => ({class: impl.ctx.exports.AgentGitGatekeeper({props: {ownerId: OWNER_USER_ID, ...input.agentGit, identity: 'test'}})})});
      const calls: any[] = [];
      impl.env = {...impl.env, AETHER_EXECUTION_ENABLED: 'true', AETHER_EXECUTION_TENANT: 'acme',
        AETHER_EXECUTION: {fetch: async (url: string, init: RequestInit) => {
          const request = JSON.parse(String(init.body)); calls.push({url, request}); return Response.json(request.action);
        }}};
      await impl.ctx.storage.put('aether.execution.enabled.1', true);
      const result = await impl.agentGitOperation(chatId, {action: 'pull-request', branch: 'fix/login', base: 'main', title: 'Fix login', body: 'Exact text'});
      expect(result.state).toBe('pending');
      expect(JSON.stringify(result)).not.toContain('private-owner-token');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/prepare-action');
      expect(calls[0].request.git.repository).toBe('team/project');
      expect(calls[0].request.action.branch).toMatch(/^aether\/[a-f0-9]{32}\/fix\/login$/);
      const record = [...impl.storage.actions.list()].find((action: any) => action.type === 'action') as any;
      expect(record.state).toBe('pending');
      expect(record.description).toMatchObject({autoApprovable: false, awaitDecision: true, descriptionIsComplete: true});
      expect(record.description.fields).toContainEqual({kind: 'text', label: 'Body', value: 'Exact text'});
      expect(JSON.stringify(record)).not.toContain('private-owner-token');
      expect(impl.consumeCapturedActions(chatId).awaitDecision).toBe(true);
      const facet = await impl.getGatekeeperFacet(record.gatekeeperId);
      try {await facet.startSession(); throw new Error('Unexpected access');} catch (error) {expect((error as Error).message).toContain('owner-started');}
      try {await facet.addObserver('other'); throw new Error('Unexpected access');} catch (error) {expect((error as Error).message).toContain('owner-only');}
      await expect(impl.applyPendingAction(record, OWNER, true)).rejects.toThrow('owner approval');
      await facet.rejectAction(result.id);
      expect((await impl.agentGitOperation(chatId, {action: 'status', id: result.id})).state).toBe('rejected');
      try {await facet.applyAction(result.id); throw new Error('Unexpected apply');} catch (error) {expect((error as Error).message).toContain('rejected');}
      impl.storage.containsRestrictedData.put(true);
      await expect(impl.agentGitOperation(chatId, {action: 'push', branch: 'fix/login', base: 'main'})).rejects.toThrow('sensitive');
      impl.storage.activeAgents.put({chatId, initiatorUserId: 'collaborator', modelId: 'faux-model', initiator: OWNER, callbackInitiated: false});
      await expect(impl.agentGitOperation(chatId, {action: 'status', id: result.id})).rejects.toThrow('Owner-started');
      const metadata = impl.storage.chatMeta.get(chatId); metadata.execution.mode = 'ask'; impl.storage.chatMeta.put(metadata);
      await expect(impl.agentGitOperation(chatId, {action: 'status', id: result.id})).rejects.toThrow('Owner-started');
      expect(calls).toHaveLength(1);
      metadata.execution.mode = 'agent'; metadata.execution.git.connectionId = 'replacement'; impl.storage.chatMeta.put(metadata);
      impl.storage.activeAgents.put({chatId, initiatorUserId: OWNER_USER_ID, modelId: 'faux-model', initiator: OWNER, callbackInitiated: false});
      await impl.agentGitOperation(chatId, {action: 'pull-request', branch: 'fix/next', base: 'main', title: 'Next fix', body: 'New account scope'});
      const newest = [...impl.storage.actions.list()].filter((action: any) => action.type === 'action').at(-1) as any;
      expect(newest.gatekeeperId).not.toBe(record.gatekeeperId);
      expect(impl.storage.gatekeepers.get(newest.gatekeeperId).creationSpec.connectionId).toBe('replacement');
      const newestFacet = await impl.getGatekeeperFacet(newest.gatekeeperId);
      impl.ensureAmbientCapsules = async () => {};
      impl.markOutputsDirty = () => {};
      impl.users.get = () => ({whoami: async () => OWNER, getChatContext: async () => ({profile: OWNER}), listGatekeeperVendors: async () => []});
      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      using client = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
      await client.deleteChat(chatId);
      expect(impl.storage.gatekeepers.get(record.gatekeeperId)).toBeUndefined();
      expect(impl.storage.gatekeepers.get(newest.gatekeeperId)).toBeUndefined();
      expect(impl.storage.actions.get(newest.id).state).toBe('rejected');
      expect(await impl.ctx.storage.get('aether.execution.gitgatekeeper.1')).toBeUndefined();
      expect(await impl.ctx.storage.get('aether.execution.identity.1')).toBeUndefined();
      expect(await impl.ctx.storage.get('aether.execution.enabled.1')).toBeUndefined();
      try {await newestFacet.status(1); throw new Error('Retained private artifact');} catch (error) {expect((error as Error).message).toMatch(/Unknown|deleted|reset|broken/i);}

    });
  });

  it('offers and executes the real agent tool only for an enabled owner-initiated turn', async () => {
    await withImpl(async impl => {
      const chatId = 1;
      impl.storage.chatMeta.put({id: chatId, title: 'Linux task', execution: {mode: 'agent', environment: 'rhel10'}, started: new Date(), lastActive: new Date()});
      impl.storage.chats.put({chatId, sequence: impl.nextChatSequence(chatId), timestamp: impl.getChatTimestamp(),
        author: OWNER, type: 'message', message: 'Run the repository tests.'});
      const calls: any[] = [];
      impl.env = {...impl.env, AETHER_EXECUTION_ENABLED: 'true', AETHER_EXECUTION_TENANT: 'acme',
        AETHER_EXECUTION: {fetch: async (_url: string, init: RequestInit) => {
          calls.push(JSON.parse(init.body as string)); return Response.json({state: 'ready', output: 'tests passed', exitCode: 0});
        }}};
      await impl.ctx.storage.put('aether.execution.enabled.1', true);
      impl.storage.activeAgents.put({chatId, initiatorUserId: OWNER_USER_ID, modelId: 'faux-model', initiator: OWNER, callbackInitiated: false});
      const offered = await runScriptedTurn(impl, chatId, [
        fauxAssistantMessage([fauxToolCall('workspace', {action: 'exec', command: 'npm test'})]),
        fauxAssistantMessage([fauxToolCall('git_action', {action: 'push'})]),
        fauxAssistantMessage([fauxText('Done')]),
      ]);
      expect(offered[0]).toEqual(['git_action', 'workspace']);
      expect(calls.map(call => call.action)).toEqual(['start', 'exec']);
      expect(calls[0].identity).toEqual({username: 'owner', uid: 12345, gid: 23456});
      expect(toolCalls(impl, chatId).find(call => call.toolName === 'workspace')?.output).toContain('tests passed');
      expect(toolCalls(impl, chatId).find(call => call.toolName === 'git_action')?.error).toContain('Task branch and base required');
      impl.storage.activeAgents.put({chatId, initiatorUserId: 'collaborator', modelId: 'faux-model', initiator: OWNER, callbackInitiated: false});
      expect(await impl.executionWorkspaceEnabled(chatId)).toBe(false);
      await expect(impl.agentWorkspaceOperation(chatId, {action: 'exec', command: 'denied'})).rejects.toThrow('Owner-started');
      await impl.ctx.storage.put('aether.execution.enabled.1', false);
      impl.storage.activeAgents.put({chatId, initiatorUserId: OWNER_USER_ID, modelId: 'faux-model', initiator: OWNER, callbackInitiated: false});
      expect(await impl.executionWorkspaceEnabled(chatId)).toBe(false);
      // A stale grant from a previous Agent turn must not add Linux tools to Ask.
      const metadata = impl.storage.chatMeta.get(chatId);
      metadata.execution = {mode: 'ask', environment: 'rhel10'};
      impl.storage.chatMeta.put(metadata);
      await impl.ctx.storage.put('aether.execution.enabled.1', true);
      impl.storage.chats.put({chatId, sequence: impl.nextChatSequence(chatId), timestamp: impl.getChatTimestamp(), author: OWNER, type: 'message', message: 'Ask a follow-up'});
      const askTools = await runScriptedTurn(impl, chatId, [fauxAssistantMessage([fauxText('Hello')])]);
      expect(askTools[0]).not.toContain('workspace');
      expect(askTools[0]).toContain('executeCode');
      await expect(impl.agentWorkspaceOperation(chatId, {action: 'exec', command: 'denied'})).rejects.toThrow('Owner-started');
    });
  });
});

describe("spawned agent tools", () => {
  it("offers file and worktree tools, but nothing that modifies gadgets or requests connections",
      () => withImpl(async impl => {
    seedGadget(impl);
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: { GADGET: GADGET_ID } });

    let offered = await runScriptedTurn(impl, chatId, [fauxAssistantMessage(fauxText("Done."))]);

    expect(offered).toEqual([[
      "createWorktree", "describeBinding", "editFile", "executeCode", "grep", "observeUserChanges",
      "readFile", "webFetch", "writeFile",
    ]]);
  }));

  it("refuses writes to a gadget and allows them to a worktree it creates",
      () => withImpl(async impl => {
    seedGadget(impl);
    let commit = await commitFiles(impl, { "README.md": "hello\n" });
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: { GADGET: GADGET_ID } });

    await runScriptedTurn(impl, chatId, [
      fauxAssistantMessage([
        fauxToolCall("writeFile", { workpiece: "GADGET", filename: "server.js", content: "x" }),
        fauxToolCall("createWorktree", { title: "Repo", bindingName: "REPO", commitId: commit }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("readFile", { workpiece: "REPO", filename: "README.md" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("editFile",
            { workpiece: "REPO", filename: "README.md", textToReplace: "hello", replacement: "bye" }),
        fauxToolCall("writeFile", { workpiece: "REPO", filename: "NEW.md", content: "new\n" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let calls = toolCalls(impl, chatId);
    let gadgetWrite = calls.find(call =>
        call.toolName === "writeFile" && call.input.workpiece === "GADGET");
    expect(gadgetWrite?.error).toMatch(/do not have permission to edit this gadget's code/);
    for (let call of calls.filter(call => call !== gadgetWrite)) {
      expect(call.error, `${call.toolName} failed`).toBeUndefined();
    }

    // The only proposed changes are the worktree's: the gadget was never pinned or modified.
    let worktreeId = calls.find(call => call.toolName === "createWorktree")!.output.worktreeId;
    let touched = new Set(([...impl.storage.chats.list()] as AiChatMessage[])
        .filter(msg => msg.chatId === chatId && msg.type === "changes")
        .flatMap(msg => msg.type === "changes" && msg.change ? Object.keys(msg.change) : []));
    expect(touched).toEqual(new Set([`${worktreeId}`]));
    expect(impl.getChatAgentContext(chatId).spawnerConfig).toBeDefined();
  }));

  it("greps a worktree before its first modification pins it, and after",
      () => withImpl(async impl => {
    seedGadget(impl);
    let commit = await commitFiles(impl,
        { "README.md": "hello\n", "src/util.js": "export let answer = 42;\n" });
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: { GADGET: GADGET_ID } });

    await runScriptedTurn(impl, chatId, [
      fauxAssistantMessage([
        fauxToolCall("createWorktree", { title: "Repo", bindingName: "REPO", commitId: commit }),
      ], { stopReason: "toolUse" }),
      // Unpinned: the search resolves against the accepted commit.
      fauxAssistantMessage([
        fauxToolCall("grep", { workpiece: "REPO", pattern: "answer", path: "src" }),
        fauxToolCall("grep", { workpiece: "REPO", pattern: "hello", path: "README.md" }),
        fauxToolCall("grep", { workpiece: "REPO", pattern: "answer|hello" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("writeFile",
            { workpiece: "REPO", filename: "src/new.js", content: "let answer = 43;\n" }),
      ], { stopReason: "toolUse" }),
      // Pinned by the write: the search sees the overlay over the same base.
      fauxAssistantMessage([
        fauxToolCall("grep", { workpiece: "REPO", pattern: "answer", path: "src" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let calls = toolCalls(impl, chatId);
    for (let call of calls) {
      expect(call.error, `${call.toolName} failed`).toBeUndefined();
    }
    expect(calls.filter(call => call.toolName === "grep").map(call => call.output)).toEqual([
      "src/util.js:1:export let answer = 42;",
      "1:hello",
      "README.md:1:hello\nsrc/util.js:1:export let answer = 42;",
      "src/new.js:1:let answer = 43;\nsrc/util.js:1:export let answer = 42;",
    ]);
  }));

  it("tells an edit of a missing file apart from an edit of an unread one",
      () => withImpl(async impl => {
    let commit = await commitFiles(impl, { "README.md": "hello\n" });
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: {} });
    let edit = { workpiece: "REPO", textToReplace: "hello", replacement: "bye" };

    await runScriptedTurn(impl, chatId, [
      fauxAssistantMessage([
        fauxToolCall("createWorktree", { title: "Repo", bindingName: "REPO", commitId: commit }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("editFile", { ...edit, filename: "README.md" }),
        fauxToolCall("editFile", { ...edit, filename: "REPO/README.md" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let [unread, missing] = toolCalls(impl, chatId).filter(call => call.toolName === "editFile");
    expect(unread.error).toMatch(/must read a file/);
    expect(missing.error).toMatch(/has no file named "REPO\/README\.md"/);
  }));

  it("refuses a new binding named GIT, which would shadow env.GIT",
      () => withImpl(async impl => {
    let commit = await commitFiles(impl, { "README.md": "hello\n" });
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: {} });

    await runScriptedTurn(impl, chatId, [
      fauxAssistantMessage([
        fauxToolCall("createWorktree", { title: "Repo", bindingName: "GIT", commitId: commit }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let [call] = toolCalls(impl, chatId);
    expect(call.error).toMatch(/already a binding named "GIT"/);
    expect([...impl.storage.gadgets.list()].filter((record: any) => record.type === "worktree"))
        .toEqual([]);
  }));

  it("attributes the spawned turn to the gadget, with the creator's commit email",
      () => withImpl(async impl => {
    let creator = { ...OWNER, commitEmail: "owner@commits.example" };
    impl.users.get = () => ({ getChatContext: async () => ({ profile: creator }) });
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: {} });

    let [prompt] = ([...impl.storage.chats.list()] as AiChatMessage[])
        .filter(msg => msg.chatId === chatId);
    expect(prompt.author).toEqual({
      type: "gadget", id: OWNER.id, name: impl.storage.title.get(),
      commitEmail: "owner@commits.example",
    });
  }));

  it("still offers regular chats the full tool set", () => withImpl(async impl => {
    impl.storage.chatMeta.put(
        { id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    impl.storage.chats.put({
      chatId: 1, sequence: impl.nextChatSequence(1), timestamp: new Date(0), author: OWNER,
      type: "message", message: "Hi",
    });

    let offered = await runScriptedTurn(impl, 1, [fauxAssistantMessage(fauxText("Hello."))]);

    expect(offered[0]).toEqual(expect.arrayContaining(
        ["createGadget", "setGadgetBinding", "listBlueprints", "listConnectableResources",
         "requestConnection"]));
  }));
});
