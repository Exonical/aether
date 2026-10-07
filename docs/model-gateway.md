# On-prem model gateway

A tenant workspace can send inference to **one user-provided endpoint** through a private loopback adapter. Aether does not install a model server or require an external cloud service. OpenAI-compatible Chat Completions and Responses, and Anthropic Messages, are supported transport routes. Your endpoint must implement the selected protocol, including the streaming events expected by the upstream SDK.

## Build and run

Enable model transport when building the tenant artifact:

```sh
AETHER_TENANT_ID=acme AETHER_MODEL_GATEWAY=true npm run workspace:build --prefix runtime
```

This includes the model transport in all four storage configurations. Default builds retain denied outbound networking. The artifact manifest records `modelGateway`; storage choices and permanent tenant identities are unchanged. Build a separate artifact for each tenant.

Start the adapter alongside workerd, in the same pod or host network namespace. Use your own deployment credentials:

```sh
export AETHER_TENANT_ID=acme
export AETHER_MODEL_ENDPOINT=https://models.inference.example/v1
export AETHER_MODEL_PROTOCOL=openai
export AETHER_MODEL_ALLOWLIST='["your-model-id"]'
# Supply AETHER_MODEL_TOKEN through your secret management system if needed.
npm start --prefix runtime/models
```

In another terminal, run `AETHER_TENANT_ID=acme npm run workspace:start --prefix runtime`. The launcher uses loopback port 9003, or `AETHER_MODEL_PORT` when overridden in both processes. There is no public adapter Service or pod port.

## Configure a Workshop model

In the Workshop's model settings, set the API URL to the **same endpoint** and the exact allowed model ID. Keep the provider token empty or use a placeholder: the adapter discards caller credentials and injects the deployment token. Never put the deployment token in Workshop settings.

| Endpoint protocol | Workshop provider | Adapter setting | Allowed routes relative to endpoint |
| --- | --- | --- | --- |
| OpenAI Chat Completions | Ollama compatibility option in the pinned upstream | `openai` | `/chat/completions` |
| OpenAI Responses | OpenAI | `openai` | `/responses` |
| Anthropic Messages | Anthropic | `anthropic` | `/messages` |

For Chat Completions, use a base ending in `/v1`; the pinned Ollama compatibility path strips `/api` or `/v1`, then appends `/v1`. Its label reflects the upstream UI; the adapter itself supports compatible on-prem gateways. No model catalog discovery endpoint is exposed. Google, Workers AI, cloud billing gateways, and arbitrary web fetching remain unavailable.

## Configuration

| Variable | Purpose |
| --- | --- |
| `AETHER_TENANT_ID` | Required tenant slug; must match the workspace artifact/deployment |
| `AETHER_MODEL_ENDPOINT` | Required HTTP(S) API base with optional path, no userinfo, query or fragment |
| `AETHER_MODEL_ALLOWLIST` | Required JSON array of allowed model IDs |
| `AETHER_MODEL_PROTOCOL` | `openai` (default) or `anthropic` |
| `AETHER_MODEL_TOKEN` | Optional deployment credential; Bearer for OpenAI, `x-api-key` for Anthropic |
| `AETHER_MODEL_CA_FILE` | Optional PEM CA bundle path for private PKI; certificate and hostname verification stay enabled |
| `AETHER_MODEL_ALLOW_HTTP` | `true` explicitly permits plaintext HTTP for an endpoint you trust |
| `AETHER_MODEL_PORT` | Private loopback listener, default 9003 |

Each tenant needs its own endpoint credential and adapter configuration. A shared model gateway must enforce tenant quotas and isolation for these credentials. The adapter does not provide user quotas, billing, model provisioning, or a tenant control plane.

## Kubernetes with Cilium Gateway API

Build and push the model-enabled workspace image and adapter image:

```sh
docker build -f runtime/Dockerfile.workspace -t registry.example.com/aether/workspace:0.5.0-acme runtime
docker build -f runtime/models/Dockerfile -t registry.example.com/aether/model-gateway:0.1.0 runtime/models
```

Create `aether-models` in namespace `aether-acme` containing the endpoint, protocol, allowlist, and optional token variables above. Keep the default loopback port for these manifests. For private PKI, mount a Secret or ConfigMap containing the PEM bundle and set `AETHER_MODEL_CA_FILE` to its mounted path.

Customize the registry, tenant, storage class, PostgreSQL/S3 credentials, Gateway hostname/TLS Secret, and exact model hostname/port in `deploy/kubernetes/overlays/workspace-models`. It extends the PostgreSQL + S3 Gateway overlay and adds only the private adapter and model egress rule. For an in-cluster gateway, replace `toFQDNs` with a `toEndpoints` selector for that gateway's namespace and pod labels. Cilium applies egress at pod scope, so the sidecar shares the pod's permitted PostgreSQL/S3 destinations; its application code still connects only to the configured model endpoint.

```sh
kubectl kustomize deploy/kubernetes/overlays/workspace-models
kubectl apply -k deploy/kubernetes/overlays/workspace-models
```

The adapter health probe verifies process/configuration startup, not remote inference availability. Gateway API remains the public entry point. No Ingress is installed.

## Boundaries and validation

Only the trusted Workshop backend receives a scoped global outbound service. Router, Gatekeepers, storage Workers, and assets retain denied ambient network access. Generated Gadgets retain upstream `globalOutbound: null`; model capabilities call back into trusted Workshop code. The proxy accepts only POST JSON on the exact configured origin and allowed inference paths, rejects queries and redirects, checks the JSON model ID, and forwards no caller cookies or credentials. Responses are streamed with backpressure; non-success provider bodies are replaced with generic errors. Responses requests always set `store: false`, and retrieval/deletion APIs are denied. This does not override retention policy at your model service.

Limits are 8 MiB per inference body, four concurrent requests per tenant pod, a 30-second incoming request deadline, and a 180-second total inference deadline. Capacity exhaustion returns 429. Provider failures propagate a sanitized status/error; prompts, credentials, URLs, and provider error bodies are not logged. Requests canceled by the client close the provider connection.

`npm test --prefix runtime/models` exercises real workerd transport, streaming, destination/model denial, credential replacement, oversized input, private CA verification, and denied Gadget fetch. After installing upstream dependencies and building the workspace, `AETHER_TEST_MODEL_SDK=true npm test --prefix runtime/models` also bundles the pinned upstream model implementation and completes a Chat Completions call inside workerd against a synthetic provider. CI runs both and builds the read-only adapter image. These fixtures do not validate a real model server's tool calling, agent quality, or cluster rollout. Browser rendering, replicated Durable Objects, and R2 metadata migration remain future work.
