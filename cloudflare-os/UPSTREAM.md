# Cloudflare OS source provenance

Aether maintains this directory as a source fork of
[Cloudflare OS](https://github.com/cloudflare/cloudflare-os), rather than a Git
submodule. Changes here are ordinary Aether commits and are included in normal
clones, archives and pull requests.

Initial import:

- Repository: `https://github.com/cloudflare/cloudflare-os.git`
- Revision: `4358072f8cb1bc9ddfb6ee11122e194c76cd71e0`
- Source tree: `bab43ff1ec8e2dbc6285c97f07d01e72182cdc4e`
- Import date: 2026-10-08 UTC
- License: Apache-2.0; the original `LICENSE` and source notices are retained.

All tracked upstream files were imported without content changes. This provenance
file is the only addition within the directory at import. Upstream Git history
is not embedded; use the source repository and revision above to inspect it.

The existing directory layout, package names, separate pnpm workspace and runtime
build paths remain intact. Aether's on-prem runtime, OIDC and department sharing
integrations remain outside this directory for now. Their build-time patches are
unchanged by this import.

Future product changes can modify this source directly. Review upstream updates
on feature branches, preserving Aether changes and updating this record when the
import baseline advances. Follow the [upgrade checklist](../docs/customization.md#upgrade).

## Existing checkout migration

Before pulling the conversion, save any local changes inside the old submodule.
Move its `cloudflare-os` directory to a backup location outside the checkout,
then pull the Aether branch containing the import. Git creates a regular source
directory; submodule initialization and updates are no longer needed.

Reinstall the fork workspace dependencies after updating source:

```sh
pnpm --dir cloudflare-os install --frozen-lockfile --pm-on-fail=ignore
```

Keep the backup until local changes have been transferred and the build succeeds.
