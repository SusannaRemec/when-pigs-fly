"""The whole When Pigs Fly island, built and light-baked in Blender.

    node tools/dump-layout.mjs                       # refresh blender/layout.json from src/layout.js
    blender -b --python blender/world_bake.py -- [--draft] [--tex 4096] [--samples 64]

Writes assets/world.glb with four objects, in game coordinates (Y up):
  terrain  ground, lighting and shadows baked into one texture
  barn     barn and silo, baked into a second texture
  props    trees, rocks, plants, fences, windmill tower, farm clutter; light baked into vertex colours
  blades   windmill sails, separate so the game can turn them
The game draws all of it unlit, so what shows in the browser is the Cycles lighting.

Blender axes -> game axes: (x, y, z) -> (x, z, -y).
"""
import bpy, bmesh, json, math, os, random, sys
import numpy as np
from mathutils import Vector, Matrix, noise

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
DRAFT = '--draft' in argv
TEX = int(argv[argv.index('--tex') + 1]) if '--tex' in argv else (1024 if DRAFT else 4096)
SAMPLES = int(argv[argv.index('--samples') + 1]) if '--samples' in argv else (12 if DRAFT else 64)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
L = json.load(open(os.path.join(ROOT, 'blender', 'layout.json')))
P, FLATS, IR = L['P'], L['FLATS'], L['ISLAND_R']
random.seed(11)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ------------------------------------------------------------------ maths shared with the game
def sstep(a, b, v):
    t = np.clip((v - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def raw_y(x, z):
    y = 1.3 * np.sin(x * 0.07) * np.cos(z * 0.06) + 0.7 * np.sin(x * 0.13 + 1.7) * np.sin(z * 0.11 + 0.5) + 1.3
    y = y + 11 * np.exp(-((x - P['hill']['x']) ** 2 + (z - P['hill']['z']) ** 2) / 169)
    y = y + 4.5 * np.exp(-((x - P['stone']['x']) ** 2 + (z - P['stone']['z']) ** 2) / 81)
    return y - P['pond']['depth'] * np.exp(-((x - P['pond']['x']) ** 2 + (z - P['pond']['z']) ** 2) / P['pond']['s'] ** 2)


def offshore(x, z):
    """How far out to sea a point is (<= 0 on land): headlands, the islet and its causeway."""
    h, c = L['HEADLAND'], L['CAUSEWAY']
    coast = IR + h['out'] * np.maximum(0, np.sin(h['n'] * np.arctan2(z, x) + h['phase'])) ** 1.5
    dx, dz = c['bx'] - c['ax'], c['bz'] - c['az']
    t = np.clip(((x - c['ax']) * dx + (z - c['az']) * dz) / (dx * dx + dz * dz), 0, 1)
    return np.minimum(np.minimum(np.hypot(x, z) - coast, np.hypot(x - P['islet']['x'], z - P['islet']['z']) - P['islet']['r']),
                      np.hypot(x - c['ax'] - dx * t, z - c['az'] - dz * t) - c['hw'])


def gy_np(x, z):
    y = raw_y(x, z)
    for f in FLATS:
        t = 1 - sstep(f['r'], f['r'] * 1.7, np.hypot(x - f['x'], z - f['z']))
        y = y + (raw_y(f['x'], f['z']) - y) * t
    off = np.maximum(offshore(x, z), 0)
    return y - (off / 10) ** 2 * 5


def gy(x, z):
    return float(gy_np(np.float64(x), np.float64(z)))


for sx, sz, sy in L['samples']:
    assert abs(gy(sx, sz) - sy) < 1e-6, 'ground height here does not match src/layout.js'


def path_dist(x, z):
    best = np.full(np.shape(x), 1e9) if np.ndim(x) else 1e9
    for p in L['PATHS']:
        for (ax, az), (bx, bz) in zip(p, p[1:]):
            dx, dz = bx - ax, bz - az
            t = np.clip(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1)
            best = np.minimum(best, np.hypot(x - ax - dx * t, z - az - dz * t))
    return best


def G(x, z, h=0.0):
    """Game ground position (x, z) plus height h, as a Blender vector."""
    return Vector((x, -z, gy(x, z) + h))


def C(hexcol):
    def f(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (f(hexcol >> 16 & 255), f(hexcol >> 8 & 255), f(hexcol & 255))


def mixc(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def tint(c, amt=0.08):
    return tuple(max(0, v * (1 + random.uniform(-amt, amt))) for v in c)


T = Matrix.Translation
def Rz(a): return Matrix.Rotation(a, 4, 'Z')
def Rx(a): return Matrix.Rotation(a, 4, 'X')
def Ry(a): return Matrix.Rotation(a, 4, 'Y')
def S(x, y=None, z=None): return Matrix.Diagonal((x, x if y is None else y, x if z is None else z, 1))

# ------------------------------------------------------------------ vertex-coloured mesh builder
bm = COL = None


def use(target):
    global bm, COL
    bm = target
    COL = bm.loops.layers.float_color.get('albedo') or bm.loops.layers.float_color.new('albedo')


def add(verts, M, c, c2=None, smooth=False, var=0.05, fn=None):
    """Place a fresh primitive and paint it: flat colour c, a bottom-to-top blend c -> c2, or fn(face, vert)."""
    if M is not None:
        bmesh.ops.transform(bm, matrix=M, verts=verts)
    faces = {f for v in verts for f in v.link_faces}
    zs = [v.co.z for v in verts]
    z0, dz = min(zs), max(max(zs) - min(zs), 1e-6)
    for f in faces:
        f.smooth = smooth
        k = 1 + random.uniform(-var, var)
        if fn:
            f.normal_update()
        for l in f.loops:
            rgb = fn(f, l.vert) if fn else (mixc(c, c2, (l.vert.co.z - z0) / dz) if c2 else c)
            l[COL] = (rgb[0] * k, rgb[1] * k, rgb[2] * k, 1)
    return verts


def slice_prim(verts, axis, cuts):
    """Cut a fresh primitive across its local axis. Light is baked per vertex, and a long part
    whose only vertices are buried in its neighbours (a rail between posts, a trunk between
    ground and leaves) would otherwise come out black from end to end."""
    for c in cuts:
        geom = list(verts) + list({e for v in verts for e in v.link_edges}) + list({f for v in verts for f in v.link_faces})
        co, no = Vector((0, 0, 0)), Vector((0, 0, 0))
        co[axis], no[axis] = c, 1
        res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no)
        verts += [g for g in res['geom_cut'] if isinstance(g, bmesh.types.BMVert)]
    return verts


def box(M, c, zc=(), xc=(), **k):
    v = bmesh.ops.create_cube(bm, size=1)['verts']
    slice_prim(v, 2, zc)
    slice_prim(v, 0, xc)
    return add(v, M, c, **k)


def post(M, w, h, c, **k):
    """Upright box standing on the origin of M, cut near the foot so only the foot is dark."""
    return box(M @ T((0, 0, h / 2)) @ S(w, w, h), c, zc=(-0.5 + min(0.3, 0.22 / h), 0.0), **k)


def cyl(M, r1, r2, h, c, seg=10, cuts=None, **k):
    """Upright cylinder or cone with its base at the origin of M."""
    v = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r1, radius2=max(r2, 0.012), depth=h)['verts']
    if cuts is None:
        cuts = (0.1, 0.5, 0.9) if h > 0.8 else ()
    slice_prim(v, 2, [(f - 0.5) * h for f in cuts])
    k.setdefault('smooth', True)
    return add(v, M @ T((0, 0, h / 2)), c, **k)


def ico(M, r, c, sub=1, jit=0.0, seed=0.0, **k):
    v = bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)['verts']
    if jit:
        off = Vector((seed * 0.371, seed * 0.113, seed * 0.07))
        for p in v:
            p.co *= 1 + noise.noise(p.co * (1.1 / r) + off) * jit
    return add(v, M, c, **k)


def beam(a, b, w, h, c, **k):
    a, b = Vector(a), Vector(b)
    d = b - a
    n = d.length
    inset = 0.5 - min(0.3, 0.28 / n)
    xc = (-inset, 0.0, inset) if n > 0.9 else ()
    return box(T((a + b) / 2) @ d.to_track_quat('X', 'Z').to_matrix().to_4x4() @ S(n, w, h), c, xc=xc, **k)


def finish(target, name):
    for e in target.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(38):
            e.smooth = False
    me = bpy.data.meshes.new(name)
    target.to_mesh(me)
    target.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    return ob


# ------------------------------------------------------------------ where things may go
SOLIDS = L['SOLIDS']
BARN, FIELD, MILL = P['barn'], P['field'], P['mill']


def near(x, z, pts, d):
    return any(math.hypot(x - p['x'], z - p['z']) < d for p in pts)


def in_field(x, z, pad=0.8):
    return abs(x - FIELD['x']) < FIELD['hx'] + pad and abs(z - FIELD['z']) < FIELD['hz'] + pad


def built_on(x, z, pad=0.6):
    for s in SOLIDS:
        if 'r' in s:
            if math.hypot(x - s['x'], z - s['z']) < s['r'] + pad:
                return True
        elif abs(x - s['x']) < s['hx'] + pad and abs(z - s['z']) < s['hz'] + pad:
            return True
    return False


CLEAR = ([(P['camp']['x'], P['camp']['z'], 4.2), (P['hole']['x'], P['hole']['z'], 3.0), (P['cats']['x'], P['cats']['z'], 3.0),
          (P['coop']['x'], P['coop']['z'] + 2.5, 4.0), (P['kennel']['x'], P['kennel']['z'] + 2.5, 3.0), (P['stone']['x'], P['stone']['z'], 2.6),
          (P['horse']['x'], P['horse']['z'], 2.6), (BARN['x'] + 6.5, BARN['z'], 2.6), (P['crate']['x'], P['crate']['z'], 1.6),
          (P['camp']['x'] - 4.6, P['camp']['z'] - 1.5, 2.6)]
         + [(p['x'], p['z'], 1.4) for p in L['PLATES']])


def meadow(x, z, path=1.9):
    """True where grass grows: not sand, path, building, pit, snow or crop field."""
    if gy(x, z) < 0.55 or path_dist(x, z) < path or built_on(x, z) or in_field(x, z):
        return False
    if any(math.hypot(x - cx, z - cz) < cr for cx, cz, cr in CLEAR):
        return False
    if math.hypot(x - P['pond']['x'], z - P['pond']['z']) < 5.6 or math.hypot(x - P['islet']['x'], z - P['islet']['z']) < 3.6:
        return False
    if math.hypot(x - P['pit']['x'], z - P['pit']['z']) < 9.3 or math.hypot(x - P['snow']['x'], z - P['snow']['z']) < 6.4:
        return False
    return not near(x, z, L['HAY_SPOTS'], 2.7) and math.hypot(x, z) > 2.2 and gy(x, z) < 8.3


def scatter(n, ok, rmax=81.0, tries=40):
    out = []
    for _ in range(n * tries):
        if len(out) >= n:
            break
        a, r = random.uniform(0, math.tau), rmax * math.sqrt(random.random())
        x, z = math.cos(a) * r, math.sin(a) * r
        if ok(x, z):
            out.append((x, z))
    return out


# ================================================================== PROPS
props = bmesh.new()
use(props)

BARK, BARK_D = C(0x7a5233), C(0x4f3423)
WOOD, WOOD_D, WHITE = C(0x9b6b3f), C(0x6b4423), C(0xfff6e9)
STONE, STONE_D, MOSS = C(0x9a948c), C(0x6f6a66), C(0x6f9a4a)
STRAW = C(0xe6c355)


# ---- trees
def pine(M, seed, snowy=False):
    lo, hi = tint(C(0x2c7a48)), tint(C(0x58b36a))
    cyl(M, 0.36, 0.2, 2.6, BARK_D, c2=BARK, seg=7, cuts=(0.12, 0.3, 0.5))
    tiers = 4
    for i in range(tiers):
        r, h, z = 2.05 - i * 0.43, 2.15 - i * 0.16, 1.45 + i * 1.13
        v = bmesh.ops.create_cone(bm, cap_ends=True, segments=9, radius1=r, radius2=0.012, depth=h)['verts']
        for p in v:  # ragged, drooping skirt
            if p.co.z < 0:
                k = 1 + noise.noise(Vector((p.co.x, p.co.y, seed + i * 3.1))) * 0.22
                p.co.x *= k
                p.co.y *= k
                p.co.z -= random.uniform(0, 0.28)
        a, b = mixc(lo, hi, i / tiers), mixc(lo, hi, (i + 1.3) / tiers)
        snow = C(0xf4f9ff)
        fn = (lambda f, p: snow if f.normal.z > 0.25 else a) if snowy else None
        add(v, M @ T((0, 0, z + h / 2)) @ Rz(random.uniform(0, 6.3)) @ Rx(random.uniform(-0.05, 0.05)), a, c2=b, fn=fn)


def leafy(M, seed, blossom=False):
    lo, hi = (tint(C(0xe9799f)), tint(C(0xffd3e2))) if blossom else (tint(C(0x3f9350)), tint(C(0x86cc66)))
    cyl(M, 0.42, 0.26, 3.0, BARK_D, c2=BARK, seg=7, cuts=(0.1, 0.3, 0.55, 0.72))
    for a in (0.9, 3.4):
        beam((M @ Vector((0, 0, 2.2))), (M @ Vector((math.cos(a) * 0.9, math.sin(a) * 0.9, 3.2))), 0.16, 0.16, BARK)
    blobs = [(0, 0, 4.0, 1.95)]
    for i in range(4):
        a = i * 1.57 + random.uniform(-0.4, 0.4)
        blobs.append((math.cos(a) * 1.15, math.sin(a) * 1.15, random.uniform(3.3, 4.5), random.uniform(1.05, 1.4)))
    zmin, zmax = 2.4, 5.9
    for j, (x, y, z, r) in enumerate(blobs):
        def fn(f, p, lo=lo, hi=hi):
            t = min(1, max(0, (M.inverted() @ p.co).z - zmin) / (zmax - zmin))
            return mixc(lo, hi, t * 0.75 + (0.25 if f.normal.z > 0.3 else 0))
        ico(M @ T((x, y, z)) @ S(1, 1, 0.86), r, lo, sub=2, jit=0.16, seed=seed + j * 7, fn=fn, var=0.07)


def dead(M, seed):
    c0, c1 = C(0x2c2224), C(0x55474a)
    cyl(M @ Ry(0.06), 0.34, 0.1, 5.2, c0, c2=c1, seg=6)
    for i in range(5):
        a, z = seed + i * 1.9, 1.9 + i * 0.62
        tip = Vector((math.cos(a) * (1.7 - i * 0.2), math.sin(a) * (1.7 - i * 0.2), z + 1.1))
        beam(M @ Vector((0, 0, z)), M @ tip, 0.11, 0.11, c1)
        beam(M @ tip, M @ (tip + Vector((math.cos(a + 1) * 0.5, math.sin(a + 1) * 0.5, 0.5))), 0.07, 0.07, c1)


for t in L['TREES']:
    M = T(G(t['x'], t['z'], -0.12)) @ Rz(t['seed'] * 0.77) @ S(t['s'])
    {'pine': pine, 'snowpine': lambda M, s: pine(M, s, True), 'round': leafy,
     'blossom': lambda M, s: leafy(M, s, True), 'dead': dead}[t['kind']](M, t['seed'] % 97)


# ---- rocks
def rock(M, r, seed, sub=1, mossy=True):
    base, dark = tint(STONE, 0.1), tint(STONE_D, 0.1)
    def fn(f, p):
        c = mixc(dark, base, min(1, max(0, f.normal.z * 0.6 + 0.5)))
        return mixc(c, MOSS, 0.45) if mossy and f.normal.z > 0.72 else c
    ico(M, r, base, sub=sub, jit=0.3, seed=seed, fn=fn, var=0.06)


for b in L['BOULDERS']:
    rock(T(G(b['x'], b['z'], b['r'] * 0.25)) @ Rz(b['seed']) @ S(1, random.uniform(0.8, 1.15), 0.8), b['r'], b['seed'] % 89, sub=2)
for x, z in scatter(150, lambda x, z: gy(x, z) > -0.3 and not built_on(x, z) and path_dist(x, z) > 1.2 and not in_field(x, z), rmax=122):
    r = random.uniform(0.14, 0.42)
    rock(T(G(x, z, r * 0.15)) @ Rz(random.uniform(0, 6)) @ S(1, random.uniform(0.7, 1.2), 0.65), r, random.uniform(0, 90), sub=1, mossy=r > 0.3)
for i in range(11):  # sea stacks, out past where a walking pig can reach
    a, r = i * 0.571 + random.uniform(-0.15, 0.15), random.uniform(93, 101)
    s = random.uniform(1.4, 3.2)
    while gy(math.cos(a) * r, math.sin(a) * r) > -3.5:   # clear of the headlands and the islet
        r += 3
    rock(T((math.cos(a) * r, math.sin(a) * r, -1.4)) @ Rz(a) @ S(1, 0.85, random.uniform(1.0, 1.6)), s, i * 5.3, sub=2)
for i in range(4):  # cairn at the foot of the lightning rod
    a = i * 1.6 + 0.4
    rock(T(G(P['hill']['x'] + math.cos(a) * 0.75, P['hill']['z'] + math.sin(a) * 0.75, 0.12)) @ S(1, 1, 0.7), 0.42, i * 3.3, mossy=False)

# ---- grass tufts, patchy
GR0, GR1 = C(0x4f9a42), C(0xa6de6c)
tufts = scatter(700 if DRAFT else 3000, lambda x, z: meadow(x, z) and noise.noise(Vector((x * 0.07, z * 0.07, 3.3))) > -0.12, rmax=120)
for x, z in tufts:
    base = G(x, z, -0.03)
    s = random.uniform(0.7, 1.35)
    for i in range(random.randint(3, 5)):
        a = random.uniform(0, 6.28)
        d = Vector((math.cos(a), math.sin(a), 0))
        side = Vector((-d.y, d.x, 0)) * 0.055 * s
        root = base + d * 0.05
        tip = root + d * random.uniform(0.08, 0.24) * s + Vector((0, 0, random.uniform(0.26, 0.52) * s))
        f = bm.faces.new((bm.verts.new(root - side), bm.verts.new(root + side), bm.verts.new(tip)))
        g1 = tint(GR1, 0.1)
        for l, c in zip(f.loops, (GR0, GR0, g1)):
            l[COL] = (*c, 1)

# ---- wildflowers, in drifts
PETALS = [(C(0xffffff), C(0xffd23f)), (C(0xffd84a), C(0xf08a24)), (C(0xff8fb3), C(0xfff0a8)), (C(0xb58cff), C(0xffe36e)), (C(0xf2543d), C(0x3a2c30))]
STEM = C(0x4f9a42)
for px, pz in scatter(16 if DRAFT else 52, lambda x, z: meadow(x, z, 2.6)):
    petal, eye = random.choice(PETALS)
    for _ in range(random.randint(7, 13)):
        a, r = random.uniform(0, 6.28), random.uniform(0, 2.6)
        x, z = px + math.cos(a) * r, pz + math.sin(a) * r
        if not meadow(x, z):
            continue
        h = random.uniform(0.28, 0.5)
        M = T(G(x, z))
        beam(M @ Vector((0, 0, 0)), M @ Vector((0, 0, h)), 0.035, 0.035, STEM)
        tilt = Rx(random.uniform(-0.5, 0.5)) @ Ry(random.uniform(-0.5, 0.5))
        v = bmesh.ops.create_circle(bm, cap_ends=True, cap_tris=True, segments=6, radius=random.uniform(0.11, 0.16))['verts']
        add(v, M @ T((0, 0, h)) @ tilt, tint(petal, 0.06))
        ico(M @ T((0, 0, h + 0.02)) @ tilt @ S(1, 1, 0.6), 0.05, eye, sub=0)

# ---- shrubs, mushrooms
for x, z in scatter(14 if DRAFT else 46, lambda x, z: meadow(x, z, 3.2)):
    lo, hi = tint(C(0x357f45)), tint(C(0x74bf5c))
    for i in range(random.randint(2, 4)):
        a = random.uniform(0, 6.28)
        r = random.uniform(0.42, 0.68)
        ico(T(G(x + math.cos(a) * 0.45, z + math.sin(a) * 0.45, r * 0.45)) @ S(1, 1, 0.72), r, lo, c2=hi, sub=1, jit=0.2, seed=x + i)
for t in random.sample(L['TREES'], 26):
    if t['kind'] in ('dead', 'snowpine'):
        continue
    for i in range(random.randint(1, 3)):
        a, r = random.uniform(0, 6.28), random.uniform(0.9, 1.7)
        x, z = t['x'] + math.cos(a) * r, t['z'] + math.sin(a) * r
        if not meadow(x, z, 1.0):
            continue
        s = random.uniform(0.7, 1.4)
        M = T(G(x, z, -0.02)) @ S(s)
        cyl(M, 0.07, 0.055, 0.24, C(0xf4ead8), seg=6)
        cyl(M @ T((0, 0, 0.2)), 0.21, 0.03, 0.15, C(0xe2483a), c2=C(0xf5705a), seg=8)

# ---- reeds along the shore
for i in range(20 if DRAFT else 64):
    a = random.uniform(0, math.tau)
    lo, hi = 78.0, 106.0
    for _ in range(18):  # find the waterline
        mid = (lo + hi) / 2
        if gy(math.cos(a) * mid, math.sin(a) * mid) > -0.42:
            lo = mid
        else:
            hi = mid
    for k in range(random.randint(4, 8)):
        x, z = math.cos(a) * lo + random.uniform(-0.7, 0.7), math.sin(a) * lo + random.uniform(-0.7, 0.7)
        base = G(x, z, -0.1)
        h = random.uniform(0.9, 1.7)
        lean = Vector((random.uniform(-0.2, 0.2), random.uniform(-0.2, 0.2), h))
        beam(base, base + lean, 0.05, 0.02, C(0x5e9a48), c2=C(0x9fcf6a))
        if k % 3 == 0:
            beam(base + lean * 0.86, base + lean * 1.08, 0.09, 0.09, C(0x6b4423))

# ---- cow pen: white picket ring with a gate gap facing game -z
PEN = P['pen']
posts = []
for i in range(16):
    a = i / 16 * math.tau
    if abs(a - math.pi * 1.5) < 0.5:
        posts.append(None)
        continue
    x, z = PEN['x'] + math.cos(a) * 5.4, PEN['z'] + math.sin(a) * 5.4
    posts.append((x, z))
    gate = abs(a - math.pi * 1.5) < 0.95
    hgt = 1.9 if gate else 1.5
    M = T(G(x, z, -0.1)) @ Rz(-a)
    post(M, 0.24, hgt, WHITE)
    cyl(M @ T((0, 0, hgt)) @ Rz(math.pi / 4), 0.2, 0.0, 0.22, WHITE, seg=4, smooth=False)
    if gate:
        ico(M @ T((0, 0, hgt + 0.3)), 0.15, C(0xe2447a), sub=1)
for a, b in zip(posts, posts[1:] + posts[:1]):
    if a and b:
        for h in (0.5, 1.05):
            beam(G(a[0], a[1], h), G(b[0], b[1], h), 0.09, 0.2, WHITE)
        for k in (0.33, 0.67):  # pickets
            x, z = a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k
            box(T(G(x, z, 0.65)) @ Rz(-math.atan2(b[1] - a[1], b[0] - a[0])) @ S(0.16, 0.06, 1.25), WHITE)
box(T(G(PEN['x'] + 2.2, PEN['z'] + 2.6, 0.32)) @ Rz(0.5) @ S(1.9, 0.75, 0.5), WOOD)       # water trough
box(T(G(PEN['x'] + 2.2, PEN['z'] + 2.6, 0.55)) @ Rz(0.5) @ S(1.65, 0.5, 0.06), C(0x4fb7e8))
ico(T(G(PEN['x'] - 2.4, PEN['z'] + 2.7, 0.3)) @ S(1.25, 1.0, 0.55), 0.9, STRAW, sub=1, jit=0.25, seed=5)

# ---- crop field: soil rows, cabbages and pumpkins, fence on two sides, scarecrow
SOIL = C(0x6f4a2e)
fx, fz, fhx, fhz = FIELD['x'], FIELD['z'], FIELD['hx'], FIELD['hz']
for r in range(6):
    z = fz - fhz + 0.9 + r * (2 * fhz - 1.8) / 5
    pts = [G(fx - fhx + 0.4 + i * 1.05, z, 0.02) for i in range(int((2 * fhx - 0.8) / 1.05) + 1)]
    for a, b in zip(pts, pts[1:]):
        beam(a, b + (b - a).normalized() * 0.1, 0.95, 0.34, SOIL, c2=tint(C(0x86603c)))
    for i, p in enumerate(pts):
        if r % 3 == 0:
            ico(T(p + Vector((0, 0, 0.32))) @ S(1, 1, 0.74), random.uniform(0.3, 0.42), C(0xe87a1c), c2=C(0xf7a437), sub=1, jit=0.1, seed=i + r)
            cyl(T(p + Vector((0, 0, 0.5))), 0.05, 0.03, 0.2, C(0x4f7a32), seg=5)
        elif r % 3 == 1:
            ico(T(p + Vector((0, 0, 0.3))) @ S(1, 1, 0.7), random.uniform(0.26, 0.36), C(0x5faa4a), c2=C(0xb4e07e), sub=1, jit=0.25, seed=i * 3 + r)
        else:
            for k in range(4):
                a = k * 1.57 + i
                beam(p + Vector((0, 0, 0.15)), p + Vector((math.cos(a) * 0.3, math.sin(a) * 0.3, random.uniform(0.6, 0.95))), 0.09, 0.02, C(0x4f9a42), c2=C(0x9ad86a))


def rail_fence(pts):
    for a, b in zip(pts, pts[1:]):
        for h in (0.45, 0.9):
            beam(a + Vector((0, 0, h)), b + Vector((0, 0, h)), 0.08, 0.16, tint(WOOD))
    for p in pts:
        post(T(p + Vector((0, 0, -0.15))) @ Rz(random.uniform(-0.1, 0.1)), 0.2, 1.3, tint(WOOD_D))


wx, sz_ = fx - fhx - 0.6, fz + fhz + 0.6
rail_fence([G(wx, fz - fhz - 0.6 + i * (2 * fhz + 1.2) / 5, 0) for i in range(6)])
rail_fence([G(wx + i * (2 * fhx + 1.2) / 6, sz_, 0) for i in range(7)])

sc = next(s for s in SOLIDS if s['kind'] == 'scarecrow')
M = T(G(sc['x'], sc['z'])) @ Rz(0.5)
post(M, 0.13, 2.6, WOOD_D)
box(M @ T((0, 0, 1.95)) @ S(0.1, 2.1, 0.1), WOOD_D)
box(M @ T((0, 0, 1.6)) @ S(0.36, 0.78, 0.95), C(0x3f6fc4), c2=C(0x6c98e6))
for s in (-1, 1):
    box(M @ T((0, s * 0.72, 1.92)) @ S(0.24, 0.62, 0.26), C(0x3f6fc4))
    for k in range(4):
        beam(M @ Vector((0, s * 1.02, 1.92)), M @ Vector((random.uniform(-0.15, 0.15), s * 1.32, 1.92 + random.uniform(-0.2, 0.2))), 0.04, 0.04, STRAW)
ico(M @ T((0, 0, 2.48)), 0.33, C(0xdcbd84), sub=2)
for s in (-1, 1):
    ico(M @ T((0.3, s * 0.12, 2.54)), 0.05, C(0x2a1820), sub=0)
cyl(M @ T((0, 0, 2.7)), 0.56, 0.56, 0.05, WOOD_D, seg=12)
cyl(M @ T((0, 0, 2.74)), 0.3, 0.2, 0.4, WOOD_D, c2=WOOD, seg=10)

# ---- well
w = next(s for s in SOLIDS if s['kind'] == 'well')
M = T(G(w['x'], w['z'], -0.1))
for i in range(12):  # ring of stones, two courses
    for row in range(3):
        a = (i + row * 0.5) / 12 * math.tau
        rock(M @ T((math.cos(a) * 1.05, math.sin(a) * 1.05, 0.2 + row * 0.34)) @ Rz(a) @ S(0.75, 1.15, 0.72), 0.3, i + row * 13, mossy=row == 0)
cyl(M @ T((0, 0, 0.7)), 0.95, 0.95, 0.05, C(0x16283a), seg=14)
for s in (-1, 1):
    post(M @ T((0, s * 1.05, 0)), 0.18, 3.0, WOOD_D)
for s in (-1, 1):
    box(M @ T((s * 0.52, 0, 3.02)) @ Ry(s * 0.62) @ S(1.45, 2.7, 0.09), C(0x8a4a3c))
beam(M @ Vector((0, -1.05, 2.3)), M @ Vector((0, 1.05, 2.3)), 0.11, 0.11, WOOD)
beam(M @ Vector((0, 0.1, 2.3)), M @ Vector((0, 0.1, 1.5)), 0.03, 0.03, C(0xd9c9a0))
cyl(M @ T((0, 0.1, 1.2)), 0.2, 0.25, 0.34, WOOD, seg=9)

# ---- hay cart and bales
c = next(s for s in SOLIDS if s['kind'] == 'cart')
M = T(G(c['x'], c['z'])) @ Rz(0.9)
box(M @ T((0, 0, 0.95)) @ S(2.5, 1.35, 0.14), WOOD)
for s in (-1, 1):
    box(M @ T((0, s * 0.66, 1.25)) @ S(2.5, 0.08, 0.5), tint(WOOD))
    cyl(M @ T((0, s * 0.8, 0.62)) @ Rx(math.pi / 2) @ T((0, 0, -0.07)), 0.62, 0.62, 0.14, WOOD_D, seg=14)
    cyl(M @ T((0, s * 0.83, 0.62)) @ Rx(math.pi / 2) @ T((0, 0, -0.09)), 0.14, 0.14, 0.18, C(0x3a2c30), seg=8)
    beam(M @ Vector((1.2, s * 0.5, 0.95)), M @ Vector((2.7, s * 0.5, 0.12)), 0.09, 0.09, WOOD_D)
box(M @ T((-1.22, 0, 1.25)) @ S(0.08, 1.35, 0.5), WOOD)
ico(M @ T((-0.1, 0, 1.5)) @ S(1.35, 0.8, 0.62), 0.85, C(0xcfa53c), c2=C(0xf2d468), sub=2, jit=0.22, seed=3)

b = next(s for s in SOLIDS if s['kind'] == 'bales')
M = T(G(b['x'], b['z'])) @ Rz(0.3)
for (x, y, z, rz) in ((-0.55, 0, 0.42, 0), (0.55, 0.1, 0.42, 0.08), (0, 0.05, 1.26, 1.45)):
    Mb = M @ T((x, y, z)) @ Rz(rz)
    box(Mb @ S(1.0, 1.6, 0.84), C(0xd9ad42), c2=C(0xf0cf62))
    for k in (-0.45, 0.45):
        box(Mb @ T((0, k, 0)) @ S(1.03, 0.05, 0.87), C(0xa8793a))

# ---- snow corner: drifts and a snowman
SNOW, SNOW_SH = C(0xf7fbff), C(0xcfe3f7)
sn = P['snow']
for i in range(11):
    a, r = i * 0.61, random.uniform(2.6, 6.2)
    x, z = sn['x'] + math.cos(a) * r, sn['z'] + math.sin(a) * r
    s = random.uniform(1.0, 2.1)
    ico(T(G(x, z, -0.05)) @ S(1, random.uniform(0.7, 1.1), 0.24), s, SNOW_SH, c2=SNOW, sub=2, jit=0.15, seed=i * 2.1, smooth=True, var=0.01)
m = next(s for s in SOLIDS if s['kind'] == 'snowman')
M = T(G(m['x'], m['z'])) @ Rz(2.6)
for z, r in ((0.6, 0.78), (1.6, 0.56), (2.32, 0.38)):
    ico(M @ T((0, 0, z)), r, SNOW_SH, c2=SNOW, sub=2, jit=0.05, seed=z, smooth=True, var=0.01)
cyl(M @ T((0.34, 0, 2.3)) @ Ry(math.pi / 2), 0.07, 0.0, 0.42, C(0xf08a24), seg=7)
for s in (-1, 1):
    ico(M @ T((0.33, s * 0.14, 2.44)), 0.05, C(0x1c1c22), sub=0)
    beam(M @ Vector((0, s * 0.45, 1.7)), M @ Vector((0.2, s * 1.25, 2.15)), 0.05, 0.05, BARK_D)
for k in range(3):
    ico(M @ T((0.53 - k * 0.02, 0, 1.3 + k * 0.28)), 0.055, C(0x1c1c22), sub=0)
cyl(M @ T((0, 0, 1.98)), 0.42, 0.42, 0.14, C(0xe2447a), seg=12)
cyl(M @ T((0, 0, 2.62)), 0.42, 0.42, 0.04, C(0x2a1820), seg=12)
cyl(M @ T((0, 0, 2.64)), 0.27, 0.25, 0.4, C(0x2a1820), seg=12)

# ---- windmill tower (the sails are their own object)
M = T(G(MILL['x'], MILL['z'], -0.15))
TOWER, TOWER_D = C(0xefe4d2), C(0xcdbfa6)
cyl(M, 3.25, 3.25, 0.7, STONE, seg=20)
cyl(M @ T((0, 0, 0.5)), 3.05, 2.15, 10.0, TOWER_D, c2=TOWER, seg=24, var=0.025, cuts=(0.04, 0.16, 0.3, 0.45, 0.6, 0.75, 0.88, 0.97))
for z in (3.7, 7.0):
    r = 3.05 - (z - 0.5) * 0.09
    cyl(M @ T((0, 0, z)), r + 0.07, r + 0.05, 0.22, TOWER_D, seg=24)
cyl(M @ T((0, 0, 10.4)), 2.5, 2.5, 0.3, WOOD_D, seg=24)                    # gallery lip
cyl(M @ T((0, 0, 10.6)), 2.55, 0.2, 3.0, C(0x7c3f35), c2=C(0xa85a49), seg=16, var=0.06)
ico(M @ T((0, 0, 13.7)), 0.22, C(0xffc93c), sub=1)
box(M @ T((2.93, 0, 1.85)) @ S(0.3, 1.5, 2.5), WHITE)                      # door, facing +x
box(M @ T((2.98, 0, 1.75)) @ S(0.3, 1.2, 2.2), WOOD_D)
for (a, z) in ((0, 6.0), (2.2, 4.6), (-2.2, 7.6), (3.3, 8.4)):
    r = 3.05 - (z - 0.5) * 0.09
    Mw = M @ Rz(a) @ T((r - 0.06, 0, z))
    box(Mw @ S(0.22, 1.0, 1.25), WHITE)
    box(Mw @ T((0.03, 0, 0)) @ S(0.22, 0.72, 0.97), C(0x2a2430))
HUB = (M @ Vector((2.55, 0, 11.3)))
cyl(M @ T((1.6, 0, 11.3)) @ Ry(math.pi / 2), 0.3, 0.3, 1.2, WOOD_D, seg=10)
for (x, y) in ((3.6, 2.3), (3.9, 1.3)):                                    # flour sacks by the door
    ico(M @ T((x, y, 0.75)) @ S(0.8, 0.8, 1.0), 0.45, C(0xd9c9a0), c2=C(0xf2e6c8), sub=2, jit=0.1, seed=x)
cyl(M @ T((3.5, -2.0, 0.55)), 0.45, 0.45, 0.95, WOOD, c2=WOOD_D, seg=12)   # barrel

# ================================================================== THE NEWER JOBS AND SECRETS
IRON, IRON_L = C(0x2b2a30), C(0x55535c)
CREAM, PLUM, GOLD, REDP = C(0xfff0d6), C(0x5a3b46), C(0xffc93c), C(0xc8372d)


def flat(pts, M, c, **k):
    """A flat fan of triangles through pts (x, y), lying on the local z = 0 plane."""
    ctr = bm.verts.new((sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), 0))
    ring = [bm.verts.new((x, y, 0)) for x, y in pts]
    for a, b in zip(ring, ring[1:] + ring[:1]):
        bm.faces.new((ctr, a, b))
    return add([ctr] + ring, M, c, **k)


