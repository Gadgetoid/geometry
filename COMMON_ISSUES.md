# How this codebase goes wrong

The failure classes this game has produced more than once, each with the instances
that taught it. A review pass is worth more spent asking these questions of new code
than re-deriving them: every one of these was found the hard way, most of them twice.

Read with `CODE_REVIEW.md`, which says how to verify a suspicion, and
`KNOWN_ISSUES.md`, which says what is already known and what has already been
settled.

- **A shape the simulation tests disagreeing with the shape the view draws.**
  The most productive question to ask this codebase; it has paid out five times.
  Circles standing in for polygons caused an invisible wall, fragments popping
  apart, 39% of beams missing a frigate, and a player hull with twice its own area
  in phantom hitbox and an intangible nose. Then the same thing inverted: the
  shield bubble's radius existed _only_ in the draw path, worked out three
  different ways at three call sites, so shots that visibly grazed a shield did
  nothing — 5 of 14 sampled offsets on a scout, 9 of 13 on a frigate. Then the
  bubble became the sim's shape for beams and stayed the draw path's for bullets,
  so a shot fired at a visible shield passed through it: 35 of 46 offsets on a
  frigate, 14 of 25 on the player, which is the only thing bullets are ever aimed
  at. And a beam collided along a zero-width centreline while being drawn 2.4
  units across, so a shot laid over an unarmed rival registered nothing in 220 of
  5,784 sampled poses. Whenever a size is computed where something is drawn, ask
  what the sim uses instead, and the other way round.
- **The same question answered inconsistently for two body types.** Rocks needed a
  beam to cross twice before cutting while ships needed only a touch; two contact
  sites divided by mass where its inverse belonged, invisible for the player whose
  mass is exactly 1 and wrong for everything else; and rocks were the only body
  type `detonate` never called `takeDamage` on, so a shielded rock beside an
  explosion lost nothing. Since then: `resolveHullRockContact` was shared by every
  hull while only the player was _charged_ for it, so a scout could drive into a
  boulder for ten seconds and lose nothing while the player lost a life in 6.7;
  a beam cut every rock it crossed but only the nearest ship; and a shielded rock
  had its energy drained inline while every other body lost it through
  `takeDamage`. When two kinds of body answer the same question, find both answers
  and diff them.
- **Predicates that consider only one party.** A bounce tested the ship's own
  velocity, so a rock driving into a stationary ship never registered.
- **An expression that assumes a range nothing enforces.** The shortest-turn wrap
  `((goal - heading + 3 PI) % TAU) - PI` is only correct while
  `goal - heading > -3 PI`, and a ship's heading accumulates and is never
  normalised. Its fingerprint was headings pinned at _exactly_ 3 PI, because the
  broken branch turned the ship back the moment it would pass: the ceiling was the
  bug, not a limit. 41.7% of rival frames sat where it could turn the wrong way.
  When a formula assumes an input range, find the line that guarantees it.
- **Range measured to a centre, for a body that has extent.** This has now paid
  out twice with the same symptom: the thing you most want the effect to reach is
  the thing it reaches least, because a big body's centre is far away by virtue of
  being big. A blast measured centre to centre, so a boulder with its face against
  it took nothing but a shove. Then the exhaust wash, still measuring to the
  centre after the blast was fixed: a mass-8.2 boulder gained **0.7 u/s** from a
  second of point-blank thrust and **nothing at all** beyond point-blank, where
  the same wash gave a pebble 147. Reported as "thrusters stopped pushing rocks,
  probably a mass tuning problem", which is what it looks like from the cockpit.
  Grep every falloff for one measured against `center` without subtracting
  `boundRadius`.
- **A cost quoted as an amount, against a resource an upgrade scales.** The
  specials charged flat energy while the core's cell runs 320 to 1260 and its
  regen 32 to 116/sec, so stealth's 26/sec drain was _below_ the regen at the top
  level: the special was free on a fully upgraded ship. Reported as "they make
  basically no impact". Fixed by quoting every cost as a fraction of the cell,
  which holds the feel at every level (stealth is 9.5s of run time at all five).
  **`CONFIG.THRUST_COST` is still a flat 21/sec and has the same problem.**
