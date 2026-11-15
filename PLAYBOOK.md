# Playbook: making a small 3D browser game with an AI coding agent

This is how *When Pigs Fly* was made in one long session with Claude Code, written up so the
same route can be followed for another game. It records the order things were done in, what each
step was for, and the mistakes that cost time.

The short version: **start with a joke and a playable toy, keep one file that says where
everything is, let Blender do the looks, let the browser do the feel, and never accept "it
works" without a screenshot or a measurement.**

## What you need

- Claude Code with a browser it can drive (Claude in Chrome) so it can look at its own work.
- Blender installed, runnable from the command line (`blender -b --python script.py`).
- Node, for a local copy of three.js and small scripts. No bundler, no framework.
- A static file server (`python3 -m http.server`).

## The shape of the project

    index.html, landing.css/js   launcher page
    play.html                    the game page: HUD markup and CSS only
    src/layout.js                where everything on the island is; pure data and maths
    src/game.js                  the game
    src/audio.js                 all sound, synthesised
    src/critters.js, pig.js      loads the Blender animals, animates them
    blender/world_bake.py        builds and light-bakes the island  -> assets/world.glb
    blender/critter_lib.py       animal builders                     -> assets/critters.glb
    tools/                       layout export, automated play-test, sound check

Three decisions carry most of the weight:

1. **One layout file, read by both sides.** `src/layout.js` has no three.js in it. The game
   imports it for collisions and ground height; a ten-line script dumps it to JSON for Blender.
   The Blender script re-implements the ground-height formula and *asserts* it against sample
   points from the JavaScript, so the two cannot drift apart silently.
2. **Bake what stands still, light what moves.** Scenery is drawn unlit with Cycles lighting
   baked in (a texture for the ground and barn, vertex colours for everything else). Animals and
   anything that tumbles are lit in real time by a sun pointing the same way as the baked one. A
   transparent copy of the terrain catches their shadows.
3. **Test hooks from day one.** The game exposes `window.__wpf` with teleport, face, key
   presses, a manual `step(dt)`, a debug camera and the game state. Every later check uses it.

## The order of work

### 1. Pick a premise that writes its own content
"When pigs fly" gave the whole design: idioms about impossible things become jobs, each job
shortens the odds, and the pig grows wings. A premise like this is worth more than a feature
list, because every later request ("more scenarios", "secrets", "make it funnier") has an
obvious source to draw from.

Prompt that started it: *a browser 3D game based on the idiom, plus a promotional launcher page.*

### 2. Build the toy first, with plain shapes
First version: boxes and spheres, five jobs, a win condition, a HUD, synthesised sound, and a
launcher page. It was ugly and complete. Do not polish anything until the loop is playable from
start to win.

### 3. Add Blender as a separate experiment
Before touching the game, make one stand-alone Blender render (the first poster). That proves
the headless pipeline works and gives a look to aim for.

### 4. Bake one building, then the whole world
Bake a single object (the barn) and load it in the game. Only once that round trip works,
move everything into the bake script. Give the script a `--draft` mode from the start; a
ten-second bake you run twenty times beats a two-minute bake you run twice.

### 5. Widen the game: a pool of jobs, a random draw
Twelve jobs exist; each game asks for five, chosen from a seed. Jobs not on the list still
work. `?seed=` and `?feats=` in the URL make any draw reproducible, which testing needs.

### 6. Model the characters in parallel
The animals were handed to a second agent with a written interface (node names, sizes, which
way they face, the JavaScript API) while the main thread built the island and game logic. This
only works when the two pieces touch through an interface you can write down in advance.

### 7. Make it funny
What moved it from amusing to funny, roughly in order of value for effort:

- **The world answers back.** Oinking near anything gets a reaction and a line.
- **Consequences stay visible.** Signs repaint when a job is done.
- **Callbacks.** The win triggers raining cats and dogs and a cow orbiting the moon.
- **A dry narrator** for idleness, failure and repetition, who never interrupts a message
  already on screen.
- **Secrets with hints.** The win screen names two you missed, which is the replay hook.

