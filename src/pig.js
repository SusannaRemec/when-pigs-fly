import * as THREE from 'three';

// The pig faces +Z. Origin is at ground level between its hooves.
// `critters` comes from loadCritters() in critters.js; the pig itself is modelled in Blender.
const WHITE = new THREE.Color(0xffffff), SOOT = new THREE.Color(0x3d3338), GOLD = new THREE.Color(0xffc93c);

export function createPig(critters) {
  const c = critters.make('pig');
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  const body = c.group; // everything bobs together
  group.add(body);

  // One modelled wing reaches along +X from the shoulder; the other side is its mirror image.
  const wingSrc = c.parts.wing;
  const shoulder = wingSrc.position.clone();
  body.remove(wingSrc);
  const feather = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
  const makeWing = (sign) => {
    const pivot = new THREE.Group();
    pivot.position.set(sign * shoulder.x, shoulder.y, shoulder.z);
    const wing = wingSrc.clone();
    wing.position.set(0, 0, 0);
    wing.material = feather;
    wing.castShadow = true;
    pivot.add(wing);
    body.add(pivot);
    return { pivot, wing };
  };
  const L = makeWing(1), R = makeWing(-1);

  let phase = 0, flapKick = 0, soot = 0, gold = false;
  const paint = () => {
    c.material.color.copy(WHITE).lerp(SOOT, soot);
    feather.color.copy(gold ? GOLD : WHITE).lerp(SOOT, soot * 0.8);
    feather.emissive.set(gold ? 0x5a3a00 : 0x000000);
    feather.metalness = gold ? 0.35 : 0;
  };

  return {
    group,
    body,
    setWingScale(s) {
      L.pivot.scale.set(s, s, s);
      R.pivot.scale.set(-s, s, s);
    },
    // 0..1: how sooty the pig is
    setSoot(v) { soot = Math.max(0, Math.min(1, v)); paint(); },
    setGoldWings(on) { gold = !!on; paint(); },
    kick() { flapKick = 1; },
    // state: { speed, airborne, t }
    update(dt, state) {
      const { speed = 0, airborne = false, t = 0 } = state;
      phase += dt * (airborne ? 16 : 4 + speed * 1.2);
      flapKick = Math.max(0, flapKick - dt * 3);

      const stride = airborne ? 0.25 : Math.min(1, speed / 6) * 0.7;
      c.legs.forEach((leg, i) => {
        const offset = (i === 0 || i === 3) ? 0 : Math.PI;
        leg.rotation.x = airborne ? 0.5 * (i < 2 ? -1 : 1) + Math.sin(phase * 0.5 + offset) * 0.15
                                  : Math.sin(phase + offset) * stride;
      });

      const angle = airborne ? Math.sin(phase) * (0.55 + flapKick * 0.35) + 0.1
                             : -1.2 + Math.sin(t * 3) * 0.04; // folded
      L.wing.rotation.z = angle;
      R.wing.rotation.z = angle;

      body.position.y = airborne ? Math.sin(phase) * -0.06 : Math.abs(Math.sin(phase)) * 0.07 * Math.min(1, speed / 4);
      c.tail.rotation.z = Math.sin(t * 9) * 0.25;
    },
  };
}
