import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOfficialPreviousDayUsage,
  parseMlbStartingNineBullpenHtml,
} from "./module04b_bullpenUsage.js";

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

test("postseason Game 1 reliever workload is visible in the Game 2 pregame availability state", () => {
  const game2Fixture = REPORT_FIXTURE.replace(
    "<td>-</td><td>18</td><td>15</td><td>-</td><td>20</td>",
    "<td>31</td><td>-</td><td>-</td><td>-</td><td>-</td>",
  );
  const rows = parseMlbStartingNineBullpenHtml(
    game2Fixture,
    "2026-10-02",
    "2026-10-02T14:00:00.000Z",
  );
  assert.equal(rows[0]?.pitches_yesterday, 31);
  assert.equal(rows[0]?.last_outing_date, "2026-10-01");
  assert.equal(rows[0]?.days_rest, 1);
  assert.match(rows[0]?.notes ?? "", /Availability: AVAILABLE; L5 pitches: 31/);
});

test("Sept. 29 Wild Card Game 1 pitch counts remain visible for every Game 2 club", () => {
  const game1Usage = [
    ["philadelphia-phillies", "PHI", 666200, "Jesús Luzardo", 77],
    ["philadelphia-phillies", "PHI", 686934, "Alex McFarlane", 16],
    ["philadelphia-phillies", "PHI", 661395, "Jhoan Duran", 27],
    ["atlanta-braves", "ATL", 519242, "Chris Sale", 95],
    ["atlanta-braves", "ATL", 800311, "Didier Fuentes", 12],
    ["atlanta-braves", "ATL", 669276, "Dylan Lee", 16],
    ["atlanta-braves", "ATL", 628452, "Raisel Iglesias", 7],
    ["chicago-white-sox", "CHW", 696146, "Hagen Smith", 38],
    ["chicago-white-sox", "CHW", 663855, "Jordan Hicks", 17],
    ["chicago-white-sox", "CHW", 656794, "Sean Newcomb", 19],
    ["chicago-white-sox", "CHW", 689818, "David Sandlin", 22],
    ["chicago-white-sox", "CHW", 691799, "Grant Taylor", 54],
    ["houston-astros", "HOU", 805123, "AJ Blubaugh", 27],
    ["houston-astros", "HOU", 687911, "Bryan King", 22],
    ["houston-astros", "HOU", 699044, "Miguel Ullola", 31],
    ["houston-astros", "HOU", 681973, "Josh Hendrickson", 37],
    ["houston-astros", "HOU", 701121, "Logan VanWey", 3],
    ["houston-astros", "HOU", 656986, "Bennett Sousa", 13],
    ["houston-astros", "HOU", 650556, "Bryan Abreu", 11],
    ["houston-astros", "HOU", 623352, "Josh Hader", 11],
    ["boston-red-sox", "BOS", 801139, "Payton Tolle", 83],
    ["boston-red-sox", "BOS", 669062, "Erik Miller", 9],
    ["boston-red-sox", "BOS", 669711, "Greg Weissert", 15],
    ["boston-red-sox", "BOS", 687941, "Alec Gamboa", 15],
    ["boston-red-sox", "BOS", 681544, "Wyatt Olds", 18],
    ["boston-red-sox", "BOS", 678394, "Brayan Bello", 21],
    ["new-york-yankees", "NYY", 693645, "Cam Schlittler", 117],
    ["new-york-yankees", "NYY", 621112, "Paul Blackburn", 18],
    ["new-york-yankees", "NYY", 670167, "John Schreiber", 11],
    ["chicago-cubs", "CHC", 571510, "Matthew Boyd", 58],
    ["chicago-cubs", "CHC", 665871, "Javier Assad", 18],
    ["chicago-cubs", "CHC", 669020, "Ryan Rolison", 16],
    ["chicago-cubs", "CHC", 650644, "Aaron Civale", 24],
    ["chicago-cubs", "CHC", 657097, "Jacob Webb", 16],
    ["san-diego-padres", "SDP", 650633, "Michael King", 97],
    ["san-diego-padres", "SDP", 673513, "Yuki Matsui", 11],
    ["san-diego-padres", "SDP", 605397, "Joe Musgrove", 22],
  ] as const;

  const bySlug = new Map<string, typeof game1Usage[number][]>();
  for (const appearance of game1Usage) {
    const rows = bySlug.get(appearance[0]) ?? [];
    rows.push(appearance);
    bySlug.set(appearance[0], rows);
  }
  const html = [...bySlug.entries()].map(([slug, appearances]) => `
    <tbody class="team-group">
      <tr class="accordion-toggle" data-bs-target="#collapse-${slug}"><td>${slug}</td></tr>
      <tr id="collapse-${slug}" class="collapse collapse-row"><td>
        <h6>5-Day Pitch Count Heat Map</h6><table><tbody>
        ${appearances.map(([, , id, name, pitches]) => `
          <tr class="bg-white">
            <td><img src="https://img.mlbstatic.com/mlb-photos/image/upload/v1/people/${id}/headshot"><a>${name}</a></td>
            <td>0.00</td><td>0.00</td><td><span>UNKNOWN</span></td><td>1</td>
            <td>${pitches}</td><td>-</td><td>-</td><td>-</td><td>-</td>
          </tr>`).join("")}
      </tbody></table></td></tr>
    </tbody>`).join("");

  const parsed = parseMlbStartingNineBullpenHtml(html, "2026-09-30", "2026-09-30T12:00:00.000Z");
  assert.equal(parsed.length, game1Usage.length);
  assert.deepEqual(new Set(parsed.map((row) => row.team_abbr)), new Set(["PHI", "ATL", "CHW", "HOU", "BOS", "NYY", "CHC", "SDP"]));
  for (const [, team, id, name, pitches] of game1Usage) {
    const row = parsed.find((candidate) => candidate.player_id === id);
    assert.ok(row, `${team} ${name} must remain visible in Game 2 workload state`);
    assert.equal(row.team_abbr, team);
    assert.equal(row.pitches_yesterday, pitches);
    assert.equal(row.last_outing_date, "2026-09-29");
    assert.equal(row.days_rest, 1);
  }

  const staleRows = parsed.map((row) => ({
    ...row,
    last_outing_date: "2026-09-27",
    days_rest: 3,
    pitches_yesterday: null,
    availability_status: "AVAILABLE" as const,
  }));
  const reconciled = applyOfficialPreviousDayUsage(
    staleRows,
    game1Usage.map(([, team, id, , pitches]) => ({
      player_id: id,
      team_abbr: team,
      appearance_date: "2026-09-29",
      innings: 1,
      pitches,
      games_started: 0,
    })),
  );
  for (const [, team, id, name, pitches] of game1Usage) {
    const row = reconciled.find((candidate) => candidate.player_id === id);
    assert.ok(row, `${team} ${name} must survive official Game 1 reconciliation`);
    assert.equal(row.pitches_yesterday, pitches);
    assert.equal(row.last_outing_date, "2026-09-29");
    assert.equal(row.availability_status, "UNKNOWN");
  }
});

