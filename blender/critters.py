"""Builds the game's animals and writes assets/critters.glb.

    blender -b --python blender/critters.py -- [--zoo] [--no-render] [--only pig,cow]

Each animal is an empty named pig / cow / cat / dog / hen at the origin with its parts as
children (<name>_body, _head, _leg_fl ..., _tail, pig_wing), each part's origin at the joint
it turns about. Colours, with a soft ambient-occlusion shade, are in vertex colours.
Preview renders go to blender/renders/critters_*.png. --zoo also renders the elephant and the
horse statue (those two are baked into the island by world_bake.py, not exported here).
"""
import bpy, math, os, sys
import numpy as np
from mathutils import Vector, Matrix

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'blender'))
import critter_lib as cl

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ZOO = '--zoo' in argv
ONLY = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
GAME = ['pig', 'cow', 'cat', 'dog', 'hen']
AO_FLOOR = 0.6       # how dark full occlusion gets

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 48
scene.cycles.use_denoising = True
world = bpy.data.worlds.new('sky')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (*cl.C(0xd6e8ff), 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
world.light_settings.distance = 0.7
scene.world = world

mat = bpy.data.materials.new('critter')
mat.use_nodes = True
attr = mat.node_tree.nodes.new('ShaderNodeVertexColor')
attr.layer_name = 'Col'
bsdf = mat.node_tree.nodes['Principled BSDF']
bsdf.inputs['Roughness'].default_value = 0.75
mat.node_tree.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])


def only(ob):
    for o in scene.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


names = [n for n in GAME + (['elephant', 'horse', 'stone'] if ZOO else []) if not ONLY or n in ONLY]
roots, x, report = {}, 0.0, []
for name in names:
    parts = cl.build_horse(stone=True) if name == 'stone' else cl.BUILDERS[name]()
    root = bpy.data.objects.new(name, None)
    scene.collection.objects.link(root)
    lo, hi, tris = Vector((9, 9, 9)), Vector((-9, -9, -9)), 0
    for pname, me in parts.items():
        piv = Vector(me['pivot'])
        for v in me.vertices:
            lo = Vector(map(min, lo, v.co))
            hi = Vector(map(max, hi, v.co))
        me.transform(Matrix.Translation(-piv))
        ob = bpy.data.objects.new(pname, me)
        ob.location = piv
        ob.parent = root
        scene.collection.objects.link(ob)
        me.materials.append(mat)
        t = sum(len(p.vertices) - 2 for p in me.polygons)
        tris += t
        report.append(f'  {pname}: {t} tris, pivot ({piv.x:.2f}, {piv.z:.2f}, {-piv.y:.2f}) game xyz')
    w = max(hi.x - lo.x, (hi.y - lo.y) * 0.8)
    x += w / 2 + 0.5
    root.location.x = x
    x += w / 2 + 0.5
    roots[name] = root
    report.append(f'{name}: {tris} tris; wide {hi.x - lo.x:.2f}, long {hi.y - lo.y:.2f}, tall {hi.z:.2f}')
total_w = x
bpy.context.view_layer.update()

# ---- soft ambient occlusion, multiplied into the colours
scene.render.bake.target = 'VERTEX_COLORS'
scene.cycles.samples = 256
for root in roots.values():
    for ob in root.children:
        me = ob.data
        ao = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        me.color_attributes.active_color = ao
        only(ob)
        bpy.ops.object.bake(type='AO')
        n = len(me.loops)
        a, c = np.empty(n * 4, dtype=np.float32), np.empty(n * 4, dtype=np.float32)
        ao.data.foreach_get('color', a)
        me.color_attributes['albedo'].data.foreach_get('color', c)
        a, c = a.reshape(n, 4), c.reshape(n, 4)
        # average the occlusion over each vertex and its neighbours, or it comes out blotchy
        lv = np.empty(n, dtype=np.int32)
        me.loops.foreach_get('vertex_index', lv)
        ed = np.empty(len(me.edges) * 2, dtype=np.int32)
        me.edges.foreach_get('vertices', ed)
        ed = ed.reshape(-1, 2)
        nv = len(me.vertices)
        cnt = np.maximum(np.bincount(lv, minlength=nv), 1)
        av = np.bincount(lv, weights=a[:, 0], minlength=nv) / cnt
        deg = np.maximum(np.bincount(ed.ravel(), minlength=nv), 1)
        for _ in range(4):
            nb = np.bincount(ed[:, 0], weights=av[ed[:, 1]], minlength=nv) + np.bincount(ed[:, 1], weights=av[ed[:, 0]], minlength=nv)
            av = 0.5 * av + 0.5 * nb / deg
        shade = (AO_FLOOR + (1 - AO_FLOOR) * np.clip(av[lv] * 1.3, 0, 1))[:, None].astype(np.float32)
        if ob.name == 'pig_wing':
            shade = 0.8 + 0.2 * shade    # feathers overlap; keep them light
        c[:, :3] *= shade
        ao.data.foreach_set('color', c.ravel())
        me.color_attributes.remove(me.color_attributes['albedo'])
        me.color_attributes.active_color = me.color_attributes['Col']
        me.color_attributes.render_color_index = 0

# ---- preview renders
scene.cycles.samples = 32
if '--no-render' not in argv:
    gm = bpy.data.materials.new('ground')
    gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*cl.C(0x8fc866), 1)
    bpy.ops.mesh.primitive_plane_add(size=200)
    ground = bpy.context.object
    ground.data.materials.append(gm)
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.2
    sun.data.color = cl.C(0xffe2bd)
    sun.data.angle = math.radians(3)
    sun.rotation_euler = Vector((0.5, -0.6, 0.62)).normalized().to_track_quat('Z', 'Y').to_euler()
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.lens = 70
    scene.render.resolution_x, scene.render.resolution_y = 1800, 620
    scene.view_settings.view_transform = 'Standard'
    cx = total_w / 2
    dist = total_w * 1.55 + 4
    for tag, d in (('front', Vector((0, -1, 0.16))), ('side', Vector((0, -1, 0.12))), ('top', Vector((0.01, -0.5, 1))), ('three', Vector((0.62, -1, 0.3))), ('back', Vector((-0.5, 1, 0.42)))):
        if tag == 'side':     # turn each animal so it shows its flank
            for r in roots.values():
                r.rotation_euler.z = math.radians(90)
        look = Vector((cx, 0, 1.25 if ZOO else 0.95))
        cam.location = look + d.normalized() * dist
        cam.rotation_euler = (look - cam.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(ROOT, 'blender', 'renders', f'critters_{"zoo_" if ZOO else ""}{tag}.png')
        bpy.ops.render.render(write_still=True)
        for r in roots.values():
            r.rotation_euler.z = 0
    bpy.data.objects.remove(ground)

print('\n'.join(report))

# ---- export
if not ZOO and not ONLY:
    for o in scene.objects:
        o.select_set(False)
    for name in GAME:
        roots[name].location = (0, 0, 0)
        roots[name].select_set(True)
        for ob in roots[name].children:
            ob.select_set(True)
    out = os.path.join(ROOT, 'assets', 'critters.glb')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_yup=True,
                              export_normals=True, export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                              export_draco_mesh_compression_enable=True)
    print('DONE', out, round(os.path.getsize(out) / 1e6, 2), 'MB')
