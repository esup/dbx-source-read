import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import test from "node:test";
import { buildViewDdl } from "../../apps/desktop/src/lib/viewDdl";

test("Postgres view DDL wraps a view definition body in CREATE OR REPLACE VIEW", () => {
  const ddl = buildViewDdl({
    databaseType: "postgres",
    schema: "public",
    name: "active users",
    source: " SELECT id, name FROM users WHERE active ",
  });

  assert.equal(ddl, 'CREATE OR REPLACE VIEW "public"."active users" AS\nSELECT id, name FROM users WHERE active;');
});

test("view DDL keeps existing CREATE VIEW statements intact", () => {
  const ddl = buildViewDdl({
    databaseType: "mysql",
    schema: "reporting",
    name: "active_users",
    source: "CREATE ALGORITHM=UNDEFINED VIEW `active_users` AS SELECT `id` FROM `users`",
  });

  assert.equal(ddl, "CREATE ALGORITHM=UNDEFINED VIEW `active_users` AS SELECT `id` FROM `users`;");
});

test("sidebar view context menu exposes a separate DDL action", () => {
  const source = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");

  assert.match(source, /function viewObjectDdl/);
  assert.match(source, /buildViewDdl/);
  assert.match(source, /contextMenu\.viewDdl/);
});

test("object browser view context menu exposes a separate DDL action", () => {
  const source = readFileSync("apps/desktop/src/components/objects/ObjectBrowser.vue", "utf8");

  assert.match(source, /function openViewDdl/);
  assert.match(source, /buildViewDdl/);
  assert.match(source, /contextMenu\.viewDdl/);
});
