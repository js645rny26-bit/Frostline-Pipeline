# Active Pitching Inventory late-refresh proof — 2026-09-19

Module 36 remains `RESEARCH_ONLY / SHADOW` and uncommissioned.

Authoritative readback after the 2026-09-19 late partial pregame run proved the
append-only refresh contract introduced by commit `8e55304`:

- protected games retained their earlier immutable inventory snapshots;
- the three still-mutable late games appended six fresh AWAY/HOME rows at the
  late-run timestamp;
- every row retained `Active_Input=NO` and
  `Projection_Mapping_Status=SHADOW_ONLY_NOT_COMMISSIONED`;
- no API shadow value entered an active projection.

This closes the late-refresh persistence defect. It does not commission the
Active Pitching Inventory model or establish opener/bulk projection value.
