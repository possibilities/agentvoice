#!/usr/bin/env python3
"""Generate the Studio participant icon audition from preserved Phosphor SVGs."""

from pathlib import Path
import copy
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parents[3]
PREVIEWS = ROOT / "android/configurator/public/icon-previews"
NATIVE = ROOT / "android/app/src/debug/res/drawable"
ORIGINALS = SOURCE / "originals"
SVG = "http://www.w3.org/2000/svg"
ANDROID = "http://schemas.android.com/apk/res/android"
A = "{" + ANDROID + "}"
ET.register_namespace("", SVG)
ET.register_namespace("android", ANDROID)

# The 24-unit common knockout from the existing Engraved/Noun generators,
# multiplied by 256/24. Its inner contour winds opposite the outer canvas.
CLEARANCE = (
    "M0 0H256V256H0Z "
    "M25.6961066667 59.6372266667L196.362773333 230.303893333"
    "L230.303893333 196.362773333L59.6372266667 25.6961066667Z"
)
SLASH = "M42.6666666667,42.6666666667L213.333333333,213.333333333"
SLASH_WIDTH = "21.3333333333"
# User shoulders reach just beyond the common slash's butt-ended lower terminus.
# Keep only the canvas side at x+y <= 426.666..., suppressing that isolated tip.
USER_TIP_CLIP = "M0 0H256V170.666666667L170.666666667 256H0Z"