def big_mushroom(M, s=1.0):
    cyl(M @ S(s), 0.09, 0.07, 0.34, C(0xf4ead8), seg=7, cuts=(0.3,))
    cyl(M @ S(s) @ T((0, 0, 0.3)), 0.3, 0.04, 0.2, C(0xd93a2e), c2=C(0xf5705a), seg=10, cuts=())
    for k in range(4):
        a = k * 1.7 + s * 5
        ico(M @ S(s) @ T((math.cos(a) * 0.15, math.sin(a) * 0.15, 0.42)), 0.035, C(0xffffff), sub=0)


# ---- blood from a stone: a standing stone inside a ring of small ones
st = P['stone']
M = T(G(st['x'], st['z'], -0.3)) @ Rz(0.4)
rock(M @ T((0, 0, 2.5)) @ Ry(0.05) @ S(1.0, 0.72, 2.25), 1.3, 17.0, sub=3, mossy=False)
for i in range(7):
    a = i / 7 * math.tau + 0.3
    rock(T(G(st['x'] + math.cos(a) * 4.4, st['z'] + math.sin(a) * 4.4, 0.1)) @ Rz(a) @ S(1, 0.8, 0.7), random.uniform(0.42, 0.6), i * 4.1, sub=1)

# ---- hen's teeth: a coop on stilts, door facing game +z
co = P['coop']
M = T(G(co['x'], co['z'], -0.08))
for sx_ in (-1.25, 1.25):
    for sy_ in (-0.95, 0.95):
        post(M @ T((sx_, sy_, 0)), 0.16, 0.8, WOOD_D)
