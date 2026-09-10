from pathlib import Path
import copy
from datetime import datetime, timezone
import hashlib
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

if len(sys.argv) != 2:
    raise SystemExit('Usage: python3 normalize.py /absolute/output/directory (requires rsvg-convert and ImageMagick)')
ROOT = Path(sys.argv[1]).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
SOURCE = Path(__file__).resolve().parent
ORIGINALS = SOURCE / 'originals'
EVIDENCE = SOURCE / 'evidence'
SVG = 'http://www.w3.org/2000/svg'
ANDROID = 'http://schemas.android.com/apk/res/android'
A = '{' + ANDROID + '}'
ET.register_namespace('', SVG)
ET.register_namespace('android', ANDROID)
CLIP = 'M0 0H24V24H0Z M2.40901 5.59099L18.40901 21.59099L21.59099 18.40901L5.59099 2.40901Z'
UPPER_WAVES_CLIP = 'M0 0H24V24Z'
SPECS = [
    dict(family='noun-boatman', role='mic', file='boatman-microphone-171.svg', id='171', title='Microphone', creator='Edward Boatman', creator_url='https://thenounproject.com/creator/edward/', source='https://thenounproject.com/icon/microphone-171/', frame=[0, 0, 60, 100], scale=.2, tx=6, ty=2),
    dict(family='noun-boatman', role='speaker', file='boatman-speaker-100.svg', id='100', title='Speaker', creator='Edward Boatman', creator_url='https://thenounproject.com/creator/edward/', source='https://thenounproject.com/icon/speaker-100/', frame=[0, 0, 93.32, 100], scale=.2, tx=2.668, ty=2),
    dict(family='noun-icons', role='mic', file='icons-microphone-856601.svg', id='856601', title='Microphone', creator='i cons', creator_url='https://thenounproject.com/creator/iconsguru/', source='https://thenounproject.com/icon/microphone-856601/', frame=[0, 0, 512, 512], scale=20/512, tx=2, ty=2),
    dict(family='noun-icons', role='speaker', file='icons-volume-974802.svg', id='974802', title='Volume', creator='i cons', creator_url='https://thenounproject.com/creator/iconsguru/', source='https://thenounproject.com/icon/volume-974802/', frame=[0, 0, 100, 100], scale=.19, tx=2.5, ty=2.5),
]


def number(value):
    return format(value, '.12g')


def tag(node):
    return node.tag.rsplit('}', 1)[-1]


def artwork(node):
    children = []
    for child in node:
        if tag(child) in {'title', 'desc', 'text', 'metadata'}:
            continue
        if tag(child) not in {'g', 'path', 'polygon', 'rect'}:
            raise ValueError(f'Unexpected geometry {tag(child)}')
        children.append(copy.deepcopy(child))
    return children


def rectangle_path(node):
    x = float(node.get('x', '0')); y = float(node.get('y', '0'))
    width = float(node.get('width')); height = float(node.get('height'))
    rx = min(float(node.get('rx', node.get('ry', '0'))), width / 2)
    ry = min(float(node.get('ry', node.get('rx', '0'))), height / 2)
    if not rx or not ry:
        return f'M{number(x)} {number(y)}h{number(width)}v{number(height)}h{number(-width)}Z'
    return ' '.join([
        f'M{number(x+rx)} {number(y)}H{number(x+width-rx)}',
        f'A{number(rx)} {number(ry)} 0 0 1 {number(x+width)} {number(y+ry)}',
        f'V{number(y+height-ry)}A{number(rx)} {number(ry)} 0 0 1 {number(x+width-rx)} {number(y+height)}',
        f'H{number(x+rx)}A{number(rx)} {number(ry)} 0 0 1 {number(x)} {number(y+height-ry)}',
        f'V{number(y+ry)}A{number(rx)} {number(ry)} 0 0 1 {number(x+rx)} {number(y)}Z',
    ])


def geometry_path(node):
    if tag(node) == 'path':
        return node.get('d')
    if tag(node) == 'polygon':
        points = re.findall(r'[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?', node.get('points'))
        assert len(points) % 2 == 0
        return 'M' + 'L'.join(f'{points[i]} {points[i+1]}' for i in range(0, len(points), 2)) + 'Z'
    if tag(node) == 'rect':
        return rectangle_path(node)
    raise ValueError(tag(node))


