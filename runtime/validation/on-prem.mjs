import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const condition = (object, type) => object?.status?.conditions?.some(c => c.type === type && c.status === 'True'
  && c.observedGeneration === object.metadata?.generation);
const env = (container, name) => container?.env?.find(e => e.name === name)?.value;

/** Readiness checks only. Interactive security acceptance is recorded separately. */
export function validateSnapshot({statefulset, route, policy, runtimeClass, gateways, classes}) {
  const checks = [];
  const check = (name, passed) => checks.push({name, passed: Boolean(passed)});
  const containers = statefulset.spec?.template?.spec?.containers ?? [];
  const manager = containers.find(c => c.name === 'execution-manager');
  const workerd = containers.find(c => c.name === 'workerd');
  check('single application replica ready at current generation', statefulset.spec?.replicas === 1
    && statefulset.status?.readyReplicas === 1 && statefulset.status?.updatedReplicas === 1
    && Boolean(statefulset.status?.updateRevision) && statefulset.status?.currentRevision === statefulset.status?.updateRevision && statefulset.status?.observedGeneration === statefulset.metadata?.generation);
  for (const name of ['workerd', 'oidc-adapter', 'postgres-adapter', 's3-adapter', 'models-adapter', 'execution-manager']) {
    check(`${name} container configured`, containers.some(c => c.name === name));
  }
  check('departments and agent execution enabled', env(workerd, 'AETHER_DEPARTMENTS') === 'true'
    && env(workerd, 'AETHER_EXECUTION_ENABLED') === 'true');
  check('Git publishing enabled for approval acceptance', env(manager, 'AETHER_EXECUTION_GIT_WRITES') === 'true');
  let providers = [];
  try {providers = JSON.parse(env(manager, 'AETHER_EXECUTION_GIT_PROVIDERS') ?? '[]');} catch { /* Failed check below. */ }
  check('enterprise Git provider configured', Array.isArray(providers) && providers.length > 0 && providers.every(p => {
    try {const url = new URL(p.url); return ['gitlab', 'github'].includes(p.kind) && url.protocol === 'https:'
      && !url.username && !url.password && !['github.com', 'gitlab.com'].includes(url.hostname);} catch {return false;}
  }));
  check('configured RuntimeClass uses Kata handler', runtimeClass?.metadata?.name === env(manager, 'AETHER_EXECUTION_RUNTIME_CLASS')
    && /kata/i.test(runtimeClass?.handler ?? ''));
  check('workspace Cilium policy scoped to deployment tenant', policy?.spec?.endpointSelector?.matchLabels?.['aether.dev/execution'] === env(manager, 'AETHER_TENANT_ID')
    && Boolean(env(manager, 'AETHER_TENANT_ID')) && policy.spec?.ingress?.length > 0 && policy.spec?.egress?.length > 0);
  const parents = route?.spec?.parentRefs ?? [];
  check('HTTPRoute has current accepted and resolved Gateway parents', parents.length > 0 && parents.every(ref =>
    route.status?.parents?.some(p => p.parentRef.name === ref.name
      && (p.parentRef.namespace ?? route.metadata.namespace) === (ref.namespace ?? route.metadata.namespace)
      && p.parentRef.sectionName === ref.sectionName
      && ['Accepted', 'ResolvedRefs'].every(type => p.conditions?.some(c => c.type === type && c.status === 'True'
        && c.observedGeneration === route.metadata.generation)))));
  check('all parent Gateways programmed by Cilium', gateways.length === parents.length && gateways.every(g =>
    condition(g, 'Accepted') && condition(g, 'Programmed') && classes.some(c => c.metadata.name === g.spec.gatewayClassName
      && /cilium/i.test(c.spec.controllerName) && condition(c, 'Accepted'))));
  return {passed: checks.every(c => c.passed), checks,
    liveAcceptance: 'NOT RUN: follow docs/on-prem-acceptance.md for identity, isolation, publishing and revocation'};
}

export function collectSnapshot(get, namespace, name) {
  const statefulset = get('statefulset', name, namespace);
  const manager = statefulset.spec?.template?.spec?.containers?.find(c => c.name === 'execution-manager');
  const runtime = env(manager, 'AETHER_EXECUTION_RUNTIME_CLASS');
  if (!runtime) throw new Error('Execution manager RuntimeClass is not configured');
  const route = get('httproute', name, namespace);
  const gateways = (route.spec?.parentRefs ?? []).map(ref => get('gateway', ref.name, ref.namespace ?? namespace));
  const classes = [...new Set(gateways.map(g => g.spec.gatewayClassName))].map(n => get('gatewayclass', n));
  return {statefulset, route, gateways, classes, runtimeClass: get('runtimeclass', runtime),
    policy: get('ciliumnetworkpolicy', `${name}-execution-workspaces`, namespace)};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--context', '--namespace', '--name'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Usage: node runtime/validation/on-prem.mjs --context CONTEXT --namespace NAMESPACE --name STATEFULSET');
      options[args[i]] = args[i + 1];
    }
    if (!options['--context'] || !options['--namespace'] || !options['--name']) throw new Error('Explicit context, namespace and deployed StatefulSet name are required');
    const get = (kind, name, namespace) => {
      const command = ['--context', options['--context'], '--request-timeout=20s', ...(namespace ? ['-n', namespace] : []), 'get', kind, name, '-o', 'json'];
      try {return JSON.parse(execFileSync('kubectl', command, {encoding: 'utf8', timeout: 25000, maxBuffer: 8388608, stdio: ['ignore', 'pipe', 'pipe']}));}
      catch {throw new Error(`Unable to read ${kind}/${name}; check context, RBAC and deployment readiness`);}
    };
    const result = validateSnapshot(collectSnapshot(get, options['--namespace'], options['--name']));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