box(M @ T((0, 0, 1.5)) @ S(3.0, 2.4, 1.6), C(0xe9d9b4), c2=CREAM, zc=(-0.3, 0.2), xc=(-0.3, 0.3))
box(M @ T((0, 0, 2.5)) @ S(3.0, 1.3, 0.5), CREAM)
for s in (-1, 1):
    box(M @ T((0, s * 0.725, 2.68)) @ Rx(-s * 0.555) @ S(3.4, 1.8, 0.1), REDP, xc=(-0.25, 0.25))
box(M @ T((0, 0, 3.14)) @ S(3.45, 0.16, 0.12), WHITE)
box(M @ T((-0.6, -1.21, 1.25)) @ S(0.7, 0.06, 0.9), C(0x2a1820))
beam(M @ Vector((-0.6, -1.25, 0.72)), M @ Vector((-0.6, -2.7, 0.05)), 0.07, 0.6, WOOD)
for k in range(4):
    beam(M @ Vector((-0.88, -1.5 - k * 0.32, 0.66 - k * 0.15)), M @ Vector((-0.32, -1.5 - k * 0.32, 0.66 - k * 0.15)), 0.05, 0.05, WOOD_D)
box(M @ T((0.75, -1.21, 1.75)) @ S(0.8, 0.06, 0.6), WHITE)
box(M @ T((0.75, -1.23, 1.75)) @ S(0.6, 0.06, 0.42), C(0x2a2430))
box(M @ T((2.0, 0.2, 1.15)) @ S(0.9, 1.5, 0.6), WOOD)                      # nest box on the side
box(M @ T((2.05, 0.2, 1.5)) @ Ry(0.3) @ S(1.0, 1.6, 0.07), REDP)
Mb = M @ T((2.6, -1.9, 0))                                                 # all the eggs, one basket
cyl(Mb, 0.42, 0.52, 0.4, C(0xb98a4a), c2=C(0xd9ad62), seg=12)
for k in range(6):
    a = k * 1.05
    ico(Mb @ T((math.cos(a) * 0.22 * (k > 0), math.sin(a) * 0.22 * (k > 0), 0.42)) @ S(0.85, 0.85, 1.1), 0.13, C(0xfff4e2), sub=1, smooth=True)
