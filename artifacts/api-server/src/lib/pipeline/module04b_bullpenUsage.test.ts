import assert from "node:assert/strict";
import test from "node:test";
import { parseMlbStartingNineBullpenHtml } from "./module04b_bullpenUsage.js";

const REPORT_FIXTURE = `
  <tbody class="team-group">
    <tr class="accordion-toggle" data-bs-target="#collapse-boston-red-sox"><td>Boston Red Sox</td></tr>
    <tr id="collapse-boston-red-sox" class="collapse collapse-row"><td>
      <h6>5-Day Pitch Count Heat Map</h6>
      <table><tbody>
        <tr class="bg-white">
          <td><img src="https://img.mlbstatic.com/mlb-photos/image/upload/w_67,q_auto:best/v1/people/547973/headshot/67/current"><a href="/players/aroldis-chapman/">Aroldis Chapman</a></td>
          <td>1.81</td><td>1.16</td><td><span>AVAILABLE</span></td><td>3</td>
          <td>-</td><td>18</td><td>15</td><td>-</td><td>20</td>
        </tr>
        <tr class="bg-white">
          <td><img src="https://img.mlbstatic.com/mlb-photos/image/upload/w_67,q_auto:best/v1/people/123456/headshot/67/current"><a href="/players/test-reliever/">Test Reliever</a></td>
          <td>4.00</td><td>1.20</td><td><span>TIRED</span></td><td>2</td>
          <td>24</td><td>-</td><td>-</td><td>-</td><td>-</td>
        </tr>
      </tbody></table>
    </td></tr>
  </tbody>`;

test("Starting Nine bullpen parser preserves explicit daily availability and pitch counts", () => {
  const rows = parseMlbStartingNineBullpenHtml(
    REPORT_FIXTURE,
    "2026-08-27",
    "2026-08-27T12:00:00.000Z",
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    player_id: 547973,
    full_name: "Aroldis Chapman",
    team_abbr: "BOS",
    innings_last_7: 0,
    games_last_7: 3,
    days_rest: 2,
    last_outing_date: "2026-08-25",
    role: "RELIEF",
    notes: "Availability: AVAILABLE; L5 pitches: -/18/15/-/20",
    availability_status: "AVAILABLE",
    appearances_last_5: 3,
    pitches_yesterday: null,
    pitches_2_days_ago: 18,
    pitches_3_days_ago: 15,
    pitches_4_days_ago: null,
    pitches_5_days_ago: 20,
    workload_source: "MLBSTARTINGNINE_BULLPEN_REPORT",
    source_snapshot_utc: "2026-08-27T12:00:00.000Z",
  });
  assert.equal(rows[1]?.availability_status, "TIRED");
  assert.equal(rows[1]?.days_rest, 1);
  assert.equal(rows[1]?.last_outing_date, "2026-08-26");
});

test("Starting Nine parser maps the Athletics report identity to the canonical OAK abbreviation", () => {
  const athleticsFixture = REPORT_FIXTURE
    .replaceAll("boston-red-sox", "athletics")
    .replace("Boston Red Sox", "Athletics");
  const rows = parseMlbStartingNineBullpenHtml(athleticsFixture, "2026-08-27", "2026-08-27T12:00:00.000Z");
  assert.equal(rows[0]?.team_abbr, "OAK");
});
