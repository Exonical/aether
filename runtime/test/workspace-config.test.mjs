import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkerConfig } from "../workspace-config.mjs";

test("new platform bindings and storage migrations require an explicit port decision", () => {
  const config = { name: "workshop-backend", compatibility_date: "2026-02-02" };
  assert.throws(() => validateWorkerConfig({ ...config, d1_databases: [] }), /Unsupported.*d1_databases/);
  assert.throws(() => validateWorkerConfig({ ...config, migrations: [{ tag: "v2", renamed_classes: [] }] }), /Unsupported migration/);
  assert.throws(() => validateWorkerConfig({ ...config, migrations: [
    { tag: "v0", new_sqlite_classes: ["User"] }, { tag: "v1", new_sqlite_classes: ["User"] },
  ] }), /Duplicate DO class/);
  assert.throws(() => validateWorkerConfig({ ...config, browser: { binding: "UNKNOWN" } }), /Unsupported browser/);
});