box(M @ T((-2.6, -1.6, 0.16)) @ Rz(0.4) @ S(1.3, 0.4, 0.22), WOOD)        # feed trough
box(M @ T((-2.6, -1.6, 0.26)) @ Rz(0.4) @ S(1.1, 0.24, 0.05), C(0xe6c355))

# ---- old dog: kennel, bowl and bone; doorway faces game +z
ke = P['kennel']
M = T(G(ke['x'], ke['z'], -0.06))
box(M @ T((0, 0, 0.65)) @ S(1.8, 2.2, 1.3), C(0x9b6b3f), c2=C(0xc08a55), zc=(-0.25, 0.2))
box(M @ T((0, 0, 1.45)) @ S(1.0, 2.2, 0.4), C(0xc08a55))
for s in (-1, 1):
    box(M @ T((s * 0.55, 0, 1.6)) @ Ry(s * 0.62) @ S(1.4, 2.6, 0.1), C(0x3f6fc4))
box(M @ T((0, 0, 2.02)) @ S(0.16, 2.65, 0.12), WHITE)
box(M @ T((0, -1.11, 0.45)) @ S(0.9, 0.06, 0.9), C(0x1c1418))
cyl(M @ T((0, -1.08, 0.9)) @ Rx(math.pi / 2) @ T((0, 0, -0.03)), 0.45, 0.45, 0.06, C(0x1c1418), seg=14)
box(M @ T((0, -1.13, 1.55)) @ S(0.7, 0.05, 0.24), CREAM)
cyl(M @ T((1.5, -1.9, 0.02)), 0.36, 0.28, 0.2, C(0xe2447a), seg=12)
cyl(M @ T((1.5, -1.9, 0.2)), 0.27, 0.27, 0.03, C(0x7a4a2c), seg=10)
Mb = M @ T((-1.4, -2.3, 0.12)) @ Rz(0.7)
beam(Mb @ Vector((-0.3, 0, 0)), Mb @ Vector((0.3, 0, 0)), 0.1, 0.1, CREAM)
for sx_ in (-0.3, 0.3):
    for sy_ in (-0.07, 0.07):
        ico(Mb @ T((sx_, sy_, 0)), 0.09, CREAM, sub=1)

# ---- herding cats: a cushion to herd them onto, a scratching post and a ball of wool
ca = P['cats']
M = T(G(ca['x'], ca['z'], -0.02))
cyl(M, 2.25, 2.25, 0.16, C(0x6b4423), c2=C(0xb98a4a), seg=28, cuts=())
cyl(M @ T((0, 0, 0.14)), 2.02, 1.9, 0.14, C(0xe2447a), c2=C(0xff9db5), seg=28, cuts=())
for i in range(12):
    a = i / 12 * math.tau
    ico(M @ T((math.cos(a) * 1.25, math.sin(a) * 1.25, 0.29)), 0.07, CREAM, sub=0)
Mp = M @ T((3.3, 1.2, 0))
cyl(Mp, 0.6, 0.6, 0.12, PLUM, seg=12)
cyl(Mp @ T((0, 0, 0.1)), 0.17, 0.17, 1.9, C(0xc9a877), c2=C(0xe6cf9a), seg=9)
cyl(Mp @ T((0, 0, 1.95)), 0.62, 0.62, 0.12, PLUM, seg=12)
ico(M @ T((-2.9, -1.5, 0.3)), 0.32, C(0x4fb7e8), sub=2, smooth=True)
beam(M @ Vector((-2.9, -1.5, 0.05)), M @ Vector((-2.0, -2.3, 0.04)), 0.05, 0.05, C(0x4fb7e8))

# ---- the end of the rainbow: three fairy rings
for i, fr in enumerate(L['FAIRY_RINGS']):
    for k in range(13):
        a = k / 13 * math.tau + i
        r = 2.7 + random.uniform(-0.15, 0.15)
        big_mushroom(T(G(fr['x'] + math.cos(a) * r, fr['z'] + math.sin(a) * r, -0.03)), random.uniform(1.3, 2.1))
    for k in range(9):
        a = random.uniform(0, 6.28)
        r = random.uniform(3.0, 3.8)
        Mf = T(G(fr['x'] + math.cos(a) * r, fr['z'] + math.sin(a) * r))
        beam(Mf @ Vector((0, 0, 0)), Mf @ Vector((0, 0, 0.42)), 0.035, 0.035, STEM)
        ico(Mf @ T((0, 0, 0.45)) @ S(1, 1, 1.3), 0.09, C(0x7fd0ff), sub=1)

# ---- a watched pot: campfire, tripod, cauldron, log seats, tent
cp = P['camp']
M = T(G(cp['x'], cp['z'], -0.03))
for i in range(10):
    a = i / 10 * math.tau
    rock(M @ T((math.cos(a) * 1.2, math.sin(a) * 1.2, 0.1)) @ Rz(a) @ S(0.8, 1.1, 0.8), 0.27, i * 2.3, mossy=False)
cyl(M, 1.05, 1.05, 0.06, C(0x1e1a1c), seg=14)
for i in range(4):
    a = i * 0.8 + 0.3
    beam(M @ Vector((math.cos(a) * 0.8, math.sin(a) * 0.8, 0.14)), M @ Vector((-math.cos(a) * 0.8, -math.sin(a) * 0.8, 0.3)), 0.2, 0.2, C(0x3a2a24))
for i in range(3):
    a = i / 3 * math.tau + 0.5
    beam(M @ Vector((math.cos(a) * 1.75, math.sin(a) * 1.75, 0)), M @ Vector((-math.cos(a) * 0.12, -math.sin(a) * 0.12, 3.25)), 0.11, 0.11, WOOD_D)
beam(M @ Vector((0, 0, 3.1)), M @ Vector((0, 0, 1.9)), 0.04, 0.04, IRON_L)
ico(M @ T((0, 0, 1.22)) @ S(1, 1, 0.82), 0.82, IRON, c2=IRON_L, sub=3, smooth=True, var=0.02)
cyl(M @ T((0, 0, 1.66)), 0.74, 0.76, 0.12, IRON_L, seg=18, cuts=())
cyl(M @ T((0, 0, 1.76)), 0.66, 0.66, 0.03, C(0x7a9a4a), seg=18)
for s in (-1, 1):
    beam(M @ Vector((s * 0.7, 0, 1.7)), M @ Vector((s * 0.2, 0, 1.95)), 0.04, 0.04, IRON_L)
for (a, r, rz) in ((0.4, 3.4, 1.9), (2.7, 3.3, 1.1)):
    Ml = M @ T((math.cos(a) * r, math.sin(a) * r, 0.36)) @ Rz(rz) @ Ry(math.pi / 2) @ T((0, 0, -1.2))
    cyl(Ml, 0.38, 0.36, 2.4, BARK_D, c2=BARK, seg=10)
    cyl(Ml @ T((0, 0, 2.39)), 0.3, 0.3, 0.02, C(0xd9b98a), seg=10)
    cyl(Ml @ T((0, 0, -0.01)), 0.3, 0.3, 0.02, C(0xd9b98a), seg=10)
Mt = M @ T((-4.6, 1.5, 0)) @ Rz(0.35)
for s in (-1, 1):
    def stripes(f, p, Mi=Mt.inverted()):
        return PLUM if int((Mi @ p.co).x * 2.2 + 50) % 3 == 0 else CREAM
    box(Mt @ T((0, s * 0.78, 1.18)) @ Rx(-s * 0.99) @ S(3.3, 2.85, 0.06), CREAM, fn=stripes, xc=tuple(i / 16 - 0.5 for i in range(1, 16)), var=0.0)
beam(Mt @ Vector((-1.75, 0, 2.38)), Mt @ Vector((1.75, 0, 2.38)), 0.09, 0.09, WOOD_D)
for sx_ in (-1.7, 1.7):
    post(Mt @ T((sx_, 0, 0)), 0.09, 2.4, WOOD_D)
box(Mt @ T((0, 0, 0.04)) @ S(3.1, 2.6, 0.06), C(0x4a3f52))
cyl(Mt @ T((-1.2, 0.2, 0.22)) @ Ry(math.pi / 2), 0.2, 0.2, 2.2, C(0xc8372d), c2=C(0xe2447a), seg=10)

# ---- square peg, round hole
ho = P['hole']
M = T(G(ho['x'], ho['z'], 0))
cyl(M @ T((0, 0, -0.02)), 2.15, 2.15, 0.07, STONE_D, seg=28)
cyl(M @ T((0, 0, 0.03)), ho['r'] + 0.05, ho['r'] + 0.05, 0.05, C(0x0c0a10), seg=28)
for i in range(15):
    a = i / 15 * math.tau
    rock(M @ T((math.cos(a) * 2.05, math.sin(a) * 2.05, 0.08)) @ Rz(a) @ S(0.7, 1.15, 0.6), 0.36, i * 3.7, mossy=i % 4 == 0)

# ---- barn-door puzzle: three plates, and the horse who knows the order
for pl in L['PLATES']:
    M = T(G(pl['x'], pl['z'], -0.02))
    cyl(M, 1.05, 1.0, 0.16, STONE_D, c2=STONE, seg=20, cuts=())
    Me = M @ T((0, 0, 0.175))
    if pl['sym'] == 'sun':
        flat([(math.cos(i / 16 * math.tau) * 0.36, math.sin(i / 16 * math.tau) * 0.36) for i in range(16)], Me, GOLD, var=0)
        for i in range(8):
            a = i / 8 * math.tau
            box(Me @ Rz(a) @ T((0.62, 0, 0)) @ S(0.24, 0.1, 0.012), C(0xf08a24))
    elif pl['sym'] == 'moon':
        outer = [(math.cos(a) * 0.6, math.sin(a) * 0.6) for a in np.linspace(1.0, 5.28, 15)]
        inner = [(0.28 + math.cos(a) * 0.46, math.sin(a) * 0.46) for a in np.linspace(1.42, 4.86, 15)]
        vs = []
        for (o0, i0), (o1, i1) in zip(zip(outer, inner), zip(outer[1:], inner[1:])):
            q = [bm.verts.new((*p, 0)) for p in (o0, o1, i1, i0)]
            bm.faces.new(q)
            vs += q
        add(vs, Me @ T((-0.12, 0, 0)), C(0xcfe6ff), var=0)
    else:
        flat([(math.cos(i / 10 * math.tau + math.pi / 2) * (0.7 if i % 2 == 0 else 0.3), math.sin(i / 10 * math.tau + math.pi / 2) * (0.7 if i % 2 == 0 else 0.3)) for i in range(10)], Me, C(0xff7fa8), var=0)

hr = P['horse']
M = T(G(hr['x'], hr['z'], -0.1))
cyl(M, 2.0, 1.85, 0.4, STONE_D, c2=STONE, seg=20, cuts=())
box(M @ T((0.15, 0.08, 0.75)) @ Rz(0.5) @ S(4.3, 1.6, 0.8), STONE, c2=tint(STONE), xc=(-0.3, 0, 0.3))
HORSE_M = M @ T((0, 0, 1.15)) @ Rz(0.5 + math.pi / 2)

