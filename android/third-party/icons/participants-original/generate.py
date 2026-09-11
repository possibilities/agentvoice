#!/usr/bin/env python3
"""Generate browser previews and debug VectorDrawables from original participant SVGs."""

from pathlib import Path
import shutil
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PREVIEWS = ROOT / "android/configurator/public/icon-previews"
DRAWABLES = ROOT / "android/app/src/debug/res/drawable"
SVG = "{http://www.w3.org/2000/svg}"
ANDROID = "http://schemas.android.com/apk/res/android"
ET.register_namespace("android", ANDROID)

FILES = {
    "participant-profile-mic.svg": "preview_participant_profile_mic.xml",
    "participant-profile-mic-muted.svg": "preview_participant_profile_mic_muted.xml",
    "participant-profile-speaker.svg": "preview_participant_profile_speaker.xml",
    "participant-profile-speaker-muted.svg": "preview_participant_profile_speaker_muted.xml",
}


def android_attr(name: str) -> str:
    return f"{{{ANDROID}}}{name}"


def vector_from_svg(source: Path) -> ET.Element:
    svg = ET.parse(source).getroot()
    if svg.get("viewBox") != "0 0 24 24":
        raise ValueError(f"unexpected viewBox in {source}")
    vector = ET.Element(
        "vector",
        {
            android_attr("width"): "24dp",
            android_attr("height"): "24dp",
            android_attr("viewportWidth"): "24",
            android_attr("viewportHeight"): "24",
        },
    )
    for source_path in svg.findall(f"{SVG}path"):
        path = {android_attr("pathData"): source_path.attrib["d"]}
        if source_path.get("fill") == "currentColor":
            path[android_attr("fillColor")] = "#FFFFFFFF"
        else:
            path[android_attr("fillColor")] = "@android:color/transparent"
        if source_path.get("stroke") == "currentColor":
            path[android_attr("strokeColor")] = "#FFFFFFFF"
            path[android_attr("strokeWidth")] = source_path.attrib["stroke-width"]
            path[android_attr("strokeLineCap")] = source_path.get("stroke-linecap", "butt")
            path[android_attr("strokeLineJoin")] = source_path.get("stroke-linejoin", "miter")
        ET.SubElement(vector, "path", path)
    return vector


def indent(element: ET.Element, depth: int = 0) -> None:
    prefix = "\n" + "    " * depth
    if len(element):
        element.text = prefix + "    "
        for child in element:
            indent(child, depth + 1)
        element[-1].tail = prefix
    element.tail = prefix


for svg_name, drawable_name in FILES.items():
    source = HERE / svg_name
    shutil.copyfile(source, PREVIEWS / svg_name)
    vector = vector_from_svg(source)
    indent(vector)
    ET.ElementTree(vector).write(
        DRAWABLES / drawable_name,
        encoding="unicode",
        xml_declaration=False,
        short_empty_elements=True,
    )
    with (DRAWABLES / drawable_name).open("a", encoding="utf-8") as output:
        output.write("\n")
