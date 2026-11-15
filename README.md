# When Pigs Fly

A small 3D browser game. You are a pig, and the odds of you flying are 1 in 3,720,000.
Do five impossible things (a different five each game, out of twelve), grow a pair of wings,
and get over the blue moon. The island keeps fifteen secrets, and the barn is locked.

**Play:** https://susannaremec.github.io/when-pigs-fly/

Controls: W A S D to move, SPACE to hop and flap, SHIFT to trot, E to oink, V to change view, M to mute.
On a phone, drag to steer and use the FLAP and OINK buttons.

**Stuck?** The small "stuck?" link (bottom left on a phone) puts the pig back where it was a
few seconds earlier and saves a report of the last ten seconds: positions, speeds, what it bumped
into, what the controls were doing, any errors the game threw and whether the browser took the
picture away. Nothing is sent anywhere. On a phone the share sheet opens
so you can pass the report on; elsewhere it is copied to the clipboard. The last three reports
stay in the browser under `wpf-stuck`.

## Run it locally

    npm start        # serves the folder at http://localhost:4173
    npm test         # plays the whole game in headless Chrome, desktop and phone size (about 20 seconds)

`play.html?seed=7` replays a particular draw; `play.html?feats=stone,hens,dog,cats,pot` picks the five jobs by hand.

## How it is made

- Three.js, no build step. The game is `src/game.js`; the launcher page is `index.html`.
- The island and the animals are modelled and light-baked in headless Blender:
  `npm run bake` (about two minutes) and `npm run bake:critters`.
- `src/move.js` is how the pig moves and `src/telemetry.js` is the stuck recorder. Neither uses
  three.js, so the tests run the same code the game does.
- `src/layout.js` holds the island's shape and where everything is. The game reads it for
  collisions and the Blender script reads it for building, so the two stay in step.
