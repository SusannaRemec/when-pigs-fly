// Writes blender/layout.json from src/layout.js, for blender/world_bake.py.
//   node tools/dump-layout.mjs
import { writeFileSync } from 'node:fs';
import * as L from '../src/layout.js';

const samples = [];
for (const [x, z] of [[17, 14], [48, -48], [-79, 79], [-70, 70], [-66, 66], [-24, -88], [88, 23]]) samples.push([x, z, L.groundY(x, z)]);
for (let i = 0; i < 60; i++) {
  const x = Math.sin(i * 12.9898) * 115, z = Math.cos(i * 78.233) * 115;
  samples.push([x, z, L.groundY(x, z)]);
}
const out = {
  P: L.P, FLATS: L.FLATS, ISLAND_R: L.ISLAND_R, WATER_Y: L.WATER_Y, SUN_DIR: L.SUN_DIR, PATHS: L.PATHS,
  HAY_SPOTS: L.HAY_SPOTS, CLOVERS: L.CLOVERS, SIGNS: L.SIGNS, COW_STARTS: L.COW_STARTS,
  SOLIDS: L.SOLIDS, FAIRY_RINGS: L.FAIRY_RINGS, SPOTS: L.SPOTS, HEADLAND: L.HEADLAND, CAUSEWAY: L.CAUSEWAY, BRIDGE: L.BRIDGE, bridgeEnd: L.bridgeY(L.BRIDGE.half), CLOUD9: L.CLOUD9, DUCKS: L.DUCKS, PLATES: L.PLATES, BARN_FLOOR: L.BARN_FLOOR, BARN_RAMP: L.BARN_RAMP, DOOR_HW: L.DOOR_HW, TREES: L.TREES, BOULDERS: L.BOULDERS, samples,
};
writeFileSync(new URL('../blender/layout.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`layout.json: ${L.TREES.length} trees, ${L.BOULDERS.length} boulders, ${L.SOLIDS.length} solids`);
