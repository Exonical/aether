"""Chart contract checks. Requires helm and PyYAML; no cluster or credentials."""
import itertools
import os
from pathlib import Path
import subprocess
import tempfile
import yaml

CHART = Path(__file__).resolve().parents[1]
HELM = os.environ.get("HELM", "helm")


def render(values, release="acme", valid=True):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml") as f:
        yaml.safe_dump(values, f)
        f.flush()
        result = subprocess.run([HELM, "template", release, str(CHART), "-n", "aether-system", "-f", f.name],
                                capture_output=True, text=True)
    if not valid:
        assert result.returncode != 0, values
        return
    assert result.returncode == 0, result.stderr
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def state(docs):
    return next(d for d in docs if d["kind"] == "StatefulSet")


for flags in itertools.product([False, True], repeat=4):
    values = {"tenantId": "acme", "nodeSelector": {"kubernetes.io/os": "linux"}}
    for key, enabled in zip(["postgres", "s3", "models", "oidc"], flags):
        values[key] = {"enabled": enabled, "existingSecret": "test-" + key,
                       "egress": [{"toFQDNs": [{"matchName": key + ".example"}]}],
                       "ca": {"secretName": "test-ca"}}
    values["oidc"]["publicUrl"] = "https://acme.example"
    docs = render(values)
    st = state(docs)
    assert st["spec"]["replicas"] == 1
    assert st["spec"]["persistentVolumeClaimRetentionPolicy"]["whenDeleted"] == "Retain"
    pod = st["spec"]["template"]["spec"]
    assert pod["runtimeClassName"] == "kata"
    assert pod["automountServiceAccountToken"] is False
    containers = pod["containers"]
    artifact = "workspace" + ("-postgres" if flags[0] else "") + ("-s3" if flags[1] else "")
    assert containers[0]["args"][1] == "/opt/aether/" + artifact + ".capnp.bin"
    assert len(containers) == 1 + sum(flags)
    assert not containers[0].get("envFrom")
    for container in containers:
        assert container["securityContext"]["readOnlyRootFilesystem"] is True
        if container["name"] != "workerd":
            assert "ports" not in container
            assert container["volumeMounts"][0]["readOnly"] is True
            assert container["envFrom"][0]["secretRef"]["name"].startswith("test-")
    for service in (d for d in docs if d["kind"] == "Service"):
        assert service["spec"]["selector"] == st["spec"]["selector"]["matchLabels"]
        assert [p["port"] for p in service["spec"]["ports"]] == [8080]
    net = next(d for d in docs if d["kind"] == "NetworkPolicy")
    assert net["spec"]["egress"] == [] and net["spec"]["ingress"] == []
    if any(flags):
        cilium = next(d for d in docs if d["kind"] == "CiliumNetworkPolicy")
        assert cilium["spec"]["egress"][0]["toPorts"][0]["rules"]["dns"]

prod = render(yaml.safe_load((CHART / "examples/production.yaml").read_text()))
assert not any(d["kind"] in ["Ingress", "Secret"] for d in prod)
route = next(d for d in prod if d["kind"] == "HTTPRoute")
assert route["spec"]["parentRefs"] == [{"name": "acme-aether", "sectionName": "https"}]
other = render({"tenantId": "other"}, "other")
assert state(prod)["spec"]["selector"] != state(other)["spec"]["selector"]
shared = render({"tenantId": "acme", "gateway": {"enabled": True, "create": False,
    "hostname": "acme.example", "parentRefs": [{"name": "shared", "namespace": "edge", "sectionName": "https"}]}})
assert not any(d["kind"] == "Gateway" for d in shared)
assert next(d for d in shared if d["kind"] == "HTTPRoute")["spec"]["parentRefs"][0]["namespace"] == "edge"
custom = state(render({"tenantId": "acme", "runtimeClassName": "", "persistence": {"storageClassName": ""},
                      "image": {"digest": "sha256:" + "a" * 64}}))
assert "runtimeClassName" not in custom["spec"]["template"]["spec"]
assert custom["spec"]["volumeClaimTemplates"][0]["spec"]["storageClassName"] == ""
assert "@sha256:" in custom["spec"]["template"]["spec"]["containers"][0]["image"]
for bad in [{}, {"tenantId": "Bad"}, {"tenantId": "acme", "replicas": 2},
            {"tenantId": "acme", "s3": {"enabled": True}},
            {"tenantId": "acme", "s3": {"enabled": True, "existingSecret": "s3"}},
            {"tenantId": "acme", "gateway": {"enabled": True}},
            {"tenantId": "acme", "gateway": {"enabled": True, "create": False, "hostname": "acme.example"}},
            {"tenantId": "acme", "oidc": {"sessionTtl": 1}},
            {"tenantId": "acme", "oidc": {"publicUrl": "http://acme.example"}}]:
    render(bad, valid=False)
# Department configuration remains one shared app, not additional deployments.
assert len([d for d in prod if d["kind"] == "StatefulSet"]) == 1
assert not any(d["kind"] == "Namespace" for d in prod)
assert all(d["metadata"]["namespace"] == "aether-system" for d in prod)
assert {e["name"]:e["value"] for e in state(prod)["spec"]["template"]["spec"]["containers"][0]["env"]}["AETHER_DEPARTMENTS"] == "true"
render({"tenantId":"acme","departments":{"enabled":True}},valid=False)
render({"tenants":[{"tenantId":"acme","namespace":"aether-acme"}]},valid=False)
long=state(render({"tenantId":"a"*63},"r"*53))
assert len(long["spec"]["selector"]["matchLabels"]["app.kubernetes.io/instance"])<=63
print("Shared application chart: 16 adapter combinations, Gateway, storage, Secrets, departments and invalid settings passed")

