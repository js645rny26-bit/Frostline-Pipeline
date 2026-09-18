import test from "node:test";
import assert from "node:assert/strict";

import { parseStatcastBatterLeaderboardCsv } from "./module02d_statcastBatters.js";

test("expected-statistics success cannot masquerade as materialized hard-hit damage", () => {
  const csv = [
    '"last_name, first_name","player_id","year","pa","est_ba","est_slg","est_woba"',
    '"Example, Hitter","123","2026","100",0.250,0.450,0.340',
  ].join("\n");

  const parsed = parseStatcastBatterLeaderboardCsv(csv, "2026", "fixture://expected");

  assert.equal(parsed.status, "partial");
  assert.equal(parsed.fetched, 1);
  assert.equal(parsed.stats.get(123)?.xwoba, 0.34);
  assert.equal(parsed.stats.get(123)?.hard_hit_pct, null);
  assert.equal(parsed.hard_hit_fetched, 0);
  assert.equal(parsed.damage_metric_status, "SOURCE_SCHEMA_MISSING");
  assert.match(parsed.errors.join(" | "), /does not expose hard-hit/i);
});

test("hard-hit damage is available only when the source actually supplies values", () => {
  const csv = [
    '"last_name, first_name","player_id","year","pa","est_ba","est_slg","est_woba","hard_hit_percent","barrel_batted_rate"',
    '"Example, Hitter","123","2026","100",0.250,0.450,0.340,44.2,9.1',
  ].join("\n");

  const parsed = parseStatcastBatterLeaderboardCsv(csv, "2026", "fixture://damage");

  assert.equal(parsed.status, "success");
  assert.equal(parsed.hard_hit_fetched, 1);
  assert.equal(parsed.barrel_fetched, 1);
  assert.equal(parsed.damage_metric_status, "AVAILABLE");
  assert.equal(parsed.stats.get(123)?.hard_hit_pct, 44.2);
  assert.equal(parsed.stats.get(123)?.barrel_rate, 9.1);
});

test("missing core expected-statistics columns fails closed", () => {
  const csv = [
    '"last_name, first_name","player_id","year","pa"',
    '"Example, Hitter","123","2026","100"',
  ].join("\n");

  const parsed = parseStatcastBatterLeaderboardCsv(csv, "2026", "fixture://drift");

  assert.equal(parsed.status, "failure");
  assert.equal(parsed.fetched, 0);
  assert.match(parsed.errors.join(" | "), /required expected-statistics columns missing/i);
});
