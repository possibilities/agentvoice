#!/usr/bin/env python3
"""Check the two local phone apps have distinct launchers and isolated capabilities."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[1]
aapt = Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0/aapt2'
receipt = {}
for variant, package, label, activity in (
    ('production', 'com.arthack.agentvoice.dev', 'AgentVoice', 'com.arthack.agentvoice.MainActivity'),
    ('studio', 'com.arthack.agentvoice.studio', 'AgentVoice Studio', 'com.arthack.agentvoice.PersonaPreviewActivity'),
):
    apk = root / f'app/build/outputs/apk/{variant}/app-{variant}.apk'
    badging = subprocess.check_output([str(aapt), 'dump', 'badging', str(apk)], text=True)
    assert f"package: name='{package}'" in badging
    assert f"application-label:'{label}'" in badging
    assert re.findall(r"launchable-activity: name='([^']+)'", badging) == [activity]
    manifest = subprocess.check_output([str(aapt), 'dump', 'xmltree', str(apk), '--file', 'AndroidManifest.xml'], text=True)
    if variant == 'studio':
        for permission in ('INTERNET', 'ACCESS_NETWORK_STATE', 'RECORD_AUDIO', 'BLUETOOTH_CONNECT'):
            assert f'android.permission.{permission}' not in manifest, permission
        assert 'com.arthack.agentvoice.MainActivity' not in manifest
    else:
        assert 'PersonaPreviewActivity' not in manifest
        assert 'android.permission.RECORD_AUDIO' in manifest
    receipt[variant] = {'package': package, 'launcher': activity, 'label': label,
        'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'bytes': apk.stat().st_size}
print(json.dumps(receipt, indent=2))
