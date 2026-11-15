# Playbook: making a small 3D browser game with an AI coding agent

*When Pigs Fly* was made in one long session with Claude Code. This is the route it took,
rewritten in the order it should have taken, so the next game can follow it.

**The short version:** start with a joke and a playable toy, keep one file that says where
everything is, let Blender do the looks and the browser do the feel, and never accept "it works"
without a screenshot or a measurement.

Contents:

1. [What you need](#1-what-you-need)
2. [Three decisions that carry the weight](#2-three-decisions-that-carry-the-weight)
3. [The route, step by step](#3-the-route-step-by-step)
4. [How to check work you cannot see or hear](#4-how-to-check-work-you-cannot-see-or-hear)
5. [Mistakes, and the rule each one taught](#5-mistakes-and-the-rule-each-one-taught)
6. [Prompts that worked](#6-prompts-that-worked)
7. [Where this build stands](#7-where-this-build-stands)

## 1. What you need

- Claude Code with a browser it can drive (Claude in Chrome), so it can look at its own work.
- Blender, runnable from the command line (`blender -b --python script.py`).
- Node, for a local copy of three.js and small scripts. No bundler, no framework.
- A static file server (`python3 -m http.server`).

## 2. Three decisions that carry the weight

Make these early. Most of what went smoothly later traces back to one of them.

**One layout file, read by both sides.** `src/layout.js` holds the island's shape and where
everything stands, with no three.js in it. The game imports it for collisions and ground height.
`tools/dump-layout.mjs` writes it out as JSON for Blender. The Blender script has its own copy of
the ground-height formula and asserts it against sample points from the JavaScript, so the two
cannot drift apart silently.

**Bake what stands still, light what moves.** Scenery is drawn unlit, with Cycles lighting baked
in: a texture for the ground and the barn, vertex colours for everything else. Animals and
anything that tumbles are lit in real time by a sun pointing the same way as the baked one. A
transparent copy of the terrain catches their shadows.

**Test hooks from the first day.** The game exposes `window.__wpf`: teleport, face, key presses,
a manual `step(dt)`, a debug camera and the game state. Every check in section 4 uses it.

The files those decisions produce:

    index.html, landing.css/js   launcher page
    play.html                    the game page: HUD markup and CSS only
    src/layout.js                where everything on the island is; pure data and maths
    src/game.js                  the game
    src/audio.js                 all sound, synthesised
    src/critters.js, pig.js      load the Blender animals and animate them
    blender/world_bake.py        builds and light-bakes the island  -> assets/world.glb
    blender/critter_lib.py       animal builders                    -> assets/critters.glb
    tools/                       layout export, automated play-test, sound check

## 3. The route, step by step

Twelve steps in three phases. Each step ends with a test for whether it is finished. Two steps
are in a different place from where this project did them, and say so.

### Phase one: a game that works

**Step 1. Pick a premise that writes its own content.**
"When pigs fly" gave the whole design: idioms about impossible things become jobs, each job
shortens the odds, and the pig grows wings. A premise like this is worth more than a feature
list, because every later request ("more scenarios", "secrets", "make it funnier") has an obvious
source to draw from.
*Finished when* you can list ten pieces of content without inventing a new rule.

**Step 2. Build the toy with plain shapes.**
Boxes and spheres, five jobs, a win condition, a HUD, synthesised sound and a launcher page. It
was ugly and complete. Put the test hooks in now. Polish nothing until the loop is playable from
start to win.
*Finished when* someone can win.

**Step 3. Start version control.**
This project left it too late. Do it here, so every later step has something to go back to.
*Finished when* the playable toy is committed.

**Step 4. Write an automated play-through and keep it passing.**
A script steers the pig through the jobs using the test hooks, stepping the simulation by hand so
a whole game runs in a couple of seconds. This project wrote it later, and it covers only the
newer jobs. Written here, it grows one job at a time.
*Finished when* one command plays the game to the win and reports each job.

**Step 5. Widen the game: a pool of content and a seeded draw.**
Twelve jobs exist and each game asks for five, chosen from a seed. Jobs not on the list still
work. `?seed=` and `?feats=` in the URL make any draw reproducible, which testing needs.
*Finished when* the same URL always gives the same game.

### Phase two: a world worth looking at

**Step 6. Prove Blender on its own.**
Before touching the game, make one stand-alone render (here, the first poster). It proves the
headless pipeline works and gives a look to aim for.
*Finished when* one command produces an image you like.

**Step 7. Bake one object, then the whole world.**
Put the layout in the shared file, bake a single object (the barn) and load it in the game. Only
once that round trip works, move everything else into the bake script. Give the script a
draft mode from the start: here a draft takes 30 seconds and a full bake about two minutes, and
you will run it dozens of times.
*Finished when* the game runs on the baked world and the ground-height assert passes.

**Step 8. Hand the characters to a second agent.**
The animals were modelled by another agent, from a written interface (node names, sizes, which
way they face, the JavaScript API), while the main thread built the island and the game logic.
This works only when the two pieces meet at an interface you can write down in advance.
*Finished when* the animals load through the interface with no changes to it.

**Step 9. Complicate the map last.**
Headlands, an islet, a pond and a bridge went in late, once everything had a home. Because the
layout was one file, reshaping the coast meant changing one function and baking again.
*Finished when* the play-through still passes on the new map.

### Phase three: a game worth showing

**Step 10. Make it funny.**
What moved it from amusing to funny, most value for effort first:

- The world answers back. Oinking near anything gets a reaction and a line.
- Consequences stay visible. Signs repaint when a job is done.
- Callbacks. The win triggers raining cats and dogs, and a cow orbiting the moon.
- A dry narrator for idleness, failure and repetition, who never interrupts a message already
  on screen.
- Secrets with hints. The win screen names two you missed, which is the reason to play again.

*Finished when* someone who did not build it laughs.

**Step 11. Make it beautiful, then make it sound right.**

- Time of day tied to progress. One colour multiplies every baked material, and sky, fog, sea
  and lights follow the same curve. The finale is at twilight.
- Bloom, kept subtle. The first setting blew out in daylight.
- Small living things: butterflies, fireflies, petals, birds. Cheap, and they do a lot.
- Game feel: squash on landing, screen shake, dust, half a second of slow motion on success.
- Sound in three layers: effects with a shape (calls that rise and fall), ambience that fades in
  by where the player is, and music that adds players as jobs are done. Balance the levels by
  measurement, then have a person listen.

*Finished when* screenshots at three times of day look right and no sound clips.

**Step 12. Ship it.**
A static site needs nothing more than GitHub Pages pointed at the repository. Before the first
public push, read what the history contains. Afterwards, load the public link, check a narrow
screen and a slow machine, and send it to someone who has never seen it.
*Finished when* a stranger has played the published link.

## 4. How to check work you cannot see or hear

An agent's "done" means little without evidence. Five checks were used. Each one says what it
proves and what it does not.

| Check | How | Proves | Does not prove |
|---|---|---|---|
| Console after loading | Load the page and read the console | Every module and asset arrived | That anything looks right |
| Screenshots | `__wpf.view(...)` places a debug camera; take several angles after each visual change, HUD included | What the player will see | How it moves |
| Play-through | `tools/playtest.js`, run from the console as its first lines describe | The rules of the jobs it covers | Feel, difficulty, or jobs it does not cover |
| Sound check | Open `tools/sound-check.html`; each sound is rendered without speakers and measured | Levels, length, clipping | Whether a moo sounds like a cow |
| Narrow screen | Load the game in a frame 390 pixels wide | The HUD fits a phone's width | Touch controls, which need a real phone |

Two habits go with the table. Run the checks on the published link as well as the local copy.
And when a check fails after an unrelated change, suspect the check as well as the game.

## 5. Mistakes, and the rule each one taught

**Loading**

| What happened | Rule |
|---|---|
| The game silently failed to load after a new loader imported a file not yet copied in. | After adding any module, load the page and read the console before doing anything else. |

**Baking and placement**

| What happened | Rule |
|---|---|
| Long thin parts baked black: light was sampled only at their buried end vertices. | With vertex-colour baking, cut long parts so they have vertices out in the open. |
| Objects that move left their baked shadow behind on the ground. | Bake movable objects without a shadow of their own; give them a live one. |
| A boulder landed on a path; a prop spot landed inside a tree. | Anything placed by rule needs a keep-out check against everything else. |

**Camera and HUD**

| What happened | Rule |
|---|---|
| The camera ended up inside the barn, and inside trees. | A third-person camera needs its own obstacle rules. Test by standing next to things. |
| A HUD line showed struck through because a toggle was passed `undefined`. | Look at the HUD in screenshots too, not only the 3D view. |
| The phone layout overlapped badly. | Check a narrow screen before calling any HUD change finished. |

**Testing and sound**

| What happened | Rule |
|---|---|
| The play-test reported the barn puzzle broken; the test had stepped on the wrong plate. | When a test fails after an unrelated change, suspect the test as well as the game. |
| A batch of scheduled sounds rendered far too loud; a gain sat at full until its start time. | Measure audio, and start every gain at zero. |

**Publishing**

| What happened | Rule |
|---|---|
| Commits were about to publish a personal email address. | Before the first public push, check what the history contains. |

## 6. Prompts that worked

They were short, and each asked for one kind of improvement. In order:

1. "Build X based on the idiom Y, and a landing page that launches it."
2. "Now let's try the Blender scene idea."
3. "Build out the rest of the environment in Blender, and make this look really good."
4. "Five or ten more scenarios that change game to game; better-modelled animals; maybe a puzzle
   to get into the barn."
5. "Bring this from simply amusing to really funny. And beautiful."
6. "Finishing touches?"
7. "Make the island layout more complex."

The pattern: build something whole, look at it, then ask for one dimension to get better. Open
requests such as "make it funnier" worked because the premise supplied the material.

## 7. Where this build stands

Checked on 14 November 2026 against the code in this repository.

**What holds up**

- The play-through passes: the five jobs it was given, the finale trigger, the barn puzzle and
  13 secrets, in about two seconds, with no console errors.
- `blender/layout.json` matches `src/layout.js`, and a draft bake passes the ground-height
  assert.
- No sound clips. The loudest case measured (thunder, a job fanfare, an oink and the full band
  together) peaks at -5.1 dB.
- At 390 pixels wide nothing in the HUD runs off the screen.
- The whole game is about 5.4 MB to download and needs no build step.

**What the next game should do better**

- **The play-through covers part of the game.** It plays 7 of the 12 jobs (not the needle,
  clovers, lightning, snowball or cows), finds 13 of the 15 secrets, and stops when the finale
  begins, so the flight over the moon and the win screen are never tested. It is also pasted into
  the console by hand. Step 4 exists to prevent this.
- **A draft bake overwrites the shipped world.** `npm run bake:draft` writes a draft-quality
  `assets/world.glb` over the real one, and nothing stops it being committed. Drafts should go
  to their own file.
- **One file holds the game.** `src/game.js` is 1,932 lines. It worked for one session; it will
  be slow to change in a second.
- **The world is most of the download.** `assets/world.glb` is 4.7 MB of the 5.4 MB.
- **The sound check's pitch figure is unreliable** for short, noisy sounds (it reports the wing
  flap at 37 kHz). Trust its levels, not its pitch.
- **A narrow desktop window** puts the key hints on top of the launcher link. Phones hide the
  hints, so they are unaffected.
- **Not checked here:** how the sound pass sounds to a person, touch controls on a real phone,
  and a slow machine. None of these can be checked by an agent.