SPECS = (
    {"weight": "bold", "role": "mic", "participant": "user", "source": "user-bold.svg", "scale": 1.0},
    {"weight": "bold", "role": "speaker", "participant": "robot", "source": "robot-bold.svg", "scale": 0.95},
    {"weight": "fill", "role": "mic", "participant": "user", "source": "user-fill.svg", "scale": 1.0},
    {"weight": "fill", "role": "speaker", "participant": "robot", "source": "robot-fill.svg", "scale": 0.95},
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_xml(path: Path, root: ET.Element, indent: bool = False) -> None:
    if indent:
        ET.indent(root, space="    ")
    path.write_text(ET.tostring(root, encoding="unicode") + "\n")


def source_path(spec: dict) -> str:
    source = ET.fromstring((ORIGINALS / spec["source"]).read_bytes())
    assert source.get("viewBox") == "0 0 256 256"
    children = list(source)
    assert len(children) == 1 and children[0].tag == "{" + SVG + "}path"
    assert set(children[0].attrib) == {"d"}
    return children[0].get("d")


def transform(spec: dict) -> str | None:
    if spec["scale"] == 1:
        return None
    offset = 128 * (1 - spec["scale"])
    return f"matrix({spec['scale']:.2f} 0 0 {spec['scale']:.2f} {offset:.1f} {offset:.1f})"


def svg_asset(spec: dict, path_data: str, muted: bool) -> ET.Element:
    stem = f"participant-{spec['weight']}-{spec['role']}" + ("-muted" if muted else "")
    label = f"{spec['participant'].title()} participant" + (" muted" if muted else "")
    root = ET.Element(
        "{" + SVG + "}svg",
        {"viewBox": "0 0 256 256", "fill": "currentColor", "role": "img", "aria-labelledby": stem + "-title"},
    )
    ET.SubElement(root, "{" + SVG + "}title", {"id": stem + "-title"}).text = label
    target = root
    if muted:
        defs = ET.SubElement(root, "{" + SVG + "}defs")
        clip = ET.SubElement(defs, "{" + SVG + "}clipPath", {"id": stem + "-clearance"})
        ET.SubElement(clip, "{" + SVG + "}path", {"d": CLEARANCE, "clip-rule": "nonzero"})
        target = ET.SubElement(root, "{" + SVG + "}g", {"clip-path": f"url(#{stem}-clearance)"})
        if spec["participant"] == "user":
            tip_clip = ET.SubElement(defs, "{" + SVG + "}clipPath", {"id": stem + "-shoulder-tip"})
            ET.SubElement(tip_clip, "{" + SVG + "}path", {"d": USER_TIP_CLIP})
            target = ET.SubElement(target, "{" + SVG + "}g", {"clip-path": f"url(#{stem}-shoulder-tip)"})
    artwork = target
    matrix = transform(spec)
    if matrix:
        artwork = ET.SubElement(target, "{" + SVG + "}g", {"transform": matrix})
    ET.SubElement(artwork, "{" + SVG + "}path", {"d": path_data})
    if muted:
        ET.SubElement(
            root,
            "{" + SVG + "}path",
            {"d": SLASH.replace(",", " "), "fill": "none", "stroke": "currentColor", "stroke-width": SLASH_WIDTH, "stroke-linecap": "butt"},
        )
    return root


def native_asset(spec: dict, path_data: str, muted: bool) -> ET.Element:
    root = ET.Element(
        "vector",
        {A + "width": "64dp", A + "height": "64dp", A + "viewportWidth": "256", A + "viewportHeight": "256"},
    )
    target = root
    if muted:
        target = ET.SubElement(root, "group")
        ET.SubElement(target, "clip-path", {A + "pathData": CLEARANCE, A + "fillType": "nonZero"})
        if spec["participant"] == "user":
            target = ET.SubElement(target, "group")
            ET.SubElement(target, "clip-path", {A + "pathData": USER_TIP_CLIP, A + "fillType": "nonZero"})
    artwork = target
    if spec["scale"] != 1:
        offset = 128 * (1 - spec["scale"])
        artwork = ET.SubElement(
            target,
            "group",
            {A + "scaleX": f"{spec['scale']:.2f}", A + "scaleY": f"{spec['scale']:.2f}", A + "translateX": f"{offset:.1f}", A + "translateY": f"{offset:.1f}"},
        )
    ET.SubElement(artwork, "path", {A + "fillColor": "#FFFFFFFF", A + "pathData": path_data})
    if muted:
        ET.SubElement(
            root,
            "path",
            {A + "pathData": SLASH, A + "fillColor": "@android:color/transparent", A + "strokeColor": "#FFFFFFFF", A + "strokeWidth": SLASH_WIDTH, A + "strokeLineCap": "butt"},
        )
    return root


def native_as_svg(native: ET.Element) -> ET.Element:
    root = ET.Element("{" + SVG + "}svg", {"viewBox": "0 0 256 256", "fill": "currentColor"})
    sequence = [0]

    def convert(parent: ET.Element, node: ET.Element) -> None:
        if node.tag == "group":
            clip = next((child for child in node if child.tag == "clip-path"), None)
            if clip is not None:
                ident = f"native-clip-{sequence[0]}"
                sequence[0] += 1
                defs = ET.SubElement(root, "{" + SVG + "}defs")
                clip_node = ET.SubElement(defs, "{" + SVG + "}clipPath", {"id": ident})
                ET.SubElement(clip_node, "{" + SVG + "}path", {"d": clip.get(A + "pathData"), "clip-rule": "nonzero"})
                parent = ET.SubElement(parent, "{" + SVG + "}g", {"clip-path": f"url(#{ident})"})
            if node.get(A + "scaleX"):
                parent = ET.SubElement(
                    parent,
                    "{" + SVG + "}g",
                    {"transform": f"matrix({node.get(A+'scaleX')} 0 0 {node.get(A+'scaleY')} {node.get(A+'translateX')} {node.get(A+'translateY')})"},
                )
            for child in node:
                if child.tag != "clip-path":
                    convert(parent, child)
        elif node.tag == "path":
            attrs = {"d": node.get(A + "pathData")}
            if node.get(A + "strokeColor"):
                attrs.update({"fill": "none", "stroke": "currentColor", "stroke-width": node.get(A + "strokeWidth"), "stroke-linecap": node.get(A + "strokeLineCap")})
            ET.SubElement(parent, "{" + SVG + "}path", attrs)

    for child in native:
        convert(root, child)
    return root


def render(svg: Path, output: Path, pixels: int) -> None:
    subprocess.run(
        ["rsvg-convert", "--width", str(pixels), "--height", str(pixels), "--stylesheet", "/dev/stdin", "-o", str(output), str(svg)],
        input="svg { color: #ffffff; }",
        text=True,
        check=True,
        capture_output=True,
    )


def compare(first: Path, second: Path) -> int:
    result = subprocess.run(["magick", "compare", "-metric", "AE", str(first), str(second), "null:"], text=True, capture_output=True)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr)
    return int(result.stderr.split()[0])


def fragment_check(path: Path) -> dict:
    result = subprocess.run(
        ["magick", str(path), "-alpha", "extract", "-threshold", "1%", "-define", "connected-components:verbose=true", "-connected-components", "8", "null:"],
        text=True,
        capture_output=True,
        check=True,
    )
    output = result.stdout + result.stderr
    areas = [
        int(match.group(1))
        for line in output.splitlines()
        if "srgb(255,255,255)" in line
        if (match := re.search(r"\s(\d+)\s+srgb\(255,255,255\)", line))
    ]
    assert areas, f"No painted pixels found in {path}"
    return {"painted_components": len(areas), "smallest_component_pixels": min(areas)}