def native_geometry(target, node):
    if tag(node) == 'g':
        assert not node.attrib, node.attrib
        for child in node:
            native_geometry(target, child)
    else:
        assert not node.get('transform')
        ET.SubElement(target, 'path', {A+'pathData': geometry_path(node), A+'fillColor': '#FFFFFFFF'})


def svg_asset(spec, nodes, muted):
    ident = spec['family'] + '-' + spec['role'] + ('-muted' if muted else '')
    root = ET.Element('{'+SVG+'}svg', {'viewBox': '0 0 24 24', 'fill': 'currentColor', 'role': 'img', 'aria-labelledby': ident+'-title '+ident+'-credit'})
    ET.SubElement(root, '{'+SVG+'}title', {'id': ident+'-title'}).text = spec['title'] + (' muted' if muted else '')
    ET.SubElement(root, '{'+SVG+'}desc', {'id': ident+'-credit'}).text = f"{spec['title']} by {spec['creator']} from Noun Project. CC BY 3.0, https://creativecommons.org/licenses/by/3.0/. Source: {spec['source']} Normalized, recolorable" + (', with an added mute slash and transparent clearance.' if muted else '.')
    trim_waves = muted and spec['family'] == 'noun-boatman' and spec['role'] == 'speaker'
    if trim_waves:
        root.find('{'+SVG+'}desc').text += ' Isolated lower wave remnants are transparently clipped.'
    target = root
    if muted:
        defs = ET.SubElement(root, '{'+SVG+'}defs')
        clip = ET.SubElement(defs, '{'+SVG+'}clipPath', {'id': ident+'-clearance'})
        ET.SubElement(clip, '{'+SVG+'}path', {'d': CLIP, 'clip-rule': 'nonzero'})
        target = ET.SubElement(root, '{'+SVG+'}g', {'clip-path': f'url(#{ident}-clearance)'})
    body = ET.SubElement(target, '{'+SVG+'}g', {'transform': f"matrix({number(spec['scale'])} 0 0 {number(spec['scale'])} {number(spec['tx'])} {number(spec['ty'])})"})
    if trim_waves:
        assert len(nodes) == 4 and tag(nodes[0]) == 'polygon' and all(tag(node) == 'path' for node in nodes[1:])
        body.append(copy.deepcopy(nodes[0]))
        clip = ET.SubElement(defs, '{'+SVG+'}clipPath', {'id': ident+'-upper-waves'})
        ET.SubElement(clip, '{'+SVG+'}path', {'d':UPPER_WAVES_CLIP, 'clip-rule':'nonzero'})
        waves = ET.SubElement(target, '{'+SVG+'}g', {'clip-path':f'url(#{ident}-upper-waves)'})
        wave_body = ET.SubElement(waves, '{'+SVG+'}g', dict(body.attrib))
        for node in nodes[1:]:
            wave_body.append(copy.deepcopy(node))
    else:
        for node in nodes:
            body.append(copy.deepcopy(node))
    if muted:
        ET.SubElement(root, '{'+SVG+'}path', {'d':'M4 4L20 20', 'fill':'none', 'stroke':'currentColor', 'stroke-width':'2', 'stroke-linecap':'butt'})
    return root


def native_asset(spec, nodes, muted):
    root = ET.Element('vector', {A+'width':'24dp', A+'height':'24dp', A+'viewportWidth':'24', A+'viewportHeight':'24'})
    target = root
    if muted:
        target = ET.SubElement(root, 'group')
        ET.SubElement(target, 'clip-path', {A+'pathData':CLIP, A+'fillType':'nonZero'})
    body = ET.SubElement(target, 'group', {A+'scaleX':number(spec['scale']), A+'scaleY':number(spec['scale']), A+'translateX':number(spec['tx']), A+'translateY':number(spec['ty'])})
    if muted and spec['family'] == 'noun-boatman' and spec['role'] == 'speaker':
        assert len(nodes) == 4 and tag(nodes[0]) == 'polygon' and all(tag(node) == 'path' for node in nodes[1:])
        native_geometry(body, nodes[0])
        waves = ET.SubElement(target, 'group')
        ET.SubElement(waves, 'clip-path', {A+'pathData':UPPER_WAVES_CLIP, A+'fillType':'nonZero'})
        wave_body = ET.SubElement(waves, 'group', dict(body.attrib))
        for node in nodes[1:]:
            native_geometry(wave_body, node)
    else:
        for node in nodes:
            native_geometry(body, node)
    if muted:
        ET.SubElement(root, 'path', {A+'pathData':'M4,4L20,20', A+'fillColor':'@android:color/transparent', A+'strokeColor':'#FFFFFFFF', A+'strokeWidth':'2', A+'strokeLineCap':'butt'})
    return root