### 8. Make it beautiful
- Time of day tied to progress: one colour multiplies every baked material, and sky, fog,
  sea and lights follow the same curve. The finale is at twilight.
- Bloom, kept subtle. The first setting blew out in daylight; look before trusting it.
- Small living things: butterflies, fireflies, petals, birds. Cheap, and they do a lot.
- Game feel: squash on landing, screen shake, dust, a half-second of slow motion on success.

### 9. Complicate the map last
Headlands, an islet, a pond and a bridge went in late, once everything had a home. Because the
layout was one file, reshaping the coast meant changing one function and re-baking.

### 10. Ship it
Git from the first working version (this project left it too late). A static site needs
nothing more than GitHub Pages or Vercel pointed at the repository.

## How to check work you cannot see or hear

An agent's "done" means little without evidence. What was actually used:

- **Screenshots from a debug camera** after every visual change, from several angles.
- **An automated play-through** (`tools/playtest.js`) that steers the pig through every job,
  the puzzle and the secrets, stepping the simulation by hand so it runs in seconds.
  It tests rules, not feel; say so when reporting.
- **A narrow-screen check** by loading the game in a 390-pixel-wide frame. This found the one
  layout bug a desktop screenshot never would.
- **Offline audio rendering** (`tools/sound-check.html`): each sound is rendered without
  speakers and measured for peak level and clipping. This is not listening. It balanced the
  levels and caught a real bug, but only ears can say whether a moo sounds like a cow.
- **Loading the published link** after deploying, not only the local copy.

## Mistakes that cost time, and the rule each one taught

| What happened | Rule |
|---|---|
| The game silently failed to load after adding a loader that imported a file not yet copied in. | After adding any module, load the page and read the console before doing anything else. |
| Long thin parts baked black: light was sampled only at their buried end vertices. | With vertex-colour baking, cut long parts so they have vertices out in the open. |
| A boulder landed on a path; a prop spot landed inside a tree. | Anything placed by rule needs an explicit keep-out check against everything else. |
| Objects that move left their baked shadow behind on the ground. | Bake movable objects without a shadow of their own; give them a live one. |
| The camera ended up inside the barn, and inside trees. | Third-person cameras need their own obstacle rules. Test by standing next to things. |
| A HUD line showed as struck through because a toggle was passed `undefined`. | Look at the HUD in screenshots too, not just the 3D view. |
| The phone layout overlapped badly. | Check a narrow screen before calling any HUD change finished. |
| The play-test reported the barn puzzle broken; the test had stepped on the wrong plate. | When a test fails after an unrelated change, suspect the test as well as the game. |
| A batch of scheduled sounds rendered far too loud; a gain sat at full until its start time. | Measure audio, and start every gain at zero. |
| Commits were about to publish a personal email address. | Before the first public push, check what the history contains. |

## Prompts that worked well

They were short, and each one asked for one kind of improvement:

- "Build X based on the idiom Y, and a landing page that launches it."
- "Now let's try the Blender scene idea."
- "Build out the rest of the environment in Blender, and make this look really good."
- "Five or ten more scenarios that change game to game; better-modelled animals; maybe a
  puzzle to get into the barn."
- "Bring this from simply amusing to really funny. And beautiful."
- "Finishing touches?"
- "Make the island layout more complex."

The pattern: build something whole, look at it, then ask for one dimension to get better.
Open requests ("make it funnier") worked because the premise supplied the material.

## A checklist for the next game

1. One-line premise that generates content by itself.
2. Playable grey-box version with a win state, HUD and test hooks.
3. `git init`.
4. Shared layout file; export to JSON; ground-height parity assert.
5. Bake one object end to end; add `--draft`.
6. Bake the world; real-time lights only for what moves.
7. Automated play-through script; keep it passing.
8. Content pool with a seeded draw.
9. Characters, through a written interface.
10. Reactions, callbacks, secrets, narrator.
11. Time of day, bloom, ambient life, game feel.
12. Sound: effects, adaptive music, ambience; measure levels; then have a person listen.
13. Narrow-screen check, loading state, slow-machine fallback.
14. Publish; load the public link; send it to someone who has never seen it.