test("official Game 1 usage invalidates a stale daily availability claim without guessing Game 2 availability", () => {
  const [stale, current] = parseMlbStartingNineBullpenHtml(
    REPORT_FIXTURE,
    "2026-09-30",
    "2026-09-30T12:00:00.000Z",
  );
  assert.ok(stale && current);
  const reconciled = applyOfficialPreviousDayUsage([stale, {
    ...current,
    pitches_yesterday: 24,
    last_outing_date: "2026-09-29",
    days_rest: 1,
  }], [
    { player_id: 547973, team_abbr: "BOS", appearance_date: "2026-09-29", innings: 2, pitches: 27, games_started: 0 },
    { player_id: 123456, team_abbr: "BOS", appearance_date: "2026-09-29", innings: 1, pitches: 24, games_started: 0 },
  ]);

  assert.equal(reconciled[0]?.pitches_yesterday, 27);
  assert.equal(reconciled[0]?.last_outing_date, "2026-09-29");
  assert.equal(reconciled[0]?.days_rest, 1);
  assert.equal(reconciled[0]?.availability_status, "UNKNOWN");
  assert.equal(reconciled[0]?.workload_source, "MLBSTARTINGNINE_PLUS_MLB_OFFICIAL_D1");
  assert.match(reconciled[0]?.notes ?? "", /DAILY_STATUS_STALE_AVAILABILITY_UNKNOWN/);

  assert.equal(reconciled[1]?.availability_status, "TIRED");
  assert.equal(reconciled[1]?.pitches_yesterday, 24);
  assert.match(reconciled[1]?.notes ?? "", /DAILY_STATUS_RECONCILED/);
});