def reconstruct_native(native):
    root = ET.Element('{'+SVG+'}svg', {'viewBox':'0 0 24 24', 'fill':'currentColor'})
    sequence = [0]
    def convert(dst, node):
        if node.tag == 'group':
            clip = next((item for item in node if item.tag == 'clip-path'), None)
            if clip is not None:
                ident = 'native-clip-' + str(sequence[0]); sequence[0] += 1
                defs = ET.SubElement(root, '{'+SVG+'}defs')
                path = ET.SubElement(defs, '{'+SVG+'}clipPath', {'id':ident})
                ET.SubElement(path, '{'+SVG+'}path', {'d':clip.get(A+'pathData'), 'clip-rule':'nonzero'})
                dst = ET.SubElement(dst, '{'+SVG+'}g', {'clip-path':f'url(#{ident})'})
            if node.get(A+'scaleX') is not None:
                assert node.get(A+'pivotX') is None and node.get(A+'rotation') is None
                transform = f"matrix({node.get(A+'scaleX')} 0 0 {node.get(A+'scaleY')} {node.get(A+'translateX')} {node.get(A+'translateY')})"
                dst = ET.SubElement(dst, '{'+SVG+'}g', {'transform':transform})
            for child in node:
                if child.tag != 'clip-path':
                    convert(dst, child)
        elif node.tag == 'path':
            attrs = {'d':node.get(A+'pathData')}
            if node.get(A+'strokeColor'):
                attrs.update({'fill':'none', 'stroke':'currentColor', 'stroke-width':node.get(A+'strokeWidth'), 'stroke-linecap':node.get(A+'strokeLineCap','butt')})
            ET.SubElement(dst, '{'+SVG+'}path', attrs)
    for node in native:
        convert(root, node)
    return root


def write_xml(path, root, indent=False):
    if indent:
        ET.indent(root, space='    ')
    path.write_text(ET.tostring(root, encoding='unicode')+'\n')


def render(path, dest, pixels, color):
    subprocess.run(['rsvg-convert','--width',str(pixels),'--height',str(pixels),'--stylesheet','/dev/stdin','-o',str(dest),str(path)], input=f'svg {{ color: {color}; }}', text=True, check=True, capture_output=True)


def compare(first, second):
    result = subprocess.run(['magick','compare','-metric','AE',str(first),str(second),'null:'], text=True, capture_output=True)
    if result.returncode != 0:
        raise ValueError(f'{first.name} vs {second.name}: {result.stderr}')
    return result.stderr.strip()