- **A field every registry entry declares is not a selector.** `endEffectsWith`
  looks up effects by a named field, and toggling stealth off passed `"mode"` —
  which every special declares — so it also cancelled a running booster. If a
  lookup-by-field helper exists, the field passed to it has to be one only the
  intended entries carry.
- **A timer that runs while its subject cannot act.** Respawn invincibility ticked
  through the 1.2s pause and 0.85s warp-in, so all 2.0s of it were gone before the
  ship could be flown. Ask what a duration is a duration _of_.
- **An effect that only decays in the loop that started it.** Screen shake decayed
  in `update`, which `advance` calls only while `inSector()`. Losing the last life
  throws the shake and sets phase `over` in the same breath, so the ship-lost
  screen shook for good. Anything that settles should settle wherever it was
  started.
- **A rule applied to one instance of a case and not the other.** `applyBeam`
  passed straight through a rival outside the arena, with a comment explaining
  that a body which cannot be damaged must not stop a beam either, and did not
  apply that to the player mid-warp, which is the same case. A warping ship
  stopped an enemy beam dead and sheltered what was behind it, and both bodies
  swallowed bullets for no damage. When a comment states a principle, grep for
  every body it should cover.
- **A guard that only guards one of the ways in.** `invincible` was consulted at
  rock contact, at the turret controller's decision to hold fire, and at the
  cosmetic blink, but never in `takeDamage`. Bullets, beams and blasts went
  straight through it, and since the player's hull has no health of its own
  (`onHull` costs a life outright) any one of them was a one-shot kill on a ship
  that was visibly flashing "invulnerable". Reported as "one shotted while
  spawning in and ostensibly invincible". Worth asking of any flag: what enforces
  it, and does that cover every way in?
- **A guard that quietly became the answer.** `AST_MASS_RANGE` was written as a
  clamp against extremes, but its ceiling of 4 sat below everything a sector
  spawns (4.3 to 8.2), so all 86 sampled rocks landed on it and every rock in the
  field weighed exactly the same. A clamp that binds on the common case is not a
  guard. Check what fraction of real values a limit actually catches. Same again
  with `MAX_PARTICLES`, sized at 1,200 for a smaller game: six burning wrecks alone
  wanted 1,697 and the cap drops the _oldest_, so a busy sector was quietly eating
  the effects of everything that happened before the fire. A cap nothing was
  measured against is a number, not a limit.
- **Unbounded growth in a weighted roll, which deletes rather than crowds.** The
  armed-rock hazard was the only one with a `weightPerSector`, so its share of
  the roll ran away with it: explosive rocks went from a fifth of the pool at
  sector 6 to a thirtieth by sector 30, roughly one every four sectors. It reads
  in play as a hazard being removed from the game, and it was diagnosed as
  something destroying them. Anything that grows per sector wants a cap, and any
  "I never see X any more" is worth checking against the roll before the
  simulation.
- **Aggregating a per-pair result without deciding what the aggregate means.**
  Decide contact per part, but measure the push over each body as a whole.
- **A property of the hull answering a question about the pilot.** `faction` was read
  off the ship's type, which is right until the player is put in someone else's hull:
  flying a frigate made the player a rival, so their own guns went looking for a
  target on the side they were now on and found none, and an alien field would have
  counted alien fire as friendly. Ask whether a question is about the thing or about
  who is holding it.
- **A floor meant for the simulation used as an affordance.** Every hull sees at
  least `SENSOR_FLOOR`, so a ship with no radar is short-sighted rather than blind.
  The HUD drew its edge markers off the same number, and that floor is a circle of
  620 against a screen only 320 from the middle to the top edge: everything in the
  band between got a marker whether the set fitted could see it or not. What a hull
  notices and what its instruments report are two questions.
- **A reading that animates itself.** The energy bar pulsed when low by drawing at
  its true length times `0.85 + 0.15 sin(t)`, so the reading itself moved 15% either
  way at 1.6Hz. It was reported as the energy pool oscillating wildly, and the pool
  was fine. Animate anything about a measurement except the measurement.
- **Two mechanisms behind one symptom, reverted as one.** Wells pulling each other
  and a wind-up drawing a well in are different things that both make a well move.
  Fixing the runaway killed both; putting the attraction back brought the tow back
  with it, and a single well shot off with nothing near it. When a revert restores a
  symptom, check that what is being restored is what was wanted.