# Linux workspace controller credentials are mounted only in its sidecar.
execution_values = {"tenantId": "acme", "departments": {"enabled": True},
                    "oidc": {"enabled": True, "existingSecret": "oidc", "publicUrl": "https://acme.example", "egress": [{"toFQDNs": [{"matchName": "idp.example"}]}]},
                    "execution": {"enabled": True}}
docs = render(execution_values)
pod = state(docs)["spec"]["template"]["spec"]
assert pod["automountServiceAccountToken"] is False
manager = next(c for c in pod["containers"] if c["name"] == "execution-manager")
assert manager["securityContext"]["readOnlyRootFilesystem"] is True
assert {e["name"]: e["value"] for e in manager["env"]}["AETHER_EXECUTION_IDLE_TIMEOUT_SECONDS"] == "1800"
assert any(m["name"] == "execution-kubernetes" for m in manager["volumeMounts"])
assert not any(m["name"] == "execution-kubernetes" for c in pod["containers"] if c["name"] != "execution-manager" for m in c.get("volumeMounts", []))
role = next(d for d in docs if d["kind"] == "Role")
assert all("secrets" not in r["resources"] and "pods/exec" not in r["resources"] for r in role["rules"])
assert next(r for r in role["rules"] if r["resources"] == ["pods"])["verbs"] == ["get", "list", "create", "patch", "delete"]
assert not any(d["kind"] == "ClusterRole" for d in docs)
render({"tenantId": "acme", "execution": {"enabled": True}}, valid=False)
print("Execution controller, namespace RBAC, projected credentials and policy checks passed")

for timeout in [0, 300, 604800]:
    configured = {**execution_values, "execution": {"enabled": True, "idleTimeoutSeconds": timeout}}
    manager = next(c for c in state(render(configured))["spec"]["template"]["spec"]["containers"] if c["name"] == "execution-manager")
    assert {e["name"]: e["value"] for e in manager["env"]}["AETHER_EXECUTION_IDLE_TIMEOUT_SECONDS"] == str(timeout)
for timeout in [-1, 604801, 0.5, "1800", None]:
    render({**execution_values, "execution": {"enabled": True, "idleTimeoutSeconds": timeout}}, valid=False)
print("Idle suspension defaults, overrides, disabling and invalid settings passed")

execution_values["execution"]["git"] = {"providers": [{"id": "internal", "label": "Internal GitLab", "kind": "gitlab", "url": "https://git.internal"}], "ca": {"secretName": "git-ca"}, "oauth": {"existingSecret": "git-oauth", "key": "oauth.json"}}
docs = render(execution_values)
pod = state(docs)["spec"]["template"]["spec"]
manager = next(c for c in pod["containers"] if c["name"] == "execution-manager")
assert any(m["name"] == "execution-git-ca" for m in manager["volumeMounts"])
assert any(m["name"] == "execution-git-oauth" and m["readOnly"] for m in manager["volumeMounts"])
assert {e["name"]: e["value"] for e in manager["env"]}["AETHER_EXECUTION_PUBLIC_URL"] == "https://acme.example"
assert {e["name"]: e["value"] for e in manager["env"]}["AETHER_EXECUTION_GIT_OAUTH_FILE"] == "/etc/aether-git-oauth/clients.json"
assert next(v for v in pod["volumes"] if v["name"] == "execution-git-oauth")["secret"] == {"secretName": "git-oauth", "items": [{"key": "oauth.json", "path": "clients.json"}]}
assert not any(m["name"] == "execution-git-oauth" for c in pod["containers"] if c["name"] != "execution-manager" for m in c.get("volumeMounts", []))
assert not any(m["name"] == "execution-git-ca" for c in pod["containers"] if c["name"] != "execution-manager" for m in c.get("volumeMounts", []))
broker = next(d for d in docs if d["kind"] == "Service" and d["metadata"]["name"].endswith("execution-git"))
assert broker["spec"].get("type", "ClusterIP") == "ClusterIP"
assert broker["spec"]["ports"][0]["port"] == 9007
execution_values["execution"]["runtimeClassName"] = ""
render(execution_values, valid=False)
print("Private Git broker, provider configuration, CA isolation and required RuntimeClass checks passed")

# Agent shell egress cannot bypass the private Git capability broker, including through DNS.
execution_values['execution']['runtimeClassName'] = 'kata'
docs = render(execution_values)
policy = next(d for d in docs if d['kind'] == 'CiliumNetworkPolicy' and d['metadata']['name'].endswith('execution-workspaces'))
assert len(policy['spec']['egress']) == 2
assert policy['spec']['egress'][0]['toPorts'][0]['ports'] == [{'port': '9007', 'protocol': 'TCP'}]
dns = policy['spec']['egress'][1]['toPorts'][0]['rules']['dns']
assert len(dns) == 1 and dns[0]['matchName'].endswith('-execution-git.aether-system.svc.cluster.local')
assert not any('toFQDNs' in rule or 'toEntities' in rule for rule in policy['spec']['egress'])
render({**execution_values, 'networkPolicy': {'enabled': False}}, valid=False)
render({**execution_values, 'execution': {**execution_values['execution'], 'egress': [{'toEntities': ['world']}]}}, valid=False)
execution_values['execution']['git']['allowWrites'] = True
manager = next(c for c in state(render(execution_values))['spec']['template']['spec']['containers'] if c['name'] == 'execution-manager')
assert {e['name']:e['value'] for e in manager['env']}['AETHER_EXECUTION_GIT_WRITES'] == 'true'
assert any(m['name'] == 'execution-git-tmp' for m in manager['volumeMounts'])
print('Agent write opt-in, private controller scratch, broker-only egress and DNS bypass rejection passed')