def generate():
    receipt = []
    for spec in SPECS:
        original = ORIGINALS/spec['file']; original_bytes = original.read_bytes()
        source = ET.fromstring(original_bytes)
        nodes = artwork(source)
        footer = [''.join(node.itertext()) for node in source if tag(node) == 'text']
        evidence = json.loads((EVIDENCE/(original.stem+'-download.json')).read_text())
        digest = hashlib.sha256(original_bytes).hexdigest()
        assert digest == evidence['sha256'] and evidence['downloadOk'] and evidence['httpStatus'] == 200
        variants = []
        for muted in [False, True]:
            stem = spec['family']+'-'+spec['role']+('-muted' if muted else '')
            svg_file = ROOT/(stem+'.svg')
            native_file = ROOT/('preview_'+spec['family'].replace('-','_')+'_'+spec['role']+('_muted' if muted else '')+'.xml')
            preview = svg_asset(spec, nodes, muted); native = native_asset(spec, nodes, muted)
            write_xml(svg_file, preview); write_xml(native_file, native, True)
            reconstructed = ROOT/(stem+'-from-native.svg')
            write_xml(reconstructed, reconstruct_native(native))
            if muted:
                evenodd = copy.deepcopy(preview)
                for clip in evenodd.iter('{'+SVG+'}clipPath'):
                    for node in clip:
                        node.set('clip-rule', 'evenodd')
                evenodd_file = ROOT/(stem+'-evenodd-verification.svg')
                write_xml(evenodd_file, evenodd)
            checks = []
            color = '#90988F' if muted else ('#D4FF72' if spec['role'] == 'mic' else '#BBAAFF')
            for dp in [12, 16, 24, 32, 48]:
                pixels = dp*3
                rendered = ROOT/(stem+f'-{dp}dp.png')
                native_rendered = ROOT/(stem+f'-native-{dp}dp.png')
                render(svg_file, rendered, pixels, color); render(reconstructed, native_rendered, pixels, color)
                check = {'dp':dp, 'pixels':pixels, 'svg_native_difference_pixels':compare(rendered,native_rendered)}
                if muted:
                    evenodd_rendered = ROOT/(stem+f'-evenodd-{dp}dp.png')
                    render(evenodd_file, evenodd_rendered, pixels, color)
                    check['nonzero_evenodd_difference_pixels'] = compare(rendered, evenodd_rendered)
                checks.append(check)
            variants.append({'state':'muted' if muted else 'live', 'svg':str(svg_file), 'native':str(native_file), 'sha256_svg':hashlib.sha256(svg_file.read_bytes()).hexdigest(), 'sha256_native':hashlib.sha256(native_file.read_bytes()).hexdigest(), 'checks':checks})
        receipt.append({**spec, 'original':str(original), 'original_viewBox':source.get('viewBox'), 'original_sha256':digest, 'acquired_at':evidence['responseDate'], 'original_attribution_footer':footer, 'normalized_viewBox':'0 0 24 24', 'transform':f"matrix({number(spec['scale'])} 0 0 {number(spec['scale'])} {number(spec['tx'])} {number(spec['ty'])})", 'variants':variants})
    report = {'revision':2, 'license':'CC BY 3.0', 'license_url':'https://creativecommons.org/licenses/by/3.0/', 'specialist_final_license_receipt':str(SOURCE / 'acquisition.md'), 'modifications':['Removed the separate visual attribution footer from the glyph canvas; preserved exact footer text in this receipt and accessible CREDITS.md, with creator/source/license retained in SVG descriptions.','Resized and positioned original artwork uniformly in a 24-unit square; no source path redrawing or distortion.','Changed inherited paint to currentColor for runtime channel tint.','Converted SVG polygon and rounded rect primitives to equivalent Android path geometry.','Added a common diagonal mute slash with transparent clearance; the original artwork remains beneath it.','Cutout hole winds opposite outer rectangle and works with NonZero, including Compose 1.9.5 which ignores XML clip-path fillType.'], 'optical_balance':'Boatman artwork uses a common 20-unit height and optical center; painted areas are closely balanced. i cons microphone uses a 20-unit square source frame; its speaker is uniformly reduced 5% to a centered 19-unit square source frame because its broad horn has greater painted area. Individual source proportions and all paths remain unchanged.', 'scope':'Scratch assets only. SVG/XML reconstruction comparison verifies normalization geometry, not actual Android native rendering or release adoption.', 'assets':receipt}
    report['revision'] = 3
    report['modifications'].append('Boatman muted speaker only: clipped its three wave paths to the upper-right side of the mute diagonal with a transparent NonZero triangle, removing isolated lower wave fragments. Horn keeps the original shared knockout; source paths, upper arcs, live speaker and all other variants are unchanged.')
    report['generated_at_utc'] = datetime.now(timezone.utc).isoformat()
    report['acquisition_status'] = 'Complete: all four originals acquired through the authorized attribution download route; CC BY 3.0 confirmed by the specialist final receipt.'
    report['native_knockout_samples'] = pixel_samples()
    (ROOT/'normalization-receipt.json').write_text(json.dumps(report,indent=2)+'\n')
    return report