- **A field one kind of registry entry has and another does not.** Guns found on
  other hulls became fittable, and the player's trigger ran the charge machinery over
  all of them: a gun that does not charge has no `chargeMax`, `chargeRate` or
  `chargeCost`, so the charge went NaN and took the cell with it. Everything
  downstream of the cell followed, and it was reported as "my shield is a white
  blob", which is four steps from the cause. When a registry gains entries of a new
  shape, find the code that assumed the old one.
- **Name-based special-casing** instead of a field on the type registry. BOOSTER's
  collision immunity lived in `PlayerShip.update` and was declared nowhere; a
  rival's decision to hunt was inferred from a loadout entry naming the "hunter"
  controller, so any other aggressive controller would silently not chase.
- **A tool that writes the model, left behind by the model.** `ship-editor.html`
  emits `SHIP_DESIGNS` entries, so any field added to a design that the editor does
  not write is silently dropped the next time a hull is pasted back through it.
  This has now happened five times: derived fields written out and frozen,
  `faction` and `confineRadius` lost, arm chances lost, an invented
  `maxConcurrent: 1`, and `debrisMaterial: SHIP_PLATING` hard-coded for every hull,
  which would have re-plated an alien as a rival and had it burning orange. The
  round-trip test in `test/editor.test.js` is the guard: when a field is added to a
  ship type, it belongs in that test the same day. Ask of any generator: what does
  it not know about yet?
- **Two places holding one fact, one of which nothing reads.** Dead code is
  harmless until the fact changes: `GAMEPAD.buttons` still named the ship controls
  after `BINDABLE_CONTROLS` took them over, and swapping a default in one would
  have left them disagreeing in silence.
- **State written for another layer to read, that it never reads.** `summaryData`
  carried a `resumed` flag the shop never checked, so a resumed run printed
  "accuracy NaN%" and four "undefined"s — on screen, the whole time, with no test
  looking at that screen.
- **Entities acting after they die.** Everything is updated and _then_ filtered, so
  anything killed part-way through a frame gets one more turn: a rival fired a
  parting shot and collected the ore it had just dropped.
- **Tests that measure the wrong thing.** Repeatedly the biggest time sink. Past
  cases: a metric counting muzzle flashes as fire, a probe in the wrong phase, a
  sliced ship registering as undamaged, momentum measured in area when the solver
  clamps mass, "are these two hulls apart?" asked as centre distance, a control
  scheme proved on the keyboard and broken on the pad, and an assertion derived
  from the very number it was checking. Two more since: the corner test took the
  peak penetration over every frame including the transient while the ship is
  extracting itself, so heavier rocks "broke" it at 1.60 units when the settled
  value was 0.00 either way; and a beam test asserted `landed === crossesHull`
  against the zero-width centreline, which giving the beam its drawn width
  invalidated: the oracle was wrong, not the code. Before believing a number, state what
  quantity the code actually conserves or tests, and measure that. **If a change
  breaks a test, decide whether the code or the oracle was wrong before touching
  either.** A third kind since: a test proving "a new gun kind joining the pool does
  not arm more rocks" sampled five sectors apart, which only isolated that while the
  trait's own weight had already capped. Respacing the progression made the same
  test measure the growth instead and fail on correct code. A measurement that
  straddles two moving quantities proves nothing about either. And one that could not
  fail at all: a regression test for that NaN cell held a key called `"fire"`, which
  is the action rather than the binding, so nothing was held and it passed against
  the bug it was written for. It was caught only by breaking the fix on purpose.
- **A test that asserts something weaker than the property at risk.** The HUD
  scale test first asserted "nothing runs off the page", which passed with an
  anchor deliberately broken, because a mis-anchored element is still on the page.
  Rewritten to assert the real property — every coordinate is a scaled distance
  from the left/top, the right/bottom or the middle — it found an unscaled inset
  on the first run. **Break the code on purpose and confirm the test fails**; two
  tests in this codebase have been written that could not fail.
- **A flaky test believed on one green run.** Rock outlines are generated, so an
  unseeded comparison near a threshold flips between runs. One here passed, failed,
  and passed again across three runs of the same code. Run a new numeric test
  several times before trusting it.
