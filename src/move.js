// How the pig's body moves: steering, falling, staying on the island, bumping into things and
// landing. Pure numbers, no three.js and no sound, so the game and the tests run the same code
// (tools/test-node.mjs walks a pig over the whole island with it).
//
// A body is { x, y, z, yaw, speed, vy, grounded }. Every function changes it in place.

export const WALK = 9, TROT = 13.5, GRAVITY = 22, PIG_R = 0.9, STEP_UP = 0.7;

// Turn and move along the ground plane. fwd and turn are -1..1; airSpeed is the top speed in flight.
export function steer(b, { turn, fwd, sprint, airSpeed }, dt) {
  b.yaw += turn * (b.grounded ? 2.6 : 2.1) * dt;
  const top = b.grounded ? (sprint ? TROT : WALK) : airSpeed;
  const target = fwd > 0 ? top * fwd : fwd * 4;
  b.speed += (target - b.speed) * Math.min(1, dt * (b.grounded ? 6 : 2.2));
  b.x += Math.sin(b.yaw) * b.speed * dt;
  b.z += Math.cos(b.yaw) * b.speed * dt;
}

// Gravity, when airborne. slowest is the gentlest fall a glide allows (a negative speed), or null.
export function fall(b, slowest, dt) {
  if (b.grounded) return;
  b.vy -= GRAVITY * dt;
  if (slowest !== null) b.vy = Math.max(b.vy, slowest);
  b.y += b.vy * dt;
}

// Keep the pig near the island. Wading has a limit: slide along it, or failing that drift home.
// shore remembers the last allowed spot between frames: { x, z }.
export function contain(b, shore, offshore, { far = 185, wade = 7 } = {}) {
  const r = Math.hypot(b.x, b.z);
  if (r > far) { b.x *= far / r; b.z *= far / r; }
  if (b.grounded && offshore(b.x, b.z) > wade) {
    if (offshore(b.x, shore.z) <= wade) b.z = shore.z;
    else if (offshore(shore.x, b.z) <= wade) b.x = shore.x;
    else if (offshore(shore.x, shore.z) <= wade) { b.x = shore.x; b.z = shore.z; }
    else { b.x *= 0.985; b.z *= 0.985; }
  }
  shore.x = b.x; shore.z = b.z;
}

// Push the pig out of anything solid. Colliders are circles { x, z, r, top } or boxes
// { x, z, hx, hz, top }, with an optional bottom; a pig above top or below bottom passes.
export function collide(b, dt, colliders, onHit) {
  for (const c of colliders) {
    if (b.y > c.top || (c.bottom !== undefined && b.y < c.bottom)) continue;
    if (c.r !== undefined) {
      const dx = b.x - c.x, dz = b.z - c.z, d = Math.hypot(dx, dz), min = c.r + PIG_R;
      if (d < min && d > 0.0001) {
        if (onHit) onHit(c);
        // push out, and slip sideways so a head-on bump slides past
        const side = Math.sin(b.yaw) * dz - Math.cos(b.yaw) * dx >= 0 ? 1 : -1;
        const slip = Math.abs(b.speed) * 0.6 * dt * side;
        b.x = c.x + (dx / d) * min + (dz / d) * slip;
        b.z = c.z + (dz / d) * min - (dx / d) * slip;
      }
    } else {
      const dx = b.x - c.x, dz = b.z - c.z, hx = c.hx + PIG_R, hz = c.hz + PIG_R;
      if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
        if (onHit) onHit(c);
        if (hx - Math.abs(dx) < hz - Math.abs(dz)) b.x = c.x + Math.sign(dx || 1) * hx;
        else b.z = c.z + Math.sign(dz || 1) * hz;
      }
    }
  }
}

// Stand on whatever is underfoot, or leave the ground. Returns the vertical speed the pig had
// if it landed this frame (negative when falling), otherwise null.
export function land(b, standY) {
  const gy = Math.max(standY(b.x, b.z), -1.0);
  if (b.y <= gy || (b.grounded && b.y - gy < STEP_UP)) {
    const hit = b.grounded ? null : b.vy;
    b.grounded = true; b.y = gy; b.vy = 0;
    return hit;
  }
  b.grounded = false;
  return null;
}