# ---- secrets: a red herring on the beach, an opened can of worms
M = T(G(P['herring']['x'], P['herring']['z'], 0)) @ Rz(0.8)
box(M @ T((0, 0, 0.2)) @ S(1.9, 1.0, 0.4), WOOD, c2=tint(WOOD))
Mf = M @ T((0, 0, 0.62)) @ Ry(-0.06)
ico(Mf @ S(1.0, 0.3, 0.42), 0.8, C(0xb81e24), c2=C(0xf0483e), sub=3, smooth=True, var=0.02)
flat([(0, 0), (0.5, 0.42), (0.38, 0), (0.5, -0.42)], Mf @ T((0.72, 0, 0)) @ Rx(math.pi / 2), C(0xc8262a), var=0)
flat([(-0.2, 0), (0.25, 0.3), (0.2, 0)], Mf @ T((0, 0, 0.3)) @ Rx(math.pi / 2), C(0xc8262a), var=0)
for s in (-1, 1):
    ico(Mf @ T((-0.52, s * 0.19, 0.08)), 0.075, C(0xffffff), sub=1)
    ico(Mf @ T((-0.55, s * 0.24, 0.08)), 0.04, C(0x101014), sub=0)

M = T(G(P['worms']['x'], P['worms']['z'], -0.03)) @ Rz(1.1)
cyl(M, 0.62, 0.62, 1.0, C(0xaab2ba), c2=C(0xdfe5ea), seg=18)
cyl(M @ T((0, 0, 0.28)), 0.635, 0.635, 0.5, C(0xe2447a), c2=C(0xff9db5), seg=18, cuts=())
cyl(M @ T((0, 0, 0.93)), 0.56, 0.56, 0.03, C(0x4a3423), seg=14)
cyl(M @ T((-0.6, 0, 1.0)) @ Ry(-1.1) @ T((0.6, 0, 0)), 0.6, 0.6, 0.03, C(0xdfe5ea), seg=18)
for i in range(7):
    a = i * 0.9
    p0 = Vector((math.cos(a) * 0.3, math.sin(a) * 0.3, 0.9))
    for k in range(4):
        p1 = p0 + Vector((math.cos(a + k) * 0.16, math.sin(a + k * 1.3) * 0.16, 0.2 - k * 0.03))
        beam(M @ p0, M @ p1, 0.085, 0.085, C(0xe58aa0), c2=C(0xf5b2c0))
        p0 = p1

# ---- inside the barn (walk-in once the doors open): ramp, clutter, lantern
BM_ = T(G(BARN['x'], BARN['z']))
FLOOR_Z, RAMP = L['BARN_FLOOR'], L['BARN_RAMP']
ang = math.atan2(FLOOR_Z + 0.1, RAMP)
box(BM_ @ T((5.0 + RAMP / 2, 0, FLOOR_Z / 2 - 0.1)) @ Ry(ang) @ S(math.hypot(RAMP, FLOOR_Z + 0.1) + 0.2, 3.5, 0.12), WOOD, c2=tint(WOOD), xc=(-0.3, 0, 0.3))
for k in range(5):
    t = (k + 0.5) / 5
    box(BM_ @ T((5.0 + RAMP * t, 0, FLOOR_Z * (1 - t) + 0.0)) @ Ry(ang) @ S(0.1, 3.5, 0.07), WOOD_D)
for s in (-1, 1):
    box(BM_ @ T((5.0 + RAMP * 0.3, s * 1.6, 0.2)) @ S(RAMP * 0.6, 0.2, 0.75), STONE_D)
Mi = BM_ @ T((0, 0, FLOOR_Z + 0.02))
for (x, y, z, rz) in ((-3.9, -3.0, 0.42, 0), (-3.9, -1.9, 0.42, 0.1), (-3.9, -2.5, 1.26, 1.5), (3.6, 3.1, 0.42, 1.57), (2.4, 3.1, 0.42, 1.5)):
    Mb = Mi @ T((x, y, z)) @ Rz(rz)
    box(Mb @ S(1.0, 1.5, 0.84), C(0xd9ad42), c2=C(0xf0cf62))
    for k in (-0.4, 0.4):
        box(Mb @ T((0, k, 0)) @ S(1.03, 0.05, 0.87), C(0xa8793a))