def pixel_samples():
    samples = []
    for family in ['noun-boatman', 'noun-icons']:
        images = {}
        for muted in [False, True]:
            stem = family+'-mic'+('-muted' if muted else '')
            path = ROOT/(stem+'.svg'); png = ROOT/(stem+'-240px-sample.png')
            render(path, png, 240, '#FFFFFF')
            images['muted' if muted else 'live'] = subprocess.run(['magick',str(png),'-depth','8','rgba:-'],check=True,capture_output=True).stdout
        points = []
        for name,(x,y) in [('knockout',(105,82)),('retained',(105,55)),('slash',(105,105))]:
            offset = (y*240+x)*4
            live = list(images['live'][offset:offset+4]); muted = list(images['muted'][offset:offset+4])
            expected = 0 if name == 'knockout' else 255
            assert live[3] == 255 and muted[3] == expected, (family,name,live,muted)
            points.append({'name':name,'pixel_xy':[x,y],'viewBox_pixel_center_xy':[(x+.5)/10,(y+.5)/10],'live_rgba':live,'muted_rgba':muted})
        samples.append({'family':family,'image_pixels':[240,240],'scale_pixels_per_viewBox_unit':10,'tint':'#FFFFFF','points':points})
    return samples


def board():
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="1430" height="1190" viewBox="0 0 1430 1190"><rect width="1430" height="1190" fill="#050607"/><g font-family="IBM Plex Mono,monospace" fill="#F0F2E9"><text x="40" y="48" font-size="27">Noun Project — actual SVG pair comparison</text><text x="40" y="80" font-size="16" fill="#90988F">Preserved source artwork, normalized into 24-unit boxes; large examples at 48 dp / 3 px per dp.</text>']
    for row, (family, label) in enumerate([('noun-boatman','Edward Boatman'),('noun-icons','i cons')]):
        y = 135 + row*360
        out.append(f'<text x="40" y="{y}" font-size="24">{label}</text>')
        for col,(role,muted,caption,color) in enumerate([('mic',False,'HUMAN on','#D4FF72'),('speaker',False,'AGENT on','#BBAAFF'),('mic',True,'HUMAN off','#90988F'),('speaker',True,'AGENT off','#90988F')]):
            x = 40+col*310
            out.append(f'<rect x="{x}" y="{y+28}" width="285" height="258" fill="#101311"/>')
            stem = family+'-'+role+('-muted' if muted else '')
            node = ET.fromstring((ROOT/(stem+'.svg')).read_text())
            node.set('x',str(x+70));node.set('y',str(y+50));node.set('width','144');node.set('height','144');node.set('color',color)
            out.append(ET.tostring(node,encoding='unicode'))
            out.append(f'<text x="{x+20}" y="{y+260}" font-size="18" fill="{color}">{caption}</text>')
    out.append('<text x="40" y="875" font-size="20">Center sizes — 12 / 16 / 24 / 32 dp, with original fine detail preserved</text>')
    for row,(family,label) in enumerate([('noun-boatman','Boatman'),('noun-icons','i cons')]):
        y = 907+row*130
        out.append(f'<text x="40" y="{y+40}" font-size="16" fill="#90988F">{label}</text>')
        x = 172
        for dp in [12,16,24,32]:
            extent=dp*3
            for col,(role,muted) in enumerate([('mic',False),('speaker',False),('mic',True),('speaker',True)]):
                stem=family+'-'+role+('-muted' if muted else '')
                node=ET.fromstring((ROOT/(stem+'.svg')).read_text())
                node.set('x',str(x+col*(extent+7)));node.set('y',str(y));node.set('width',str(extent));node.set('height',str(extent));node.set('color','#90988F')
                out.append(ET.tostring(node,encoding='unicode'))
            x+=4*(extent+7)+30
    out.append('</g></svg>')
    (ROOT/'noun-pairs-comparison.svg').write_text(''.join(out))
    subprocess.run(['rsvg-convert','-o',str(ROOT/'noun-pairs-comparison.png'),str(ROOT/'noun-pairs-comparison.svg')],check=True,capture_output=True)


if __name__ == '__main__':
    result=generate()
    board()
    print(json.dumps([{'family':item['family'],'role':item['role'],'transform':item['transform']} for item in result['assets']],indent=2))
