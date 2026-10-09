import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateSnapshot, collectSnapshot} from './on-prem.mjs';

const conditions = types => types.map(type => ({type, status: 'True', observedGeneration: 2}));
function fixture() {
  const variables = {AETHER_TENANT_ID: 'acme', AETHER_EXECUTION_RUNTIME_CLASS: 'kata', AETHER_DEPARTMENTS: 'true',
    AETHER_EXECUTION_ENABLED: 'true', AETHER_EXECUTION_GIT_WRITES: 'true',
    AETHER_EXECUTION_GIT_PROVIDERS: JSON.stringify([{kind: 'gitlab', url: 'https://git.internal'}])};
  return {
    statefulset: {metadata: {generation: 2}, spec: {replicas: 1, template: {spec: {containers:
      ['workerd', 'oidc-adapter', 'postgres-adapter', 's3-adapter', 'models-adapter', 'execution-manager'].map(containerName =>
        ({name: containerName, env: Object.entries(variables).map(([name, value]) => ({name, value}))}))}}}, status: {readyReplicas: 1, observedGeneration: 2}},
    runtimeClass: {metadata: {name: 'kata'}, handler: 'kata-qemu'},
    policy: {spec: {endpointSelector: {matchLabels: {'aether.dev/execution': 'acme'}}, ingress: [{}], egress: [{}]}},
    route: {metadata: {namespace: 'app', generation: 2}, spec: {parentRefs: [{name: 'shared', namespace: 'gateways', sectionName: 'https'}]},
      status: {parents: [{parentRef: {name: 'shared', namespace: 'gateways', sectionName: 'https'}, conditions: conditions(['Accepted', 'ResolvedRefs'])}]}},
    gateways: [{metadata: {name: 'shared', generation: 2}, spec: {gatewayClassName: 'cilium'}, status: {conditions: conditions(['Accepted', 'Programmed'])}}],
    classes: [{metadata: {name: 'cilium', generation: 2}, spec: {controllerName: 'io.cilium/gateway-controller'}, status: {conditions: conditions(['Accepted'])}}],
  };
}
test('preflight distinguishes ready deployment from live acceptance', () => {
  const result = validateSnapshot(fixture());
  assert.equal(result.passed, true);
  assert.match(result.liveAcceptance, /NOT RUN/);
});
test('preflight refuses stale status, missing adapters and wrong runtime, tenant or Gateway', () => {
  for (const change of [
    s => {s.statefulset.status.observedGeneration = 1;},
    s => {s.statefulset.spec.template.spec.containers.splice(1, 1);},
    s => {s.runtimeClass.handler = 'runc';},
    s => {s.policy.spec.endpointSelector.matchLabels['aether.dev/execution'] = 'other';},
    s => {s.route.status.parents[0].conditions[0].observedGeneration = 1;},
    s => {s.route.status.parents[0].parentRef.namespace = 'other';},
    s => {s.route.status.parents[0].parentRef.sectionName = 'http';},
    s => {s.gateways[0].status.conditions[1].status = 'False';},
    s => {s.classes[0].spec.controllerName = 'other-controller';},
    s => {s.statefulset.spec.template.spec.containers.at(-1).env.find(e => e.name === 'AETHER_EXECUTION_GIT_PROVIDERS').value = '[{"kind":"gitlab","url":"https://gitlab.com"}]';},
  ]) {
    const snapshot = fixture(); change(snapshot);
    assert.equal(validateSnapshot(snapshot).passed, false);
  }
});
test('collector queries shared Gateway namespace without reading credentials or mutating cluster', () => {
  const s = fixture(), calls = [];
  const get = (kind, name, namespace) => {
    calls.push({kind, name, namespace});
    return ({statefulset: s.statefulset, httproute: s.route, gateway: s.gateways[0], gatewayclass: s.classes[0],
      runtimeclass: s.runtimeClass, ciliumnetworkpolicy: s.policy})[kind];
  };
  assert.equal(validateSnapshot(collectSnapshot(get, 'app', 'validation-aether')).passed, true);
  assert.deepEqual(calls.find(c => c.kind === 'gateway'), {kind: 'gateway', name: 'shared', namespace: 'gateways'});
  assert.equal(calls.some(c => c.kind === 'secret'), false);
});