def comparison(rows: list[list[Path]], output: Path) -> None:
    rendered_rows = []
    for row_number, row in enumerate(rows):
        cells = []
        for column, icon in enumerate(row):
            cell = output.parent / f".participant-comparison-{row_number}-{column}.png"
            subprocess.run(
                ["magick", "-size", "96x96", "xc:#101311", icon, "-gravity", "center", "-composite", str(cell)],
                check=True,
                capture_output=True,
            )
            cells.append(cell)
        assembled = output.parent / f".participant-comparison-row-{row_number}.png"
        subprocess.run(["magick", *map(str, cells), "+append", str(assembled)], check=True, capture_output=True)
        rendered_rows.append(assembled)
    subprocess.run(
        ["magick", *map(str, rendered_rows), "-append", "-strip", "-define", "png:exclude-chunk=date,time", str(output)],
        check=True,
        capture_output=True,
    )
    for path in [*sum(rows, []), *rendered_rows, *output.parent.glob(".participant-comparison-*-*.png")]:
        path.unlink(missing_ok=True)


def generate() -> dict:
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    NATIVE.mkdir(parents=True, exist_ok=True)
    assets = []
    comparison_rows = []
    with tempfile.TemporaryDirectory(prefix="participant-icons-") as directory:
        scratch = Path(directory)
        for spec in SPECS:
            path_data = source_path(spec)
            variants = []
            for muted in (False, True):
                suffix = "-muted" if muted else ""
                stem = f"participant-{spec['weight']}-{spec['role']}{suffix}"
                svg_file = PREVIEWS / f"{stem}.svg"
                native_file = NATIVE / f"preview_{stem.replace('-', '_')}.xml"
                svg = svg_asset(spec, path_data, muted)
                native = native_asset(spec, path_data, muted)
                write_xml(svg_file, svg)
                write_xml(native_file, native, True)
                reconstructed = scratch / f"{stem}-native.svg"
                write_xml(reconstructed, native_as_svg(native))
                checks = []
                for pixels in (96, 24, 16):
                    browser_png = scratch / f"{stem}-{pixels}.png"
                    native_png = scratch / f"{stem}-native-{pixels}.png"
                    render(svg_file, browser_png, pixels)
                    render(reconstructed, native_png, pixels)
                    difference = compare(browser_png, native_png)
                    if difference != 0:
                        raise AssertionError(f"{stem} differs from reconstructed native geometry at {pixels}px: {difference} pixels")
                    checks.append({"pixels": pixels, "svg_native_difference_pixels": difference, **fragment_check(browser_png)})
                    while len(comparison_rows) < 3:
                        comparison_rows.append([])
                    comparison_rows[(96, 24, 16).index(pixels)].append(browser_png)
                variants.append({"state": "muted" if muted else "live", "svg": str(svg_file.relative_to(ROOT)), "vector": str(native_file.relative_to(ROOT)), "svg_sha256": sha256(svg_file), "vector_sha256": sha256(native_file), "checks": checks})
            assets.append({**spec, "source_sha256": sha256(ORIGINALS / spec["source"]), "transform": transform(spec) or "identity", "variants": variants})
        comparison(comparison_rows, SOURCE / "comparison.png")
    receipt = {
        "revision": 1,
        "source": "https://github.com/phosphor-icons/core",
        "commit": "2b75f3ad12b420c9504ef05df8d2564a28f8500e",
        "license": "MIT",
        "mapping": {"mic": "user participant", "speaker": "robot participant"},
        "canvas": "0 0 256 256; Android intrinsic size 64dp, matching the existing Phosphor Studio audition",
        "adaptations": [
            "Preserved every upstream path byte-for-byte in originals/ and copied its path data without redrawing.",
            "Centered Robot uniformly at 95% optical scale; User remains at upstream scale.",
            "Added a common diagonal mute slash with a true-transparent opposite-winding knockout; no background-color paint is used.",
            "Muted User only: transparently clipped the shoulder tip beyond the common slash's lower butt terminus (x+y > 426.666...); upstream originals, live User, and all Robot geometry remain unchanged.",
            "Added browser accessibility metadata and converted the same geometry to debug-only Android VectorDrawable XML.",
        ],
        "validation": "Generator reconstructed every VectorDrawable as SVG and obtained zero differing pixels at 96, 24, and 16 px; painted connected-component counts and smallest-component areas record small-size fragment behavior.",
        "comparison": {"file": "comparison.png", "sha256": sha256(SOURCE / "comparison.png"), "rows_pixels": [96, 24, 16], "columns": ["bold user live", "bold user muted", "bold robot live", "bold robot muted", "fill user live", "fill user muted", "fill robot live", "fill robot muted"]},
        "assets": assets,
    }
    (SOURCE / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    if len(sys.argv) != 1:
        raise SystemExit("Usage: python3 android/third-party/icons/phosphor-participants/generate.py")
    print(json.dumps(generate()["assets"], indent=2))
