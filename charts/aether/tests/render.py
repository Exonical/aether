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
    if "tenants" not in values:
        values = {"tenants": [{"namespace": "aether-" + values.get("tenantId", "test"), **values}]}
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
assert route["spec"]["parentRefs"] == [{"name": "acme-acme-aether", "sectionName": "https"}]
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
# A single release installs two complete, isolated tenants.
sets = [d for d in prod if d["kind"] == "StatefulSet"]
assert {d["metadata"]["namespace"] for d in sets} == {"aether-acme", "aether-beta"}
assert len(sets) == 2
assert len([d for d in prod if d["kind"] == "Namespace"]) == 2
assert all(d["metadata"]["annotations"]["helm.sh/resource-policy"] == "keep" for d in prod if d["kind"] == "Namespace")
for d in prod:
    if d["kind"] != "Namespace":
        assert d["metadata"]["namespace"] in {"aether-acme", "aether-beta"}
for bad in [
    {"tenants": []},
    {"tenants": [{"tenantId": "acme", "namespace": "aether-acme"}] * 2},
    {"tenants": [{"tenantId": "acme", "namespace": "shared"}, {"tenantId": "beta", "namespace": "shared"}]},
    {"tenants": [{"tenantId": "acme", "namespace": "kube-system"}]},
    {"tenants": [{"tenantId": "acme", "namespace": "aether-system"}]},
]:
    render(bad, valid=False)
common = render({"runtimeClassName": "", "tenants": [{"tenantId": "acme", "namespace": "aether-acme"}]})
assert "runtimeClassName" not in state(common)["spec"]["template"]["spec"]
long = state(render({"tenantId": "a" * 63, "namespace": "long-tenant"}, "r" * 53))
assert len(long["spec"]["selector"]["matchLabels"]["app.kubernetes.io/instance"]) <= 63
print("Helm chart contracts passed: 16 feature combinations, production/shared Gateway, isolation, storage and invalid values")
