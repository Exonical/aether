using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = (
      compatibilityDate = "2026-09-04",
      modules = [(name = "gateway.js", esModule = embed "src/gateway.js")],
      bindings = [(name = "CORE", service = "core")]
    )),
    (name = "core", worker = (
      compatibilityDate = "2026-09-04",
      modules = [(name = "core.js", esModule = embed "src/core.js")],
      bindings = [
        (name = "LOADER", workerLoader = ()),
        (name = "STATE", durableObjectNamespace = "RuntimeState")
      ],
      durableObjectNamespaces = [(
        className = "RuntimeState",
        # Permanent namespace identity: preserve this and the disk together on upgrades.
        uniqueKey = "aether-runtime-state-81fb6322-9372-47b8-8c23-a0e33c1a73b9",
        enableSql = true
      )],
      durableObjectStorage = (localDisk = "state")
    )),
    # No ambient network access, including workerd's implicit public internet service.
    (name = "internet", network = (allow = [])),
    # Supplied by --directory-path; never exposed through an HTTP socket or binding.
    (name = "state", disk = (writable = true))
  ],
  sockets = [(name = "http", http = (), service = "gateway")]
);
