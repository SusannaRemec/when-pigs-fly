import * as THREE from 'three';
import { GLTFLoader } from '../vendor/loaders/GLTFLoader.js';
import { DRACOLoader } from '../vendor/loaders/DRACOLoader.js';

// The animals are modelled in Blender (blender/critters.py -> assets/critters.glb): one node per
// animal, with body, head, legs and tail as children whose origins sit on their joints.
const LEGS = ['leg_fl', 'leg_fr', 'leg_bl', 'leg_br', 'leg_l', 'leg_r'];

export async function loadCritters(url = './assets/critters.glb') {
  const loader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath('./vendor/draco/'));
  const gltf = await loader.loadAsync(url);
  return {
    // A fresh animal: { group, body, head, legs, tail, parts, material }. It faces +Z, feet on y = 0.
    make(name) {
      const src = gltf.scene.getObjectByName(name);
      if (!src) throw new Error(`No animal called ${name} in ${url}`);
      const group = src.clone(true);
      group.position.set(0, 0, 0);
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
      const parts = {};
      group.traverse((o) => {
        if (o.name.startsWith(name + '_')) parts[o.name.slice(name.length + 1)] = o;
        if (o.isMesh) { o.material = material; o.castShadow = true; }
      });
      return {
        group, parts, material,
        body: parts.body, head: parts.head || null, tail: parts.tail || null,
        legs: LEGS.filter((k) => parts[k]).map((k) => parts[k]),
      };
    },
  };
}

// Walk cycle: legs swing in diagonal pairs by `stride` radians; the tail wags a little.
export function pose(c, phase, stride, t = 0) {
  c.legs.forEach((leg, i) => { leg.rotation.x = Math.sin(phase + (i === 0 || i === 3 ? 0 : Math.PI)) * stride; });
  if (c.tail) c.tail.rotation.z = Math.sin(t * 5) * 0.18;
}