ico(Mi @ T((-3.2, 2.9, 0.3)) @ S(1.4, 1.0, 0.5), 0.9, STRAW, sub=2, jit=0.25, seed=9)
cyl(Mi @ T((3.9, -3.0, 0)), 0.5, 0.5, 1.05, WOOD, c2=WOOD_D, seg=12)
ico(Mi @ T((1.2, -3.2, 0.5)) @ S(0.8, 0.8, 1.05), 0.5, C(0xd9c9a0), c2=C(0xf2e6c8), sub=2, jit=0.1, seed=2)   # sack of peanuts
for k in range(6):
    ico(Mi @ T((0.4 + (k % 3) * 0.2, -2.7 + (k // 3) * 0.22, 0.07)) @ S(1.5, 0.8, 0.8), 0.07, C(0xd9b07a), sub=1)
beam(Mi @ Vector((-4.7, 1.2, 0)), Mi @ Vector((-4.75, 1.3, 2.4)), 0.06, 0.06, WOOD)                           # pitchfork
for k in (-0.15, 0, 0.15):
    beam(Mi @ Vector((-4.75, 1.3 + k, 2.4)), Mi @ Vector((-4.76, 1.3 + k, 2.9)), 0.03, 0.03, IRON_L)
beam(Mi @ Vector((0.6, 0, 4.9)), Mi @ Vector((0.6, 0, 4.25)), 0.03, 0.03, IRON_L)
box(Mi @ T((0.6, 0, 4.05)) @ S(0.3, 0.3, 0.4), C(0xfff0b0), var=0)
box(Mi @ T((0.6, 0, 4.28)) @ S(0.38, 0.38, 0.06), IRON)
box(Mi @ T((0.6, 0, 3.83)) @ S(0.38, 0.38, 0.06), IRON)
LANTERN = Mi @ Vector((0.6, 0, 3.55))
ELEPHANT_M = Mi @ T((-2.5, 0, 0)) @ Rz(math.pi / 2)

# The elephant in the room and the stone horse come from the animal modeller.
if True:
    sys.path.insert(0, os.path.join(ROOT, 'blender'))
    import critter_lib
    for mesh, Mx in ((critter_lib.build_elephant(tris=9000)['elephant'], ELEPHANT_M), (critter_lib.build_horse(stone=True, tris=8000)['horse'], HORSE_M)):
        mesh.transform(Mx)
        props.from_mesh(mesh)
    use(props)

# ---- the pond: bridge on the pit path, lily pads, reeds, stepping stones
po, br = P['pond'], L['BRIDGE']
BRM = T(Vector((br['x'], -br['z'], 0))) @ Rz(math.atan2(-br['dz'], br['dx']))      # local x runs along the bridge
deck = lambda sx: L['bridgeEnd'] - 0.12 + br['rise'] * (1 - (sx / br['half']) ** 2)
pitch = lambda sx: Ry(-math.atan(-2 * br['rise'] * sx / br['half'] ** 2))
nb = 28
for i in range(nb):
    sx = -br['half'] + (i + 0.5) * 2 * br['half'] / nb
    box(BRM @ T((sx, 0, deck(sx) + 0.06)) @ pitch(sx) @ S(0.46, 2 * br['hw'] + 0.1, 0.1), tint(WOOD, 0.12), xc=(), var=0.08)
xs = [-br['half'] + i * 2 * br['half'] / 14 for i in range(15)]
for sy in (-1, 1):
    for a, b in zip(xs, xs[1:]):
        beam(BRM @ Vector((a, sy * (br['hw'] - 0.15), deck(a) - 0.1)), BRM @ Vector((b, sy * (br['hw'] - 0.15), deck(b) - 0.1)), 0.14, 0.26, WOOD_D)
        beam(BRM @ Vector((a, sy * br['hw'], deck(a) + 1.05)), BRM @ Vector((b, sy * br['hw'], deck(b) + 1.05)), 0.1, 0.1, WOOD)
    for a in xs[::2]:
        post(BRM @ T((a, sy * br['hw'], deck(a) - 0.1)), 0.14, 1.25, WOOD_D)
    for a in (-2.6, 2.6):
        beam(BRM @ Vector((a, sy * (br['hw'] - 0.1), deck(a) - 0.15)), BRM @ Vector((a, sy * (br['hw'] - 0.1), -2.6)), 0.22, 0.22, BARK_D)
for sx in (-br['half'], br['half']):          # a stone step at each end
    box(BRM @ T((sx * 1.04, 0, deck(sx) - 0.2)) @ S(1.0, 2 * br['hw'] + 0.4, 0.5), STONE, c2=tint(STONE))
PAD, PAD_L = C(0x3f9350), C(0x7cc45e)
pads = 0
while pads < 12:
    a, r = random.uniform(0, math.tau), random.uniform(0.6, 3.5)
    x, z = po['x'] + math.cos(a) * r, po['z'] + math.sin(a) * r
    if abs((x - br['x']) * br['dz'] - (z - br['z']) * br['dx']) < br['hw'] + 0.9:
        continue
    pads += 1
    rr = random.uniform(0.32, 0.6)
    Mp = T(Vector((x, -z, L['WATER_Y'] + 0.04))) @ Rz(random.uniform(0, 6))
    flat([(math.cos(t) * rr, math.sin(t) * rr) for t in np.linspace(0.35, math.tau - 0.35, 11)] + [(0.0, 0.0)], Mp, PAD, fn=lambda f, p: tint(PAD_L if random.random() < 0.5 else PAD, 0.05))
    if pads % 3 == 0:
        ico(Mp @ T((0, 0, 0.1)) @ S(1, 1, 0.7), 0.16, C(0xff9db5), c2=C(0xffffff), sub=1)
        ico(Mp @ T((0, 0, 0.17)), 0.06, C(0xffd23f), sub=0)
for i in range(16):
    a = i / 16 * math.tau + random.uniform(-0.15, 0.15)
    lo, hi = 2.0, 9.0
    for _ in range(14):
        mid = (lo + hi) / 2
        if gy(po['x'] + math.cos(a) * mid, po['z'] + math.sin(a) * mid) < L['WATER_Y'] + 0.1:
            lo = mid
        else:
            hi = mid
    x, z = po['x'] + math.cos(a) * lo, po['z'] + math.sin(a) * lo
    if abs((x - br['x']) * br['dz'] - (z - br['z']) * br['dx']) < br['hw'] + 1.2:
        continue
    if i % 2:
        rock(T(G(x, z, 0.1)) @ Rz(a) @ S(1, 0.8, 0.6), random.uniform(0.3, 0.55), i * 2.9, sub=1)
    else:
        for k in range(random.randint(4, 7)):
            base = G(x + random.uniform(-0.5, 0.5), z + random.uniform(-0.5, 0.5), -0.1)
            h = random.uniform(0.9, 1.6)
            lean = Vector((random.uniform(-0.2, 0.2), random.uniform(-0.2, 0.2), h))
            beam(base, base + lean, 0.05, 0.02, C(0x5e9a48), c2=C(0x9fcf6a))
            if k % 3 == 0:
                beam(base + lean * 0.86, base + lean * 1.08, 0.09, 0.09, C(0x6b4423))

# ---- the lighthouse on its islet, and the causeway out to it
isl, cw = P['islet'], L['CAUSEWAY']
M = T(G(isl['x'], isl['z'], -0.2))
LW, LR = C(0xfbf6ec), C(0xd8382e)
for i in range(11):
    a = i / 11 * math.tau
    rock(M @ T((math.cos(a) * 3.0, math.sin(a) * 3.0, 0.3)) @ Rz(a) @ S(0.9, 1.3, 0.8), random.uniform(0.7, 1.0), i * 3.3, sub=2, mossy=False)
cyl(M, 2.75, 2.6, 1.0, STONE_D, c2=STONE, seg=20, cuts=(0.5,))
TOWER_H = 12.0
def bands(f, p, Mi=M.inverted()):
    zz = sum((Mi @ v.co).z for v in f.verts) / len(f.verts)
    return LR if int((zz - 0.9) / (TOWER_H / 5)) % 2 == 1 else LW
cyl(M @ T((0, 0, 0.9)), 2.3, 1.45, TOWER_H, LW, fn=bands, seg=22, var=0.02, cuts=tuple((i + 0.5) / 30 for i in range(30)))
cyl(M @ T((0, 0, 12.8)), 2.2, 2.3, 0.3, IRON, seg=22, cuts=())
for i in range(12):
    a = i / 12 * math.tau
    post(M @ T((math.cos(a) * 2.15, math.sin(a) * 2.15, 13.0)), 0.07, 0.9, IRON)
cyl(M @ T((0, 0, 13.85)), 2.2, 2.2, 0.06, IRON, seg=22, cuts=())
cyl(M @ T((0, 0, 13.0)), 1.2, 1.2, 1.9, C(0xfff2b8), seg=12, cuts=(), smooth=False, var=0)
for i in range(6):
    a = i / 6 * math.tau
    post(M @ T((math.cos(a) * 1.22, math.sin(a) * 1.22, 13.0)), 0.1, 1.9, IRON)
cyl(M @ T((0, 0, 14.9)), 1.6, 0.1, 1.5, LR, c2=tint(LR), seg=12, cuts=(0.5,))
ico(M @ T((0, 0, 16.5)), 0.2, GOLD, sub=1)
Md = M @ Rz(math.pi / 4)                      # door faces back along the causeway
box(Md @ T((2.22, 0, 1.9)) @ S(0.3, 1.3, 2.3), LR)
box(Md @ T((2.3, 0, 1.8)) @ S(0.3, 1.0, 2.0), WOOD_D)
for (a, z) in ((0.9, 5.0), (-1.3, 8.0), (2.8, 10.5)):
    r = 2.3 - (z - 0.9) * 0.071
    Mw = M @ Rz(a) @ T((r - 0.05, 0, z))
    box(Mw @ S(0.2, 0.8, 1.1), LR)
    box(Mw @ T((0.03, 0, 0)) @ S(0.2, 0.55, 0.85), C(0x2a2430))
LAMP_H = gy(isl['x'], isl['z']) - 0.2 + 13.95
cdx, cdz = cw['bx'] - cw['ax'], cw['bz'] - cw['az']
cl = math.hypot(cdx, cdz)
for i in range(int(cl / 2.2)):
    t = (i + 0.5) / int(cl / 2.2)
    for sgn in (-1, 1):
        x = cw['ax'] + cdx * t + sgn * (-cdz / cl) * (cw['hw'] + 0.3) + random.uniform(-0.3, 0.3)
        z = cw['az'] + cdz * t + sgn * (cdx / cl) * (cw['hw'] + 0.3) + random.uniform(-0.3, 0.3)
        if math.hypot(x - isl['x'], z - isl['z']) > 4.5:
            rock(T(G(x, z, 0.1)) @ Rz(i) @ S(1, random.uniform(0.8, 1.2), 0.7), random.uniform(0.45, 0.8), i * 7.1 + sgn, sub=1, mossy=False)
    if i % 3 == 1:
        x, z = cw['ax'] + cdx * t - (-cdz / cl) * (cw['hw'] - 0.2), cw['az'] + cdz * t - (cdx / cl) * (cw['hw'] - 0.2)
        post(T(G(x, z, -0.2)) @ Rz(0.3), 0.18, 1.5, WOOD_D)
        ico(T(G(x, z, 1.35)), 0.14, LR, sub=1)

# ---- pearls before swine: an open oyster on the north beach
pe = L['SPOTS']['pearls']
M = T(G(pe['x'], pe['z'], 0)) @ Rz(0.6)
SHELL, SHELL_IN, PEARL = C(0xa594b8), C(0xf3e4ee), C(0xffffff)


def shell_half(Mh):
    v = bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=0.95)['verts']
    bmesh.ops.delete(bm, geom=[p for p in v if p.co.z > 0.01], context='VERTS')
    v = [p for p in v if p.is_valid]
    for p in v:   # scalloped rim
        a = math.atan2(p.co.y, p.co.x)
        k = 1 + 0.07 * math.cos(a * 9)
        p.co.x *= k
        p.co.y *= k
    add(v, Mh @ S(1, 1, 0.42), SHELL, fn=lambda f, p: SHELL_IN if f.normal.z > 0.2 else tint(SHELL, 0.1), smooth=True)


shell_half(M @ T((0, 0, 0.42)))
shell_half(M @ T((0, 0.8, 0.95)) @ Rx(math.radians(118)))
ico(M @ T((0, 0, 0.36)), 0.3, PEARL, sub=3, smooth=True, var=0)
for dx, dy in ((1.3, -0.5), (-1.1, -0.9), (0.4, -1.5), (-0.6, 1.5)):
    ico(T(G(pe['x'] + dx, pe['z'] + dy, 0.14)), 0.16, PEARL, sub=2, smooth=True, var=0)

props_ob = finish(props, 'props')

# ================================================================== LOOSE THINGS
# Each is its own object so the game can move it. Their origins are where the game holds them.
loose = []          # baked like the props
loose_unlit = []    # modelled here, lit by the game (they tumble, so baked light would tumble too)


def loose_ob(name, origin, shadow=True, bake=True):
    ob = finish(bm, name)
    ob.location = origin
    if not shadow:                # it will move away, and must not leave its shadow behind
        ob.visible_shadow = False
        ob.visible_diffuse = False
    (loose if bake else loose_unlit).append(ob)
    return ob


# a pig in a poke
use(bmesh.new())
SACK, SACK_D = C(0xc2a273), C(0x8f7448)
ico(T((0, 0, 0.85)) @ S(1.05, 1.15, 0.95), 1.0, SACK_D, c2=SACK, sub=3, jit=0.12, seed=4.2, smooth=True, var=0.03)
cyl(T((0, 0, 1.62)), 0.26, 0.5, 0.55, SACK, c2=tint(SACK), seg=10, cuts=(0.5,))
cyl(T((0, 0, 1.66)), 0.3, 0.3, 0.1, C(0x6b4423), seg=10, cuts=())
for k in range(5):   # patch stitches
    box(T((0.2 + k * 0.1, -1.08, 0.9 + (k % 2) * 0.08)) @ S(0.05, 0.05, 0.16), C(0x4f3423))
box(T((0.4, -1.04, 0.92)) @ S(0.62, 0.05, 0.5), tint(C(0xa8793a)))
sp = L['SPOTS']['poke']
loose_ob('poke', G(sp['x'], sp['z']))

# the crate for the round hole
use(bmesh.new())
CR, CR_D = C(0xc99a5b), C(0x8a5f33)
box(S(1.86), CR, c2=tint(CR))
for ax in range(3):
    for sgn in (-1, 1):
        Mf = (Matrix.Identity(4), Rx(math.pi / 2), Ry(math.pi / 2))[ax] @ T((0, 0, sgn * 0.95))
        for k in (-0.86, 0.86):
            box(Mf @ T((k, 0, 0)) @ S(0.28, 2.0, 0.1), CR_D)
            box(Mf @ T((0, k, 0)) @ S(1.44, 0.28, 0.1), CR_D)
        beam(Mf @ Vector((-0.74, -0.74, 0)), Mf @ Vector((0.74, 0.74, 0)), 0.26, 0.09, tint(CR_D))
        for k in (-0.43, 0, 0.43):
            box(Mf @ T((k, 0, -0.012)) @ S(0.02, 1.44, 0.02), CR_D)
loose_ob('crate', G(P['crate']['x'], P['crate']['z'], 1.0), shadow=False)

# the pot of gold; parked in the first fairy ring until the rainbow holds still
use(bmesh.new())
v = bmesh.ops.create_uvsphere(bm, u_segments=18, v_segments=12, radius=0.9)['verts']
bmesh.ops.delete(bm, geom=[p for p in v if p.co.z > 0.52], context='VERTS')
add([p for p in v if p.is_valid], T((0, 0, 0.82)), IRON, c2=IRON_L, smooth=True, var=0.02)
cyl(T((0, 0, 1.3)), 0.82, 0.86, 0.12, IRON_L, seg=18, cuts=())
ico(T((0, 0, 1.36)) @ S(1, 1, 0.42), 0.7, GOLD, c2=C(0xffe27a), sub=2, jit=0.12, seed=2.0, var=0.08)
for k in range(11):
    a, r = k * 2.4, 1.05 + (k % 3) * 0.28
    cyl(T((math.cos(a) * r, math.sin(a) * r, 0.02 + (k % 2) * 0.05)) @ Rx((k % 3 - 1) * 0.25), 0.15, 0.15, 0.045, GOLD, seg=10, cuts=(), smooth=False)
for k in range(5):
    a = k * 1.3
    cyl(T((math.cos(a) * 0.35, math.sin(a) * 0.35, 1.52)) @ Rx(0.9) @ Rz(a), 0.15, 0.15, 0.045, C(0xffe27a), seg=10, cuts=(), smooth=False)
fr0 = L['FAIRY_RINGS'][0]
loose_ob('gold', G(fr0['x'], fr0['z']), shadow=False)

# ducks in a row
for i, d in enumerate(L['DUCKS']):
    use(bmesh.new())
    M = Rz(-d['yaw'] + math.pi)       # built facing -y, which is game +z
    YEL, YEL_D = C(0xffd23f), C(0xe0a81e)
    ico(M @ T((0, 0, 0.3)) @ S(0.9, 1.2, 0.72), 0.62, YEL_D, c2=YEL, sub=3, smooth=True, var=0.01)
    ico(M @ T((0, -0.42, 0.92)), 0.4, YEL, sub=3, smooth=True, var=0.01)
    cyl(M @ T((0, 0.5, 0.42)) @ Rx(-0.7), 0.28, 0.0, 0.5, YEL, seg=8, cuts=())
    box(M @ T((0, -0.84, 0.86)) @ S(0.3, 0.26, 0.09), C(0xf08a24))
    for sgn in (-1, 1):
        ico(M @ T((sgn * 0.2, -0.72, 1.04)), 0.06, C(0x1c1c22), sub=1)
        ico(M @ T((sgn * 0.5, 0.05, 0.42)) @ S(0.3, 1, 0.6), 0.36, YEL_D, sub=2, smooth=True, var=0.01)
    loose_ob('duck_%d' % i, Vector((d['x'], -d['z'], L['WATER_Y'])))

# the big fish in the small pond; it waits underwater until the game makes it jump
use(bmesh.new())
KOI, KOI_W = C(0xf0792a), C(0xfff4e6)
ico(S(0.3, 0.75, 0.36), 1.0, KOI, sub=3, smooth=True, var=0, fn=lambda f, p: KOI_W if noise.noise(p.co * 2.3 + Vector((3, 1, 7))) > 0.12 else KOI)
flat([(0, 0), (0.5, 0.5), (0.34, 0), (0.5, -0.5)], T((0, 0.62, 0)) @ Rz(math.pi / 2) @ Rx(math.pi / 2), KOI, var=0)
flat([(-0.25, 0), (0.25, 0.32), (0.22, 0)], T((0, 0, 0.3)) @ Rz(math.pi / 2) @ Rx(math.pi / 2), KOI, var=0)
for sgn in (-1, 1):
    ico(T((sgn * 0.2, -0.5, 0.08)), 0.075, C(0xffffff), sub=1)
    ico(T((sgn * 0.24, -0.53, 0.08)), 0.04, C(0x101014), sub=0)
loose_ob('fish', Vector((po['x'], -po['z'], L['WATER_Y'] - 1.0)), shadow=False)

# cloud nine
use(bmesh.new())
for j in range(7):
    ico(T(((j - 3) * 3.3, (j % 3) * 1.6 - 1.6, (j % 2) * 1.5)) @ S(1, 1, 0.62), 3.4 + (j % 3) * 0.9, C(0xf5a6c4), c2=C(0xffd9e6), sub=2, jit=0.1, seed=j * 3.1, smooth=True, var=0.01)
c9 = L['CLOUD9']
loose_ob('cloud9', Vector((c9[0], -c9[2], c9[1])))

# the bucket by the well
use(bmesh.new())
TIN, TIN_D = C(0xb7bfc7), C(0x7d858e)
v = bmesh.ops.create_cone(bm, cap_ends=False, segments=16, radius1=0.36, radius2=0.5, depth=0.8)['verts']
add(v, None, TIN_D, c2=TIN, smooth=True, var=0.02)
v = bmesh.ops.create_cone(bm, cap_ends=False, segments=16, radius1=0.34, radius2=0.48, depth=0.78)['verts']
bmesh.ops.reverse_faces(bm, faces=list({f for p in v for f in p.link_faces}))
add(v, None, C(0x596069), smooth=True, var=0.02)
cyl(T((0, 0, -0.4)), 0.36, 0.36, 0.03, TIN_D, seg=16, cuts=())
for z in (-0.2, 0.36):
    r = 0.44 + z * 0.175
    cyl(T((0, 0, z)), r + 0.012, r + 0.03, 0.05, TIN_D, seg=16, cuts=())
for k in range(9):
    a0, a1 = math.pi * k / 9, math.pi * (k + 1) / 9
    beam(Vector((math.cos(a0) * 0.5, 0, 0.36 + math.sin(a0) * 0.5)), Vector((math.cos(a1) * 0.5, 0, 0.36 + math.sin(a1) * 0.5)), 0.035, 0.035, C(0x3a3d44))
sp = L['SPOTS']['bucket']
loose_ob('bucket', G(sp['x'], sp['z'], 0.4), shadow=False, bake=False)

# ================================================================== WINDMILL SAILS
blades = bmesh.new()
use(blades)
SAIL = C(0xfff3dc)
cyl(Ry(math.pi / 2) @ T((0, 0, -0.1)), 0.42, 0.3, 0.55, WOOD_D, seg=10)
for i in range(4):
    Mb = Rx(i * math.pi / 2 + 0.35)
    beam(Mb @ Vector((0.25, 0, 0)), Mb @ Vector((0.25, 0, 7.0)), 0.16, 0.2, WOOD_D)
    beam(Mb @ Vector((0.25, 1.25, 1.5)), Mb @ Vector((0.25, 1.25, 6.9)), 0.07, 0.1, WOOD)
    for k in range(7):
        z = 1.5 + k * 0.9
        beam(Mb @ Vector((0.25, 0, z)), Mb @ Vector((0.25, 1.25, z)), 0.06, 0.08, WOOD)
    box(Mb @ T((0.2, 0.64, 4.2)) @ S(0.03, 1.12, 5.3), SAIL, var=0.02, zc=(-0.3, -0.1, 0.1, 0.3))
blades_ob = finish(blades, 'blades')
blades_ob.location = HUB
blades_ob.visible_shadow = False   # they turn in the game, so no baked shadow

# ================================================================== BARN (textured)
def lin4(h):
    return (*C(h), 1)


def bmat(name, h):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = lin4(h)
    b.inputs['Roughness'].default_value = 0.9
    return m


B_RED, B_DARKRED = bmat('red', 0xc8372d), bmat('darkred', 0x8f2019)
B_TRIM, B_ROOF = bmat('trim', 0xfff6e9), bmat('roof', 0x5a3b46)
B_STONE, B_STEEL = bmat('stone', 0x9a938c), bmat('steel', 0xdcdad6)
B_CAP, B_DARK = bmat('cap', 0xb6433a), bmat('dark', 0x2a1820)
B_INSIDE, B_FLOOR = bmat('inside', 0xb98a5a), bmat('floor', 0x9a7446)
BMATS = [B_RED, B_DARKRED, B_TRIM, B_ROOF, B_STONE, B_STEEL, B_CAP, B_DARK, B_INSIDE, B_FLOOR]
bb = bmesh.new()


def btag(geom, m):
    i = BMATS.index(m)
    for f in geom:
        f.material_index = i


def bbox(c, size, m, rot=None):
    vs = bmesh.ops.create_cube(bb, size=1)['verts']
    bmesh.ops.scale(bb, vec=size, verts=vs)
    if rot is not None:
        bmesh.ops.rotate(bb, cent=(0, 0, 0), matrix=rot, verts=vs)
    bmesh.ops.translate(bb, vec=c, verts=vs)
    btag({f for v in vs for f in v.link_faces}, m)


def bcyl(c, r, depth, m, seg=28):
    out = bmesh.ops.create_cone(bb, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=depth)
    bmesh.ops.translate(bb, vec=c, verts=out['verts'])
    btag({f for v in out['verts'] for f in v.link_faces}, m)


def prism(profile, y0, y1, m, skip=(), inside=False, floor=None):
    """Extrude an (x, z) outline along y. skip leaves side faces out; inside turns it into a room."""
    a = [bb.verts.new((x, y0, z)) for x, z in profile]
    b = [bb.verts.new((x, y1, z)) for x, z in profile]
    n = len(profile)
    loops = [a, b[::-1]] + [(a[i], b[i], b[(i + 1) % n], a[(i + 1) % n]) for i in range(n) if i not in skip]
    faces = [bb.faces.new(l) for l in loops]
    if inside:
        bmesh.ops.recalc_face_normals(bb, faces=faces)
        bmesh.ops.reverse_faces(bb, faces=faces)
    btag(faces, m)
    if floor:
        btag([faces[2]], floor)


W, D, H = 5.0, 4.0, 6.0
bbox((0, 0, 0.1), (10.3, 8.3, 1.4), B_STONE)
# The east wall (+x) is built from three pieces round the doorway; the room inside is added at the end.
DW, DTOP = L['DOOR_HW'], 4.8
prism([(-W, 0.6), (W, 0.6), (W, H), (3.3, 8.5), (0, 9.5), (-3.3, 8.5), (-W, H)], -D, D, B_RED, skip=(1,))
for s in (-1, 1):
    bbox((W - 0.075, s * (DW + D) / 2, 3.3), (0.15, D - DW, 5.4), B_RED)
bbox((W - 0.075, 0, (DTOP + H) / 2), (0.15, 2 * DW, H - DTOP), B_RED)
for i in range(-4, 5):
    for y in (-D - 0.05, D + 0.05):
        top = H + (8.3 - H) * (1 - abs(i) / 5) if abs(i) >= 3.3 else 8.3 + (1 - abs(i) / 3.3) * 0.9
        bbox((i, y, (0.8 + top) / 2), (0.14, 0.1, top - 0.8), B_DARKRED)
for j in range(-3, 4):
    for x in (-W - 0.05, W + 0.05):
        if x < 0 or abs(j) > 1:
            bbox((x, j, 3.4), (0.1, 0.14, 5.2), B_DARKRED)
for x in (-W, W):
    for y in (-D, D):
        bbox((x, y, 3.3), (0.36, 0.36, 5.6), B_TRIM)
    bbox((x * 1.012, 0, 6.0), (0.16, 8.3, 0.3), B_TRIM)
ROOF_PTS = [(-5.75, 5.75), (-3.3, 8.75), (0, 9.8), (3.3, 8.75), (5.75, 5.75)]
for (x0, z0), (x1, z1) in zip(ROOF_PTS, ROOF_PTS[1:]):
    dx, dz = x1 - x0, z1 - z0
    Ln = math.hypot(dx, dz)
    rot = Matrix.Rotation(-math.atan2(dz, dx), 4, 'Y')
    bbox(((x0 + x1) / 2, 0, (z0 + z1) / 2), (Ln + 0.12, 9.3, 0.24), B_ROOF, rot)
    for k in range(1, int(Ln / 0.62) + 1):
        t = k * 0.62 / Ln
        bbox((x0 + dx * t, 0, z0 + dz * t + 0.06), (0.1, 9.34, 0.2), B_ROOF, rot)
    for y in (-4.6, 4.6):
        bbox(((x0 + x1) / 2, y, (z0 + z1) / 2 - 0.2), (Ln + 0.1, 0.1, 0.34), B_TRIM, rot)
bbox((0, 0, 9.98), (0.5, 9.4, 0.16), B_TRIM)
bbox((0, 0, 10.5), (0.9, 0.9, 0.9), B_TRIM)
prism([(-0.75, 10.95), (0.75, 10.95), (0, 11.75)], -0.75, 0.75, B_ROOF)
for s in (-1, 1):                                                          # door frame
    bbox((W + 0.02, s * (DW + 0.14), 2.75), (0.14, 0.28, 4.5), B_TRIM)
bbox((W + 0.02, 0, DTOP + 0.14), (0.14, 2 * DW + 0.56, 0.28), B_TRIM)
bbox((W + 0.2, 0, 5.12), (0.2, 4.4, 0.14), B_DARK)
for s in (-1, 1):
    y = s * (D + 0.06)
    bbox((0, y, 7.3), (1.7, 0.12, 1.7), B_TRIM)
    bbox((0, y + s * 0.03, 7.3), (1.4, 0.12, 1.4), B_DARK)
    bbox((0, y + s * 0.05, 7.3), (0.1, 0.12, 1.4), B_TRIM)
    bbox((0, y + s * 0.05, 7.3), (1.4, 0.12, 0.1), B_TRIM)
    for x in (-2.6, 2.6):
        bbox((x, y, 3.3), (1.3, 0.12, 1.5), B_TRIM)
        bbox((x, y + s * 0.03, 3.3), (1.02, 0.12, 1.22), B_DARK)
        bbox((x, y + s * 0.05, 3.3), (0.08, 0.12, 1.22), B_TRIM)
bbox((0, D + 0.7, 8.6), (0.16, 1.5, 0.16), B_DARK)
for y in (-2, 2):
    bbox((-W - 0.06, y, 3.6), (0.12, 1.3, 1.5), B_TRIM)
    bbox((-W - 0.09, y, 3.6), (0.12, 1.02, 1.22), B_DARK)
SX, SY, SR = -3.0, 8.0, 2.2
bcyl((SX, SY, 0.1), SR + 0.18, 1.4, B_STONE)
bcyl((SX, SY, 5.4), SR, 9.4, B_STEEL, seg=36)
for k in range(8):
    bcyl((SX, SY, 1.3 + k * 1.22), SR + 0.07, 0.14, B_TRIM, seg=36)
bcyl((SX, SY, 10.2), SR + 0.16, 0.3, B_CAP, seg=36)
out = bmesh.ops.create_uvsphere(bb, u_segments=36, v_segments=18, radius=SR + 0.1)
bmesh.ops.delete(bb, geom=[v for v in out['verts'] if v.co.z < -0.01], context='VERTS')
live = [v for v in out['verts'] if v.is_valid]
bmesh.ops.scale(bb, vec=(1, 1, 0.8), verts=live)
bmesh.ops.translate(bb, vec=(SX, SY, 10.3), verts=live)
btag({f for v in live for f in v.link_faces}, B_CAP)
bcyl((SX, SY, 12.25), 0.14, 0.5, B_TRIM, seg=12)
for k in range(17):
    bbox((SX + SR + 0.16, SY, 1.0 + k * 0.55), (0.06, 0.62, 0.06), B_DARK)
for y in (-0.31, 0.31):
    bbox((SX + SR + 0.16, SY + y, 5.4), (0.07, 0.07, 9.6), B_DARK)
bmesh.ops.recalc_face_normals(bb, faces=bb.faces)
# the room: an inward-facing shell just inside the walls, floor on top of the stone base
prism([(-W + 0.15, 0.82), (W - 0.15, 0.82), (W - 0.15, H), (3.2, 8.35), (0, 9.3), (-3.2, 8.35), (-W + 0.15, H)], -D + 0.15, D - 0.15,
      B_INSIDE, skip=(1,), inside=True, floor=B_FLOOR)
for i in range(-4, 5):                                                    # wall posts and rafters, for something to catch the lamplight
    for y in (-D + 0.2, D - 0.2):
        bbox((i * 1.15, y, 3.4), (0.16, 0.12, 5.1), B_DARKRED)
for y in (-2.4, 0, 2.4):
    bbox((0, y, 6.0), (2 * W - 0.4, 0.2, 0.2), B_DARKRED)
bmesh.ops.translate(bb, vec=G(BARN['x'], BARN['z']), verts=bb.verts)
barn_me = bpy.data.meshes.new('barn')
bb.to_mesh(barn_me)
bb.free()
for m in BMATS:
    barn_me.materials.append(m)
barn_ob = bpy.data.objects.new('barn', barn_me)
scene.collection.objects.link(barn_ob)

# ---- barn doors: their own objects, hinged at the jambs, so the game can swing them open
door_obs = []
for s, name in ((1, 'door_n'), (-1, 'door_s')):
    db = bmesh.new()
    use(db)
    wdt = DW - 0.03
    box(T((0, -s * wdt / 2, 2.0)) @ S(0.12, wdt, 4.0), C(0x8f2019), zc=(-0.25, 0, 0.25))
    for z in (0.08, 2.0, 3.92):
        box(T((0.07, -s * wdt / 2, z)) @ S(0.08, wdt, 0.16), WHITE)
    for y in (0.08, wdt - 0.08):
        box(T((0.07, -s * y, 2.0)) @ S(0.08, 0.16, 4.0), WHITE, zc=(-0.25, 0, 0.25))
    for rz in (1, -1):
        beam(Vector((0.07, -s * 0.1, 2.0 - rz * 1.85)), Vector((0.07, -s * (wdt - 0.1), 2.0 + rz * 1.85)), 0.14, 0.07, WHITE)
    box(T((0.16, -s * (wdt - 0.25), 2.0)) @ S(0.08, 0.1, 0.5), C(0x2a1820))
    ob = finish(db, name)
    ob.location = G(BARN['x'], BARN['z']) + Vector((W + 0.14, s * DW, 0.8))
    ob.visible_shadow = False      # the barn is baked as if they were open
    ob.visible_diffuse = False
    door_obs.append(ob)

# ================================================================== TERRAIN
R = 132
n = 2 * R + 1
ax = np.arange(-R, R + 1, dtype=np.float64)
GXv, GYv = np.meshgrid(ax, ax, indexing='ij')         # [i, j] -> blender x, y
GH = gy_np(GXv, -GYv)
tb = bmesh.new()
uv_layer = tb.loops.layers.uv.new('uv')
tv = {}
for i in range(n):
    for j in range(n):
        if ax[i] ** 2 + ax[j] ** 2 <= (R + 1.5) ** 2:
            tv[i, j] = tb.verts.new((ax[i], ax[j], GH[i, j]))
for i in range(n - 1):
    for j in range(n - 1):
        q = [tv.get((i, j)), tv.get((i + 1, j)), tv.get((i + 1, j + 1)), tv.get((i, j + 1))]
        if all(q):
            f = tb.faces.new(q)
            f.smooth = True
            for l in f.loops:
                l[uv_layer].uv = ((l.vert.co.x + R) / (2 * R), (l.vert.co.y + R) / (2 * R))
terrain_me = bpy.data.meshes.new('terrain')
tb.to_mesh(terrain_me)
tb.free()
terrain_ob = bpy.data.objects.new('terrain', terrain_me)
scene.collection.objects.link(terrain_ob)

# ---- painted ground colour (numpy, sRGB values straight into an image)
N = min(TEX, 2048)
rng = np.random.default_rng(5)


def vnoise(cells):
    g = rng.random((cells + 2, cells + 2), dtype=np.float32)
    t = np.linspace(0, cells, N, endpoint=False, dtype=np.float32)
    i0 = t.astype(np.int32)
    f = t - i0
    f = f * f * (3 - 2 * f)
    a = g[np.ix_(i0, i0)] * (1 - f)[None, :] + g[np.ix_(i0, i0 + 1)] * f[None, :]
    b = g[np.ix_(i0 + 1, i0)] * (1 - f)[None, :] + g[np.ix_(i0 + 1, i0 + 1)] * f[None, :]
    return a * (1 - f)[:, None] + b * f[:, None]


def sr(h):
    return np.array([(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255], dtype=np.float32)


def lay(img, color, t):
    return img + (sr(color) - img) * t[..., None].astype(np.float32)


px = (np.arange(N, dtype=np.float32) + 0.5) / N * 2 * R - R
X = px[None, :]                     # image columns -> x
Z = -px[:, None]                    # image rows -> blender y -> game -z
Hh = gy_np(X, Z).astype(np.float32)
n1, n2, n3, n4 = vnoise(10), vnoise(40), vnoise(150), vnoise(520)
speck = rng.random((N, N), dtype=np.float32)

img = np.broadcast_to(sr(0x6fb04e), (N, N, 3)).copy()
img = lay(img, 0x93d163, sstep(0.3, 0.75, n1 * 0.6 + n2 * 0.4))
img = lay(img, 0xb7d468, sstep(0.62, 0.86, vnoise(18) * 0.7 + n3 * 0.3) * 0.75)      # dry, sunny patches
img = lay(img, 0x4f9a42, sstep(0.6, 0.9, vnoise(26)) * 0.5)                          # lush patches
img *= (0.93 + 0.14 * n4)[..., None]
img = lay(img, 0xfff7d6, (speck > 0.9992) * sstep(0.45, 0.7, n2) * 0.9)              # daisies
slope = np.hypot(*np.gradient(Hh, 2 * R / N))
img = lay(img, 0x8c7b63, sstep(0.5, 0.95, slope + (n3 - 0.5) * 0.3) * 0.85)          # bare earth on steep ground
img = lay(img, 0x9c9790, sstep(7.2, 10.2, Hh + (n2 - 0.5) * 2.5) * (0.75 + 0.25 * n4))
dpath = path_dist(X.astype(np.float64), Z.astype(np.float64)).astype(np.float32)
dpath = np.minimum(dpath, np.hypot(X, Z) - 1.6)                                      # worn patch where the pig starts
tp = sstep(2.0, 0.85, dpath + (n3 - 0.5) * 1.5)
img = lay(img, 0x8a9a4e, sstep(3.2, 1.6, dpath + (n3 - 0.5) * 1.5) * 0.45)           # trodden verge
img = lay(img, 0xcfa873, tp)
img = lay(img, 0xe8cfa0, tp * (speck > 0.985) * 0.8)                                 # pebbles
img = lay(img, 0xb08d5c, tp * sstep(0.5, 0.8, n4) * 0.35)
d = np.hypot(X - P['pen']['x'], Z - P['pen']['z'])
img = lay(img, 0xb7986a, sstep(5.6, 4.2, d + (n3 - 0.5) * 1.2) * 0.85)
d = np.hypot(X - MILL['x'], Z - MILL['z'])
img = lay(img, 0xcdbf9f, sstep(5.2, 3.4, d + (n3 - 0.5) * 1.5) * 0.8)
for hs in L['HAY_SPOTS']:
    d = np.hypot(X - hs['x'], Z - hs['z'])
    img = lay(img, 0xe6cf7a, sstep(3.6, 1.6, d + (n3 - 0.5) * 2) * (0.35 + 0.4 * (speck > 0.6)))
fd = np.maximum(np.abs(X - fx) - fhx, np.abs(Z - fz) - fhz)
img = lay(img, 0x86603c, sstep(0.6, -0.3, fd + (n3 - 0.5) * 0.6))
for (cx, cz, r0, colr, amt) in ((P['coop']['x'], P['coop']['z'] + 1.5, 4.6, 0xc4a777, 0.85), (P['kennel']['x'], P['kennel']['z'] + 1.5, 3.4, 0xb7986a, 0.85),
                                (P['camp']['x'], P['camp']['z'], 4.6, 0xb39a72, 0.9), (P['camp']['x'], P['camp']['z'], 1.9, 0x4a4040, 0.9),
                                (P['stone']['x'], P['stone']['z'], 3.2, 0x8c8271, 0.8), (P['hole']['x'], P['hole']['z'], 3.4, 0xa89a80, 0.85),
                                (P['horse']['x'], P['horse']['z'], 3.2, 0xb3a78f, 0.8), (P['cats']['x'], P['cats']['z'], 3.3, 0xc4a777, 0.6),
                                (BARN['x'] + 7.0, BARN['z'], 3.0, 0xcfa873, 0.9), (P['crate']['x'], P['crate']['z'], 2.0, 0xb7986a, 0.6),
                                *[(p['x'], p['z'], 1.7, 0xb7986a, 0.8) for p in L['PLATES']]):
    d = np.hypot(X - cx, Z - cz)
    img = lay(img, colr, sstep(r0, r0 * 0.6, d + (n3 - 0.5) * 1.3) * amt)
d = np.hypot(X - P['pond']['x'], Z - P['pond']['z'])
img = lay(img, 0x4f9a42, sstep(8.5, 5.0, d + (n3 - 0.5) * 1.5) * 0.6)                 # lush banks round the pond
img = lay(img, 0x7a6a4a, sstep(-0.1, -0.5, Hh) * sstep(8, 6, d))                     # and a muddy bed
img = lay(img, 0x4a5a48, sstep(-0.6, -1.6, Hh) * sstep(8, 6, d) * 0.8)
d = np.hypot(X - isl['x'], Z - isl['z'])
img = lay(img, 0x9c9790, sstep(4.6, 3.0, d + (n3 - 0.5) * 1.2) * 0.85)
for fr in L['FAIRY_RINGS']:                                                          # lusher, darker grass inside the rings
    d = np.hypot(X - fr['x'], Z - fr['z'])
    img = lay(img, 0x3f8f4a, sstep(3.4, 2.4, d + (n3 - 0.5) * 0.8) * 0.75)
d = np.hypot(X - (-3.5), Z - (-4.0))
img = lay(img, 0x6f5236, sstep(2.6, 1.5, d + (n3 - 0.5) * 1.4))                      # the pig's mud wallow
d = np.hypot(X - P['pit']['x'], Z - P['pit']['z'])
img = lay(img, 0x5a4640, sstep(10.5, 6.5, d + (n3 - 0.5) * 3) * 0.9)
img = lay(img, 0x2e2426, sstep(7.2, 4.6, d + (n3 - 0.5) * 2))
img = lay(img, 0x1a1416, (np.abs(vnoise(90) - 0.5) < 0.018) * sstep(10, 6, d) * 0.8) # cracks
d = np.hypot(X - sn['x'], Z - sn['z'])
img = lay(img, 0xf6fbff, sstep(9.2, 5.6, d + (n3 - 0.5) * 2.6))
sand_t = sstep(0.62, 0.0, Hh + (n2 - 0.5) * 0.5) * sstep(64.0, 76.0, np.hypot(X, Z))   # beaches only, not inland hollows
img = lay(img, 0xf0dca6, sand_t)
img = lay(img, 0xf8ecc8, sand_t * (speck > 0.97) * 0.6)
img = lay(img, 0xd2bb86, sstep(-0.25, -0.6, Hh))                                     # wet sand at the waterline
img = lay(img, 0x8fb7a8, sstep(-0.9, -3.5, Hh) * 0.8)

albedo = bpy.data.images.new('ground_albedo', N, N, alpha=False)
rgba = np.ones((N, N, 4), dtype=np.float32)
rgba[..., :3] = np.clip(img, 0, 1)
albedo.pixels.foreach_set(rgba.ravel())
albedo.filepath_raw = os.path.join(ROOT, 'blender', 'renders', 'ground_albedo.png')
albedo.file_format = 'PNG'
albedo.save()
del img, rgba, n1, n2, n3, n4, speck

# ================================================================== MATERIALS, LIGHT
def node_mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 1.0
    return m, m.node_tree.nodes, m.node_tree.links, m.node_tree.nodes['Principled BSDF']


vm, nodes, links, bsdf = node_mat('props_albedo')
attr = nodes.new('ShaderNodeVertexColor')
attr.layer_name = 'albedo'
links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
for ob in (props_ob, blades_ob, *door_obs, *loose):
    ob.data.materials.append(vm)
    ca = ob.data.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    ob.data.color_attributes.active_color = ca
    ob.data.color_attributes.render_color_index = list(ob.data.color_attributes).index(ca)

for ob in loose_unlit:           # these keep their plain colours; the game lights them
    ob.data.materials.append(vm)
    ob.data.color_attributes.active_color = ob.data.color_attributes['albedo']
    ob.data.color_attributes.render_color_index = 0

tm, nodes, links, bsdf = node_mat('ground')
at = nodes.new('ShaderNodeTexImage')
at.image = albedo
links.new(at.outputs['Color'], bsdf.inputs['Base Color'])
terrain_me.materials.append(tm)

sx, sy, sz = L['SUN_DIR']
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3.7
sun.data.color = C(0xffe2bd)
sun.data.angle = math.radians(2.2)
sun.rotation_euler = Vector((sx, -sz, sy)).normalized().to_track_quat('Z', 'Y').to_euler()
scene.collection.objects.link(sun)
lamp = bpy.data.objects.new('lantern', bpy.data.lights.new('lantern', 'POINT'))
lamp.data.energy = 520
lamp.data.color = C(0xffc98a)
lamp.data.shadow_soft_size = 0.25
lamp.location = LANTERN
scene.collection.objects.link(lamp)
world = bpy.data.worlds.new('sky')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (*C(0xb7d6ff), 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.95
scene.world = world

scene.render.engine = 'CYCLES'
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.render.bake.margin = 8


def only(ob):
    for o in scene.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


# barn: unwrap, then bake
only(barn_ob)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004)
bpy.ops.object.mode_set(mode='OBJECT')

# Bake everything while every object still wears its true colours, so bounce light is right;
# swap in the baked materials afterwards.
print('BAKE props', len(props_ob.data.polygons), 'faces')
scene.render.bake.target = 'VERTEX_COLORS'
for ob in (props_ob, blades_ob, *door_obs, *loose):
    only(ob)
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT', 'COLOR'})

pending = []
for ob, mats, name, size in ((barn_ob, BMATS, 'barn_bake', min(TEX, 2048)), (terrain_ob, [tm], 'ground_bake', TEX)):
    print('BAKE', name, size)
    image = bpy.data.images.new(name, size, size, alpha=False)
    for m in mats:
        nd = m.node_tree.nodes.new('ShaderNodeTexImage')
        nd.image = image
        m.node_tree.nodes.active = nd
    only(ob)
    scene.render.bake.target = 'IMAGE_TEXTURES'
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT', 'COLOR'})
    image.filepath_raw = os.path.join(ROOT, 'blender', 'renders', name + '.png')
    image.file_format = 'PNG'
    image.save()
    pending.append((ob, name, image))

for ob, name, image in pending:
    m, nodes, links, bsdf = node_mat(name)
    tx = nodes.new('ShaderNodeTexImage')
    tx.image = image
    links.new(tx.outputs['Color'], bsdf.inputs['Base Color'])
    ob.data.materials.clear()
    ob.data.materials.append(m)
    for p in ob.data.polygons:
        p.material_index = 0

bm_, nodes, links, bsdf = node_mat('props_baked')
attr = nodes.new('ShaderNodeVertexColor')
attr.layer_name = 'Col'
links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
for ob in (props_ob, blades_ob, *door_obs, *loose):
    ob.data.materials.clear()
    ob.data.materials.append(bm_)
    ob.data.color_attributes.remove(ob.data.color_attributes['albedo'])
    ob.data.color_attributes.active_color = ob.data.color_attributes['Col']

# ================================================================== EXPORT
os.makedirs(os.path.join(ROOT, 'assets'), exist_ok=True)
for o in scene.objects:
    o.select_set(o in (terrain_ob, barn_ob, props_ob, blades_ob, *door_obs, *loose, *loose_unlit))
out_path = os.path.join(ROOT, 'assets', 'world.glb')
bpy.ops.export_scene.gltf(filepath=out_path, export_format='GLB', use_selection=True, export_yup=True,
                          export_image_format='JPEG', export_image_quality=90, export_normals=False,
                          export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                          export_draco_mesh_compression_enable=True)
if '--no-save' not in argv:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'blender', 'world.blend'))
print('DONE', out_path, round(os.path.getsize(out_path) / 1e6, 2), 'MB;',
      len(props_ob.data.polygons), 'prop faces,', len(terrain_me.polygons), 'ground faces')
