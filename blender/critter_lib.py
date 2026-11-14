"""Animals for When Pigs Fly, modelled in Blender.

Import this from a Blender script (it does not touch the scene on import):

    import critter_lib as cl
    parts = cl.build_pig()            # {'pig_body': mesh, 'pig_leg_fl': mesh, ...}
    mesh = cl.joined(cl.build_horse(stone=True), 'horse')

Every animal is built in Blender coordinates with Z up, feet on z = 0, facing -Y (game +Z
after glTF export). Each mesh is in the animal's own space, has a CORNER FLOAT_COLOR
attribute 'albedo' (linear), and carries mesh['pivot']: the point a moving part turns about.

Bodies are made the way you would with clay: overlapping ellipsoids, voxel-remeshed into
one skin, smoothed, decimated, then painted by position. Eyes, hooves, horns and beaks are
added afterwards so they stay crisp.
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix, noise

T = Matrix.Translation


def C(h):
    def f(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (f(h >> 16 & 255), f(h >> 8 & 255), f(h & 255))


def mixc(a, b, t):
    t = max(0.0, min(1.0, t))
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def sstep(a, b, v):
    t = max(0.0, min(1.0, (v - a) / (b - a)))
    return t * t * (3 - 2 * t)


def A(x, f, u):
    """Animal coordinates (x to its left, f forward, u up) as a Blender vector."""
    return Vector((x, -f, u))


def spot(x, f, u, c, r):
    """1 inside a ball of radius r about c = (x, f, u), fading to 0 at its edge."""
    r = (r, r, r) if isinstance(r, (int, float)) else r
    d = math.sqrt(((x - c[0]) / r[0]) ** 2 + ((f - c[1]) / r[1]) ** 2 + ((u - c[2]) / r[2]) ** 2)
    return 1 - sstep(0.75, 1.0, d)


def frame(d, thin=None):
    """Rotation taking local Z to d, with local Y as close to `thin` as it can be."""
    z = Vector(d).normalized()
    h = Vector(thin) if thin is not None else Vector((0, 1, 0))
    y = h - z * h.dot(z)
    if y.length < 1e-5:
        y = z.orthogonal()
    y.normalize()
    x = y.cross(z)
    return Matrix((x, y, z)).transposed().to_4x4()


def _r3(r):
    return (r, r, r) if isinstance(r, (int, float)) else tuple(r)


class Sculpt:
    """A lump of overlapping ellipsoids, fused into one painted skin by build()."""

    def __init__(self):
        self.bm = bmesh.new()

    def ell(self, c, r, d=None, thin=None):
        M = T(Vector(c)) @ (frame(d, thin) if d is not None else Matrix.Identity(4)) @ Matrix.Diagonal((*_r3(r), 1))
        bmesh.ops.create_uvsphere(self.bm, u_segments=16, v_segments=10, radius=1, matrix=M)
        return self

    def cap(self, a, b, ra, rb=None, flat=None):
        """Tapered sausage from a to b. flat = (x, y, z) scale of each ball, in Blender axes."""
        a, b = Vector(a), Vector(b)
        rb = ra if rb is None else rb
        n = max(2, int((b - a).length / (min(ra, rb) * 0.45)) + 1)
        fl = flat or (1, 1, 1)
        for i in range(n):
            t = i / (n - 1)
            r = ra + (rb - ra) * t
            self.ell(a.lerp(b, t), (r * fl[0], r * fl[1], r * fl[2]))
        return self

    def path(self, pts, radii, flat=None):
        for (a, b), (ra, rb) in zip(zip(pts, pts[1:]), zip(radii, radii[1:])):
            self.cap(a, b, ra, rb, flat)
        return self

    def build(self, paint, voxel=0.05, smooth=6, tris=4000):
        """Fuse, smooth, decimate; paint(x, f, u, normal) -> linear rgb. Returns a bmesh."""
        me = bpy.data.meshes.new('tmp_sculpt')
        self.bm.to_mesh(me)
        self.bm.free()
        ob = bpy.data.objects.new('tmp_sculpt', me)
        bpy.context.scene.collection.objects.link(ob)
        m = ob.modifiers.new('r', 'REMESH')
        m.mode, m.voxel_size, m.adaptivity = 'VOXEL', voxel, 0
        if smooth:
            s = ob.modifiers.new('s', 'SMOOTH')
            s.factor, s.iterations = 0.5, smooth
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        n = sum(len(p.vertices) - 2 for p in ob.evaluated_get(dg).data.polygons)
        if n > tris:
            d = ob.modifiers.new('d', 'DECIMATE')
            d.ratio = tris / n
            s2 = ob.modifiers.new('s2', 'SMOOTH')      # take the facets off again
            s2.factor, s2.iterations = 0.5, 2
            dg = bpy.context.evaluated_depsgraph_get()
            dg.update()
        out = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
        bm = bmesh.new()
        bm.from_mesh(out)
        bpy.data.meshes.remove(out)
        col = bm.loops.layers.float_color.new('albedo')
        bm.normal_update()
        for v in bm.verts:
            c = paint(v.co.x, -v.co.y, v.co.z, v.normal)
            for l in v.link_loops:
                l[col] = (c[0], c[1], c[2], 1)
        for f in bm.faces:
            f.smooth = True
        return bm


def empty():
    bm = bmesh.new()
    bm.loops.layers.float_color.new('albedo')
    return bm


def _paint(bm, verts, col, col2=None, axis=None):
    """Colour fresh geometry: flat, or col -> col2 along axis (a Blender vector)."""
    layer = bm.loops.layers.float_color['albedo']
    if col2:
        ax = Vector(axis or (0, 0, 1)).normalized()
        ds = [v.co.dot(ax) for v in verts]
        lo, span = min(ds), max(max(ds) - min(ds), 1e-6)
    for f in {f for v in verts for f in v.link_faces}:
        f.smooth = True
        for l in f.loops:
            c = mixc(col, col2, (l.vert.co.dot(ax) - lo) / span) if col2 else col
            l[layer] = (c[0], c[1], c[2], 1)


def sph(bm, c, r, col, d=None, thin=None, seg=12, col2=None, axis=None):
    M = T(Vector(c)) @ (frame(d, thin) if d is not None else Matrix.Identity(4)) @ Matrix.Diagonal((*_r3(r), 1))
    v = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=max(4, seg * 2 // 3), radius=1, matrix=M)['verts']
    _paint(bm, v, col, col2, axis)


def cone(bm, a, b, r1, r2, col, seg=10, thin=None, flat=1.0, col2=None):
    a, b = Vector(a), Vector(b)
    d = b - a
    M = T((a + b) / 2) @ frame(d, thin) @ Matrix.Diagonal((1, flat, 1, 1))
    v = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r1, radius2=max(r2, 0.004), depth=d.length, matrix=M)['verts']
    _paint(bm, v, col, col2, d)


def tube(bm, pts, rad, col, seg=7, col2=None):
    """Round tube through pts; rad is a number or a function of 0..1 along it."""
    layer = bm.loops.layers.float_color['albedo']
    pts = [Vector(p) for p in pts]
    n = len(pts)
    rings, nrm = [], None
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
        nrm = t.orthogonal().normalized() if nrm is None else (nrm - t * nrm.dot(t)).normalized()
        b = t.cross(nrm)
        r = rad(i / (n - 1)) if callable(rad) else rad
        rings.append([bm.verts.new(p + (nrm * math.cos(k / seg * math.tau) + b * math.sin(k / seg * math.tau)) * r) for k in range(seg)])
    faces = []
    for i in range(n - 1):
        for k in range(seg):
            faces.append((bm.faces.new((rings[i][k], rings[i][(k + 1) % seg], rings[i + 1][(k + 1) % seg], rings[i + 1][k])), (i + 0.5) / (n - 1)))
    faces.append((bm.faces.new(rings[0][::-1]), 0.0))
    faces.append((bm.faces.new(rings[-1]), 1.0))
    bmesh.ops.recalc_face_normals(bm, faces=[f for f, _ in faces])
    for f, t in faces:
        f.smooth = True
        c = mixc(col, col2, t) if col2 else col
        for l in f.loops:
            l[layer] = (c[0], c[1], c[2], 1)


def eye(bm, c, r, out, col=None, glint=True):
    """A dark bead with a white glint. `out` is the way it looks, as a Blender vector."""
    out = Vector(out).normalized()
    sph(bm, c, r, col or C(0x1c1218), seg=12)
    if glint:
        sph(bm, Vector(c) + out * r * 0.72 + Vector((0, 0, r * 0.45)) + Vector((out.y, -out.x, 0)) * r * 0.2, r * 0.36, (1, 1, 1), seg=8)


def done(bm, name, pivot=(0, 0, 0)):
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(52):
            e.smooth = False
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me['pivot'] = tuple(pivot)
    return me


def _scaled(parts, k):
    for me in parts.values():
        me.transform(Matrix.Scale(k, 4))
        me['pivot'] = tuple(v * k for v in me['pivot'])
    return parts


def joined(parts, name='joined'):
    """All of an animal's parts as one mesh, still in the animal's space."""
    bm = empty()
    for me in parts.values():
        bm.from_mesh(me)
    out = bpy.data.meshes.new(name)
    bm.to_mesh(out)
    bm.free()
    out['pivot'] = (0, 0, 0)
    return out


def _leg(name, hip, foot_u, r_top, r_bot, skin, hoof_col, hoof_h, tris, knee=None, paw=None, voxel=0.035, paint=None):
    """One leg hanging from hip = A(...). hoof: a dark cylinder; paw: (length, colour) toe bump instead."""
    hx, hy, hz = hip
    s = Sculpt()
    top = Vector((hx, hy, hz + r_top * 0.3))
    bot = Vector((hx, hy, foot_u + r_bot + (hoof_h or 0) * 0.6))
    if knee:
        k = top.lerp(bot, 0.5) + Vector((0, knee[0], 0))
        s.path([top, k, bot], [r_top, knee[1], r_bot])
    else:
        s.cap(top, bot, r_top, r_bot)
    if paw:
        s.ell(Vector((hx, hy - paw[0] * 0.45, foot_u + r_bot * 0.75)), (r_bot * 1.15, r_bot + paw[0] * 0.5, r_bot * 0.8))
    bm = s.build(paint or (lambda x, f, u, n: skin), voxel=voxel, smooth=3, tris=tris)
    if hoof_h:
        cone(bm, Vector((hx, hy, foot_u)), Vector((hx, hy, foot_u + hoof_h)), r_bot * 1.12, r_bot * 1.02, hoof_col, seg=12)
    return done(bm, name, hip)


# ====================================================================== PIG
PINK, PALE, ROSE, DEEP = C(0xff9db5), C(0xffc6d3), C(0xea7499), C(0xf58aa6)
HOOF = C(0x3a2630)


def build_pig():
    def paint(x, f, u, n):
        c = mixc(PALE, PINK, sstep(0.55, 1.25, u))
        c = mixc(c, DEEP, 0.35 * sstep(1.5, 2.2, u) * sstep(1.2, 0.0, f))
        c = mixc(c, ROSE, 0.5 * (1 - sstep(0.3, 1.0, math.dist((abs(x), f, u), (0.5, 1.6, 1.36)) / 0.3)))          # blush
        if u > 1.98 and abs(x) > 0.18 and f > 0.9 and -n.y > 0.15:                       # inside of the ears
            c = mixc(c, ROSE, 0.85 * sstep(0.15, 0.5, -n.y))
        return c

    s = Sculpt()
    s.ell(A(0, 0, 1.25), (1.05, 1.35, 0.95))
    s.ell(A(0, -0.5, 1.3), (1.0, 0.92, 0.93))
    s.ell(A(0, 0.72, 1.38), (0.86, 0.72, 0.8))
    s.ell(A(0, 1.2, 1.58), (0.7, 0.68, 0.66))
    for sx in (-1, 1):
        s.ell(A(sx * 0.32, 1.5, 1.36), 0.3)
        s.ell(A(sx * 0.5, 1.12, 2.26), (0.24, 0.085, 0.36), d=A(sx * 0.42, 0.42, 0.8), thin=A(0, 1, -0.45))
    s.cap(A(0, 1.55, 1.45), A(0, 1.72, 1.43), 0.36, 0.31)
    bm = s.build(paint, voxel=0.045, smooth=12, tris=5200)
    # snout: a flat rose disc with nostrils
    cone(bm, A(0, 1.8, 1.43), A(0, 2.08, 1.42), 0.34, 0.315, ROSE, seg=20, flat=0.9, thin=(0, 0, 1))
    for sx in (-1, 1):
        sph(bm, A(sx * 0.115, 2.075, 1.44), (0.06, 0.03, 0.085), C(0x7a2f4a), seg=8)
        eye(bm, A(sx * 0.31, 1.745, 1.8), 0.105, A(sx * 0.35, 1, 0.1))
    parts = {'pig_body': done(bm, 'pig_body')}
    for nm, sx, sf in (('fl', 1, 1), ('fr', -1, 1), ('bl', 1, -1), ('br', -1, -1)):
        parts['pig_leg_' + nm] = _leg('pig_leg_' + nm, A(sx * 0.55, sf * 0.72, 0.75), 0.0, 0.25, 0.19, PINK, HOOF, 0.17, 260,
                                      paint=lambda x, f, u, n: mixc(PINK, PALE, sstep(0.7, 0.2, u)))
    # curly tail
    bm = empty()
    pts = []
    for i in range(33):
        t = i / 32
        a = t * math.pi * 4
        pts.append(A(math.cos(a) * 0.16 * min(1, t * 6 + 0.1), -1.28 - t * 0.42, 1.5 + math.sin(a) * 0.16 * min(1, t * 6 + 0.1) + t * 0.1))
    tube(bm, pts, lambda t: 0.06 - t * 0.03, PINK, seg=7, col2=ROSE)
    parts['pig_tail'] = done(bm, 'pig_tail', A(0, -1.28, 1.5))
    parts['pig_wing'] = _wing(A(0.8, 0.15, 1.8))
    return parts


def _wing(pivot):
    """One wing reaching along +X from the shoulder, feathers sweeping back toward the tail (+Y)."""
    bm = empty()
    W0, W1, W2, SH = C(0xfffdf6), C(0xf4ead8), C(0xe6d6bd), C(0xd9c6ab)
    piv = Vector(pivot)

    def feather(base, ang, ln, w, z, c_root, c_tip, th=0.024):
        M = T(piv + Vector((base[0], base[1], z))) @ Matrix.Rotation(ang, 4, 'Z') @ Matrix.Rotation(0.07, 4, 'Y') @ T((ln * 0.5, 0, 0)) @ Matrix.Diagonal((ln * 0.5, w, th, 1))
        v = bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=5, radius=1, matrix=M)['verts']
        d = Vector((math.cos(ang), math.sin(ang), 0))
        _paint(bm, v, c_root, c_tip, d)

    n = 10                                   # flight feathers: short at the shoulder, longest near the tip
    for i in range(n):
        t = i / (n - 1)
        base = (0.12 + 0.95 * t, 0.05 - 0.1 * math.sin(t * 3.1))
        ang = 1.42 - 1.22 * t ** 0.9
        ln = 0.62 + 0.5 * math.sin(min(1, t * 1.15) * 2.2) + 0.1 * t
        feather(base, ang, ln, 0.115, -0.012 * i * 0.3, W1, SH if i % 2 else W2)
    n = 8                                    # coverts over their roots
    for i in range(n):
        t = i / (n - 1)
        base = (0.08 + 0.92 * t, 0.0 - 0.1 * math.sin(t * 3.1))
        feather(base, 1.36 - 1.1 * t, 0.42 + 0.14 * math.sin(t * 3), 0.1, 0.035, W0, W1)
    n = 6                                    # small coverts
    for i in range(n):
        t = i / (n - 1)
        base = (0.05 + 0.85 * t, -0.03 - 0.1 * math.sin(t * 3.1))
        feather(base, 1.3 - 1.0 * t, 0.24 + 0.05 * math.sin(t * 3), 0.085, 0.065, W0, W0, th=0.03)
    for i in range(7):                       # the arm: a soft leading edge
        t = i / 6
        sph(bm, piv + Vector((0.02 + 0.98 * t, -0.07 - 0.1 * math.sin(t * 3.1), 0.045)), (0.14 - 0.05 * t, 0.1 - 0.035 * t, 0.085 - 0.03 * t), W0, seg=8)
    return done(bm, 'pig_wing', pivot)


# ====================================================================== COW
def build_cow():
    WHITE, BLACK, MUZ, HORN = C(0xfffaf0), C(0x2b2428), C(0xffb3c2), C(0xe8dcc0)

    def patch(x, f, u):
        return noise.noise(Vector((x * 0.75 + 1.7, f * 0.75 + 4.2, u * 0.75 + 0.6))) + 0.35 * noise.noise(Vector((x * 2.1, f * 2.1 + 9, u * 2.1)))

    def paint(x, f, u, n):
        c = mixc(WHITE, BLACK, sstep(0.1, 0.16, patch(x, f, u)))
        c = mixc(c, WHITE, sstep(1.45, 1.1, u))                                         # white belly and brisket
        c = mixc(c, MUZ, spot(x, f, u, (0, -0.55, 1.02), (0.5, 0.55, 0.36)))            # udder
        return c

    s = Sculpt()
    s.ell(A(0, -0.05, 1.8), (0.9, 1.2, 0.82))
    s.ell(A(0, 0.62, 1.88), (0.8, 0.62, 0.84))
    s.ell(A(0, -0.72, 1.9), (0.86, 0.6, 0.8))
    s.ell(A(0, 0.1, 1.45), (0.72, 0.95, 0.5))
    s.cap(A(0, 0.95, 2.02), A(0, 1.32, 2.36), 0.5, 0.4)
    s.cap(A(0, 1.0, 1.55), A(0, 1.2, 1.95), 0.3, 0.26, flat=(0.6, 1, 1))               # dewlap
    s.ell(A(0, -0.55, 1.08), (0.42, 0.46, 0.34))
    bm = s.build(paint, voxel=0.05, smooth=12, tris=3600)
    for sx in (-1, 1):
        for sf in (-1, 1):
            cone(bm, A(sx * 0.17, -0.55 + sf * 0.17, 0.82), A(sx * 0.18, -0.55 + sf * 0.18, 0.64), 0.07, 0.045, C(0xf58aa6), seg=8)
    parts = {'cow_body': done(bm, 'cow_body')}

    def hpaint(x, f, u, n):
        side = sstep(0.12, 0.2, abs(x) + 0.12 * math.sin(u * 5)) * sstep(2.28, 2.4, u)   # black cheeks, white blaze
        c = mixc(WHITE, BLACK, side)
        c = mixc(c, MUZ, sstep(1.72, 1.86, f) * sstep(2.5, 2.38, u))
        if abs(x) > 0.5 and -n.y > 0.2:
            c = mixc(c, MUZ, 0.8)                                                        # inside of the ears
        return c

    s = Sculpt()
    s.ell(A(0, 1.42, 2.52), (0.5, 0.5, 0.5))
    s.cap(A(0, 1.2, 2.3), A(0, 1.4, 2.45), 0.4, 0.42)
    s.cap(A(0, 1.68, 2.36), A(0, 1.95, 2.2), 0.4, 0.36, flat=(1.05, 1, 0.88))
    s.ell(A(0, 1.5, 2.98), (0.26, 0.2, 0.14))                                           # forelock
    for sx in (-1, 1):
        s.ell(A(sx * 0.72, 1.3, 2.68), (0.18, 0.07, 0.34), d=A(sx * 1, 0.1, 0.12), thin=A(0, 1, 0.2))
    bm = s.build(hpaint, voxel=0.04, smooth=5, tris=2600)
    for sx in (-1, 1):
        tube(bm, [A(sx * 0.3, 1.36, 2.9), A(sx * 0.46, 1.36, 3.06), A(sx * 0.5, 1.38, 3.24), A(sx * 0.44, 1.42, 3.4)], lambda t: 0.085 - t * 0.065, HORN, seg=8, col2=C(0xfff6e0))
        eye(bm, A(sx * 0.41, 1.7, 2.62), 0.085, A(sx * 0.7, 1, 0.1))
        sph(bm, A(sx * 0.15, 2.285, 2.24), (0.06, 0.035, 0.045), C(0x8a4a5c), seg=8)
    parts['cow_head'] = done(bm, 'cow_head', A(0, 1.25, 2.32))

    for nm, sx, sf in (('fl', 1, 1), ('fr', -1, 1), ('bl', 1, -1), ('br', -1, -1)):
        hip = A(sx * 0.52, sf * 0.82 - 0.05, 1.3)
        parts['cow_leg_' + nm] = _leg('cow_leg_' + nm, hip, 0.0, 0.3, 0.16, WHITE, C(0x2b2428), 0.2, 300, knee=(0.04 * sf, 0.2),
                                      paint=lambda x, f, u, n, o=sx * 3 + sf: mixc(WHITE, BLACK, sstep(0.1, 0.16, patch(x, f, u)) * sstep(0.75, 1.0, u)))
    bm = empty()
    tube(bm, [A(0, -1.25, 2.25), A(0, -1.42, 2.15), A(0, -1.48, 1.8), A(0, -1.46, 1.4), A(0, -1.44, 1.05)], lambda t: 0.06 - t * 0.02, WHITE, seg=7)
    sph(bm, A(0, -1.44, 0.9), (0.1, 0.1, 0.2), BLACK, seg=8)
    parts['cow_tail'] = done(bm, 'cow_tail', A(0, -1.25, 2.25))
    return _scaled(parts, 0.92)


# ====================================================================== CAT
def build_cat(fur=0xf2a65a, stripe=0xc97a2e, white=0xfff6ea):
    FUR, STRIPE, WHT = C(fur), C(stripe), C(white)

    def tabby(x, f, u, k=13.0):
        return sstep(0.35, 0.75, math.sin(f * k + abs(x) * 5 + 2.5 * noise.noise(Vector((x * 2, f * 2, u * 2)))))

    def paint(x, f, u, n):
        c = mixc(FUR, STRIPE, tabby(x, f, u) * sstep(0.42, 0.56, u))
        c = mixc(c, WHT, spot(x, f, u, (0, 0.34, 0.42), (0.2, 0.2, 0.24)))               # bib
        return mixc(c, WHT, sstep(0.38, 0.3, u) * 0.8)

    s = Sculpt()
    s.ell(A(0, -0.02, 0.54), (0.215, 0.4, 0.21))
    s.ell(A(0, 0.2, 0.55), (0.2, 0.22, 0.22))
    s.ell(A(0, -0.25, 0.55), (0.215, 0.2, 0.215))
    s.cap(A(0, 0.3, 0.6), A(0, 0.38, 0.72), 0.15, 0.14)
    bm = s.build(paint, voxel=0.022, smooth=5, tris=1100)
    parts = {'cat_body': done(bm, 'cat_body')}

    def hpaint(x, f, u, n):
        c = mixc(FUR, STRIPE, sstep(0.3, 0.7, math.sin(x * 30)) * sstep(0.9, 0.96, u) * sstep(0.62, 0.5, f))
        c = mixc(c, WHT, spot(x, f, u, (0, 0.66, 0.74), (0.15, 0.12, 0.1)))              # muzzle
        return c

    s = Sculpt()
    s.ell(A(0, 0.48, 0.82), (0.26, 0.22, 0.21))
    s.cap(A(0, 0.36, 0.68), A(0, 0.42, 0.76), 0.14)
    for sx in (-1, 1):
        s.ell(A(sx * 0.13, 0.6, 0.76), (0.1, 0.09, 0.08))
        s.ell(A(sx * 0.19, 0.5, 0.74), 0.09)
    bm = s.build(hpaint, voxel=0.02, smooth=4, tris=1000)
    for sx in (-1, 1):
        cone(bm, A(sx * 0.155, 0.47, 0.96), A(sx * 0.2, 0.47, 1.2), 0.1, 0.0, FUR, seg=8, flat=0.5, thin=A(0, 1, 0))
        cone(bm, A(sx * 0.158, 0.5, 0.98), A(sx * 0.196, 0.49, 1.15), 0.065, 0.0, C(0xf7a8b8), seg=6, flat=0.4, thin=A(0, 1, 0))
        sph(bm, A(sx * 0.115, 0.665, 0.86), (0.05, 0.03, 0.058), C(0x7fc25a), seg=10)
        sph(bm, A(sx * 0.118, 0.688, 0.86), (0.016, 0.012, 0.046), C(0x1c1218), seg=8)
        sph(bm, A(sx * 0.105, 0.694, 0.885), 0.011, (1, 1, 1), seg=6)
    sph(bm, A(0, 0.705, 0.785), (0.028, 0.02, 0.02), C(0xf58aa6), seg=8)
    parts['cat_head'] = done(bm, 'cat_head', A(0, 0.38, 0.7))
    for nm, sx, sf in (('fl', 1, 1), ('fr', -1, 1), ('bl', 1, -1), ('br', -1, -1)):
        hip = A(sx * 0.12, 0.22 if sf > 0 else -0.28, 0.42)
        parts['cat_leg_' + nm] = _leg('cat_leg_' + nm, hip, 0.0, 0.085, 0.058, FUR, None, 0, 110, paw=(0.07, WHT), voxel=0.018,
                                      paint=lambda x, f, u, n: mixc(WHT, FUR, sstep(0.1, 0.17, u)))
    bm = empty()
    pts = [A(0, -0.4 - 0.2 * math.sin(t * 1.6), 0.6 + t * 0.62) + A(0, 0.16 * t * t, 0) for t in [i / 9 for i in range(10)]]
    layer_pts = pts
    tube(bm, layer_pts, lambda t: 0.05 - 0.012 * t, FUR, seg=7, col2=STRIPE)
    sph(bm, pts[-1], 0.04, STRIPE, seg=8)
    parts['cat_tail'] = done(bm, 'cat_tail', A(0, -0.4, 0.6))
    return parts


# ====================================================================== DOG (an old one)
def build_dog(coat=0x9b6a44, tan=0xdcb88e, ear=0x5e3d28, grey=0xe2dcd2):
    COAT, TAN, EAR, GREY = C(coat), C(tan), C(ear), C(grey)

    def paint(x, f, u, n):
        c = mixc(TAN, COAT, sstep(0.62, 0.86, u))
        c = mixc(c, TAN, spot(x, f, u, (0, 0.62, 0.8), (0.3, 0.26, 0.34)))               # chest
        return mixc(c, C(0x7a5236), 0.5 * spot(x, f, u, (0, -0.2, 1.2), (0.3, 0.5, 0.2)))  # saddle

    s = Sculpt()
    s.ell(A(0, 0.3, 0.9), (0.37, 0.46, 0.4))
    s.ell(A(0, -0.3, 0.88), (0.33, 0.5, 0.34))
    s.ell(A(0, -0.62, 0.9), (0.32, 0.26, 0.33))
    s.cap(A(0, 0.55, 1.05), A(0, 0.72, 1.24), 0.27, 0.24)
    bm = s.build(paint, voxel=0.03, smooth=5, tris=1300)
    parts = {'dog_body': done(bm, 'dog_body')}

    def hpaint(x, f, u, n):
        c = mixc(TAN, COAT, sstep(1.28, 1.4, u + 0.3 * abs(x)))
        c = mixc(c, GREY, sstep(0.98, 1.16, f) * 0.9)                                    # an old dog's grey muzzle
        if abs(x) > 0.27 or (abs(x) > 0.2 and u < 1.2 and f < 0.95):
            c = mixc(c, EAR, sstep(0.24, 0.3, abs(x) + (0.08 if u < 1.25 else 0)))       # ears
        c = mixc(c, TAN, spot(abs(x), f, u, (0.13, 1.0, 1.5), 0.07))                     # eyebrows
        return c

    s = Sculpt()
    s.ell(A(0, 0.82, 1.34), (0.3, 0.3, 0.28))
    s.cap(A(0, 0.66, 1.18), A(0, 0.76, 1.28), 0.23)
    s.cap(A(0, 1.0, 1.26), A(0, 1.24, 1.2), 0.19, 0.15, flat=(1.05, 1, 0.9))
    s.ell(A(0, 1.2, 1.14), (0.17, 0.12, 0.08))                                           # jowls
    for sx in (-1, 1):
        s.path([A(sx * 0.27, 0.74, 1.5), A(sx * 0.37, 0.76, 1.3), A(sx * 0.36, 0.8, 1.06)], [0.1, 0.13, 0.1], flat=(0.5, 1, 1))
        s.ell(A(sx * 0.13, 0.98, 1.47), (0.08, 0.06, 0.045))                             # brow
    bm = s.build(hpaint, voxel=0.024, smooth=4, tris=1400)
    sph(bm, A(0, 1.385, 1.235), (0.07, 0.055, 0.055), C(0x1c1218), seg=10)
    for sx in (-1, 1):
        eye(bm, A(sx * 0.14, 1.07, 1.4), 0.05, A(sx * 0.3, 1, 0.1))
    parts['dog_head'] = done(bm, 'dog_head', A(0, 0.66, 1.2))
    for nm, sx, sf in (('fl', 1, 1), ('fr', -1, 1), ('bl', 1, -1), ('br', -1, -1)):
        hip = A(sx * 0.22, 0.42 if sf > 0 else -0.6, 0.66)
        parts['dog_leg_' + nm] = _leg('dog_leg_' + nm, hip, 0.0, 0.15 if sf > 0 else 0.17, 0.09, COAT, None, 0, 130, paw=(0.1, TAN), voxel=0.024,
                                      paint=lambda x, f, u, n: mixc(TAN, COAT, sstep(0.14, 0.5, u)))
    bm = empty()
    tube(bm, [A(0, -0.8, 1.02), A(0, -1.0, 1.1), A(0, -1.14, 1.28), A(0, -1.16, 1.5), A(0, -1.08, 1.66)], lambda t: 0.065 - 0.03 * t, COAT, seg=7, col2=TAN)
    parts['dog_tail'] = done(bm, 'dog_tail', A(0, -0.8, 1.02))
    return _scaled(parts, 0.88)


# ====================================================================== HEN
def build_hen():
    CREAM, WHT, RED, YEL = C(0xf6ead2), C(0xffffff), C(0xd9342b), C(0xf2b233)

    def paint(x, f, u, n):
        c = mixc(CREAM, WHT, sstep(0.3, 0.6, u))
        c = mixc(c, C(0xe2cfa8), 0.6 * spot(abs(x), f, u, (0.25, -0.05, 0.44), (0.1, 0.26, 0.17)))  # wings
        return c

    s = Sculpt()
    s.ell(A(0, 0, 0.44), (0.25, 0.31, 0.24))
    s.ell(A(0, 0.16, 0.45), (0.21, 0.2, 0.22))
    s.cap(A(0, 0.2, 0.55), A(0, 0.27, 0.72), 0.13, 0.1)
    for sx in (-1, 1):
        s.ell(A(sx * 0.22, -0.04, 0.46), (0.07, 0.23, 0.15))
    bm = s.build(paint, voxel=0.018, smooth=4, tris=700)
    parts = {'hen_body': done(bm, 'hen_body')}

    s = Sculpt()
    s.ell(A(0, 0.3, 0.79), 0.125)
    s.cap(A(0, 0.24, 0.62), A(0, 0.28, 0.74), 0.095)
    bm = s.build(lambda x, f, u, n: WHT, voxel=0.014, smooth=3, tris=350)
    for i, (f, u, r) in enumerate(((0.36, 0.905, 0.045), (0.3, 0.925, 0.055), (0.235, 0.905, 0.045))):
        sph(bm, A(0, f, u), (r * 0.55, r, r), RED, seg=8)
    sph(bm, A(0, 0.4, 0.69), (0.028, 0.035, 0.06), RED, seg=8)
    cone(bm, A(0, 0.4, 0.775), A(0, 0.53, 0.75), 0.05, 0.0, YEL, seg=8, flat=0.75, thin=(0, 0, 1))
    for sx in (-1, 1):
        eye(bm, A(sx * 0.105, 0.35, 0.82), 0.028, A(sx * 1, 0.4, 0.1))
    parts['hen_head'] = done(bm, 'hen_head', A(0, 0.24, 0.64))

    for nm, sx in (('l', 1), ('r', -1)):
        bm = empty()
        hip = A(sx * 0.1, 0.0, 0.26)
        cone(bm, A(sx * 0.1, 0, 0.3), A(sx * 0.1, 0, 0.02), 0.03, 0.022, YEL, seg=6)
        for a in (-0.6, 0, 0.6):
            cone(bm, A(sx * 0.1, 0, 0.02), A(sx * 0.1 + math.sin(a) * 0.12, math.cos(a) * 0.13, 0.012), 0.02, 0.008, YEL, seg=5)
        cone(bm, A(sx * 0.1, 0, 0.02), A(sx * 0.1, -0.07, 0.012), 0.018, 0.008, YEL, seg=5)
        parts['hen_leg_' + nm] = done(bm, 'hen_leg_' + nm, hip)

    bm = empty()
    for i in range(5):
        a = (i - 2) * 0.3
        base, tip = A(math.sin(a) * 0.05, -0.24, 0.52), A(math.sin(a) * 0.2, -0.42 - 0.04 * math.cos(a * 2), 0.8 - abs(a) * 0.12)
        sph(bm, (base + tip) / 2, (0.05, 0.02, (tip - base).length / 2), WHT, d=tip - base, thin=A(0, 1, 0.6), seg=8, col2=CREAM, axis=base - tip)
    parts['hen_tail'] = done(bm, 'hen_tail', A(0, -0.24, 0.52))
    return parts


# ====================================================================== ELEPHANT (sitting, toy-like)
def build_elephant(tris=9000):
    """Sits on the origin facing -Y (game +Z). About 3.6 tall, 3.3 wide at the ears,
    from y = -2.2 (toes) to y = +1.4 (back) in Blender; game z = +2.2 to -1.4."""
    GREY, LIGHT, PINKE, DARK = C(0x8f9bb3), C(0xb9c2d4), C(0xeaa9ba), C(0x6f7a92)

    def paint(x, f, u, n):
        c = mixc(DARK, GREY, sstep(0.2, 1.2, u))
        c = mixc(c, LIGHT, 0.75 * spot(x, f, u, (0, 0.75, 1.3), (0.8, 0.6, 0.95)))       # tummy
        if abs(x) > 0.95 and u > 2.2 and f < 0.6 and -n.y > 0.25:
            c = mixc(c, PINKE, 0.85 * sstep(0.95, 1.1, abs(x)))                          # inside of the ears
        c = mixc(c, LIGHT, 0.5 * sstep(1.95, 2.1, f) * sstep(1.0, 0.9, u))               # soles
        c = mixc(c, PINKE, 0.5 * spot(abs(x), f, u, (0.5, 1.08, 2.62), 0.2))             # blush
        return c

    s = Sculpt()
    s.ell(A(0, -0.2, 1.15), (1.25, 1.15, 1.2))
    s.ell(A(0, 0.0, 2.0), (0.98, 0.9, 0.9))
    s.ell(A(0, 0.4, 2.85), (0.8, 0.78, 0.76))
    s.ell(A(0, 0.5, 3.3), (0.5, 0.5, 0.32))
    for sx in (-1, 1):
        s.ell(A(sx * 1.18, 0.2, 2.85), (0.56, 0.1, 0.72), d=A(sx * 0.12, -0.1, 1), thin=A(sx * 0.35, 1, 0))
        s.cap(A(sx * 0.82, 0.2, 0.52), A(sx * 1.0, 1.6, 0.5), 0.52, 0.46)               # hind legs, stuck out in front
        s.path([A(sx * 0.72, 0.55, 2.05), A(sx * 0.7, 1.0, 1.4), A(sx * 0.52, 1.15, 0.85)], [0.4, 0.36, 0.36])  # front legs, resting
    pts = [A(0, 1.0, 2.7), A(0, 1.38, 2.35), A(0, 1.52, 1.85), A(0, 1.62, 1.45), A(0, 1.85, 1.25), A(0, 2.08, 1.4), A(0, 2.1, 1.66)]
    s.path(pts, [0.36, 0.3, 0.26, 0.22, 0.19, 0.17, 0.15])
    bm = s.build(paint, voxel=0.06, smooth=12, tris=tris)
    for sx in (-1, 1):
        eye(bm, A(sx * 0.42, 1.08, 2.98), 0.085, A(sx * 0.3, 1, 0.1))
        tube(bm, [A(sx * 0.34, 1.08, 2.42), A(sx * 0.42, 1.4, 2.22), A(sx * 0.46, 1.62, 2.24), A(sx * 0.46, 1.76, 2.36)], lambda t: 0.1 - 0.065 * t, C(0xfff6e0), seg=8)
        for k in (-1, 0, 1):                                                             # toenails
            sph(bm, A(sx * 1.0 + k * 0.22, 2.02, 0.26 - abs(k) * 0.02), (0.1, 0.06, 0.12), C(0xfff6e0), seg=8)
            sph(bm, A(sx * 0.52 + k * 0.17, 1.47, 0.62), (0.075, 0.05, 0.085), C(0xfff6e0), seg=8)
    tube(bm, [A(0, -1.3, 0.75), A(0, -1.62, 0.5), A(0.2, -1.85, 0.2), A(0.45, -1.9, 0.08)], lambda t: 0.07 - 0.03 * t, GREY, seg=6)
    sph(bm, A(0.5, -1.9, 0.08), (0.12, 0.07, 0.07), DARK, seg=6)
    return {'elephant': done(bm, 'elephant')}


# ====================================================================== HORSE (standing, for a statue)
def build_horse(stone=False, tris=8000):
    """Stands on the origin facing -Y (game +Z). About 3.45 tall at the ears, 1.3 wide,
    from y = -2.05 (nose) to y = +1.6 (tail) in Blender; game z = +2.05 to -1.6.
    stone=True paints it as weathered stone with moss on top."""
    COAT, MANE, WHT = C(0x9a5a34), C(0x3a2418), C(0xfff6ea)
    S0, S1, MOSS = C(0x9a948c), C(0x6f6a66), C(0x6f9a4a)

    def is_mane(x, f, u):
        crest = abs(x) < 0.17 and u > 2.45 and f < 1.42 and f > 0.55 and (u - 2.3) > (f - 0.62) * 0.95
        tail = f < -1.22
        fore = abs(x) < 0.16 and u > 3.22 and f > 1.3
        return crest or tail or fore

    def paint(x, f, u, n):
        if stone:
            k = 0.5 + 0.5 * noise.noise(Vector((x * 1.6, f * 1.6, u * 1.6)))
            c = mixc(S1, S0, 0.25 + 0.5 * k + 0.25 * max(0, n.z))
            m = sstep(0.55, 0.8, n.z + 0.35 * noise.noise(Vector((x * 3, f * 3, u * 3 + 7))))
            return mixc(c, MOSS, 0.6 * m)
        c = mixc(C(0x7c4526), COAT, sstep(0.9, 2.0, u))
        c = mixc(c, WHT, sstep(0.55, 0.4, u))                                            # socks
        c = mixc(c, WHT, spot(x, f, u, (0, 1.78, 2.98), (0.1, 0.32, 0.36)))              # blaze
        if is_mane(x, f, u):
            c = MANE
        return c

    s = Sculpt()
    s.ell(A(0, 0, 2.02), (0.56, 1.05, 0.58))
    s.ell(A(0, 0.72, 2.08), (0.56, 0.52, 0.62))
    s.ell(A(0, -0.72, 2.12), (0.6, 0.56, 0.62))
    s.path([A(0, 0.85, 2.3), A(0, 1.12, 2.7), A(0, 1.32, 3.02)], [0.46, 0.36, 0.3], flat=(0.82, 1, 1))
    s.ell(A(0, 1.45, 3.08), (0.25, 0.3, 0.28))
    s.cap(A(0, 1.55, 3.02), A(0, 1.9, 2.7), 0.23, 0.17)
    s.ell(A(0, 1.9, 2.66), (0.17, 0.15, 0.14))
    for sx in (-1, 1):
        s.ell(A(sx * 0.14, 1.34, 3.36), (0.075, 0.05, 0.15), d=A(sx * 0.2, 0.15, 1), thin=A(0, 1, 0))
        for sf, hip_f in ((1, 0.78), (-1, -0.82)):
            top, mid, low, hoof = A(sx * 0.3, hip_f, 1.75), A(sx * 0.3, hip_f + 0.03 * sf - (0.1 if sf < 0 else 0), 1.0), A(sx * 0.3, hip_f, 0.32), A(sx * 0.3, hip_f + 0.03, 0.12)
            s.path([top, mid, low, hoof], [0.27 if sf > 0 else 0.32, 0.14, 0.105, 0.14])
    for i in range(7):                                                                   # mane down the crest
        t = i / 6
        s.ell(A(0, 1.36 - 0.72 * t, 3.2 - 0.72 * t), (0.1, 0.17, 0.2))
    s.ell(A(0, 1.52, 3.36), (0.1, 0.16, 0.1))                                            # forelock
    s.path([A(0, -1.2, 2.35), A(0, -1.45, 2.2), A(0, -1.52, 1.6), A(0, -1.46, 1.0)], [0.16, 0.17, 0.2, 0.1])
    bm = s.build(paint, voxel=0.045, smooth=5, tris=tris)
    if not stone:
        for sx in (-1, 1):
            eye(bm, A(sx * 0.215, 1.6, 3.12), 0.055, A(sx * 1, 0.4, 0.1))
            sph(bm, A(sx * 0.09, 2.03, 2.66), (0.035, 0.025, 0.045), C(0x2a1a14), seg=8)
            for hip_f in (0.78, -0.82):
                cone(bm, A(sx * 0.3, hip_f + 0.03, 0.0), A(sx * 0.3, hip_f + 0.03, 0.2), 0.165, 0.145, C(0x2a1a14), seg=12)
    return {'horse': done(bm, 'horse')}


BUILDERS = {'pig': build_pig, 'cow': build_cow, 'cat': build_cat, 'dog': build_dog, 'hen': build_hen,
            'elephant': build_elephant, 'horse': build_horse}
