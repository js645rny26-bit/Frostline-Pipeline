# Monotonicity V2 commissioning candidate

Monotonicity V2 answers only how much historical prospective evidence Frostline
has earned for the *magnitude* of a frozen model-versus-market edge. It does not
create a projection, thesis, vehicle, market line, stake, or authorization.

Input records are limited to the first immutable `VEHICLE_LOG` record joined to
a settled `SHADOW_OUTCOMES` actual. The model projection and market line are
therefore frozen prospective values; current lines and reconstructed history are
not accepted. Pushes remain neutral and are excluded from win-rate denominators.

`MONOTONICITY_V2` reports OVER and UNDER independently. It preserves V1's fixed
tiers/quintiles in `MONOTONICITY`, but V2 uses pooled-adjacent-violators regions
to avoid treating each narrow 0.50-run tier as an independent 75-game hurdle.

States are shadow-only:

- `CALIBRATED`: directional correctness rises and absolute error falls with edge
  magnitude with stable Fisher-interval evidence.
- `UNVERIFIED`: evidence does not establish either relationship. It earns no
  edge-magnitude credit and is **not** a blocker.
- `ANTI_MONOTONE`: directional correctness deteriorates or absolute error rises
  with stable evidence. It is reported as a future candidate blocker only.

`MONOTONICITY_V2_REPLAY` compares V1's recorded historical wall, the narrow
counterfactual of removing that V1 wall, and V2's would-block/would-credit state.
No V2 output is read by Module 11 or active authorization during commissioning.
