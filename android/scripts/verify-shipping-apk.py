#!/usr/bin/env python3
"""Audit the release artifact against the deliberately selected design assets."""
import hashlib
import json
import subprocess
import os
import re
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
apk = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'app/build/outputs/apk/release/app-release-unsigned.apk'
selected = json.loads((root / 'design/shipping-profile.json').read_text())
family = selected['sounds']['family']
expected_audio = set() if family == 'off' else {f'assets/switch-sounds/{family}-{cue}.wav' for cue in ('toggle-on', 'toggle-off', 'ptt-down', 'ptt-up')}
with zipfile.ZipFile(apk) as bundle:
    names = set(bundle.namelist())
    actual_audio = {name for name in names if name.endswith('.wav')}
    assert actual_audio == expected_audio, (actual_audio, expected_audio)
    for name in expected_audio:
        original = root / 'app/src/debug' / name
        assert bundle.read(name) == original.read_bytes(), name
    assert not any('configurator' in name or 'shipping-profile' in name or 'persona-tuning.json' in name for name in names)
    for filename in ('Shipping-Icons-NOTICE.txt', 'Shipping-Icons-LICENSE.txt', 'Shipping-Sounds-NOTICE.txt', 'Shipping-Sounds-LICENSE.txt', 'Persona-Halo-NOTICE.txt'):
        source = root / 'app/src/main/assets/notices' / filename
        if source.exists():
            assert bundle.read('assets/notices/' + filename) == source.read_bytes(), filename
    dex = b''.join(bundle.read(name) for name in names if name.endswith('.dex'))
    for symbol in (b'PersonaPreviewActivity', b'PersonaPreviewBridge', b'PersonaPreviewSession', b'DesignPreviewActivity'):
        assert symbol not in dex, symbol
    sdk = Path(os.environ['ANDROID_HOME'])
    aapt = sdk / 'build-tools/36.0.0/aapt2'
    resources = subprocess.check_output([str(aapt), 'dump', 'resources', str(apk)], text=True)
    assert not re.search(r'drawable/preview_(engraved|phosphor|noun)', resources), 'audition icon resources leaked'
    shipped = set(re.findall(r'drawable/(shipping_channel_[a-z_]+)', resources))
    expected_icons = {p.stem for p in (root / 'app/src/release/res/drawable').glob('shipping_channel_*.xml')}
    assert shipped == expected_icons, (shipped, expected_icons)
    print(json.dumps({'apk': str(apk), 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
        'bytes': apk.stat().st_size, 'sound_files': sorted(actual_audio), 'studio_entrypoints': 'absent',
        'profile_json': 'absent', 'packaged_notices': 'byte-exact'}, indent=2))
