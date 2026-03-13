"""Parse Audiveris .omr files to extract measure/staff bounding boxes and note positions for precise PDF overlay.

The .omr file is a zip containing:
  - book.xml
  - sheet#N/BINARY.png, sheet#N.xml

sheet#N.xml structure (from Audiveris Sheet.xsd):
  - sheet/picture: width, height (image dimensions in pixels)
  - sheet/page/system: systems on the page
  - system/stack (measure stacks): left, right (x coords), id (measure id)
  - system/part/staff: left, right; lines/line/point (x, y)
  - measure/head-chords: IDREFs to head-chord elements (have bounds)
  - measure/rest-chords: IDREFs to rest-chord elements (have bounds)

Coordinates are in pixels relative to the sheet image (BINARY.png).
We convert to 0-1 ratios for compatibility with the frontend overlay.
"""

import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _local_tag(tag: str) -> str:
    """Strip namespace from tag (e.g. '{http://...}stack' -> 'stack')."""
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def _iter_children(parent: ET.Element, local_name: str) -> List[ET.Element]:
    """Find direct or nested children with given local tag name."""
    out = []
    for el in parent.iter():
        if _local_tag(el.tag) == local_name:
            out.append(el)
    return out


def _get_int(el: Optional[ET.Element], attr: str, default: int = 0) -> int:
    if el is None:
        return default
    s = el.get(attr, "")
    if not s:
        return default
    try:
        return int(float(s))
    except ValueError:
        return default


def _get_float(el: Optional[ET.Element], attr: str, default: float = 0.0) -> float:
    if el is None:
        return default
    s = el.get(attr, "")
    if not s:
        return default
    try:
        return float(s)
    except ValueError:
        return default


def _parse_sheet_xml(xml_content: bytes, img_width: int, img_height: int) -> List[Dict[str, Any]]:
    """Parse sheet#N.xml and return measure layout positions as 0-1 ratios.

    Each measure gets: { "page": 0, "top": 0-1, "left": 0-1, "bottom": 0-1, "right": 0-1 }
    """
    if img_width <= 0 or img_height <= 0:
        return []

    root = ET.fromstring(xml_content)
    result: List[Dict[str, Any]] = []

    # sheet -> page -> system (Audiveris structure)
    pages = [root] if _local_tag(root.tag) == "page" else _iter_children(root, "page")
    if not pages and _local_tag(root.tag) == "sheet":
        pages = _iter_children(root, "page")
    if not pages:
        pages = [root]

    for page_el in pages:
        systems = _iter_children(page_el, "system")
        if not systems:
            systems = _iter_children(root, "system")

        for sys_el in systems:
            stacks = [c for c in sys_el if _local_tag(c.tag) == "stack"]
            if not stacks:
                continue

            # Vertical extent from parts -> staff -> lines -> line -> point
            sys_top = float("inf")
            sys_bottom = float("-inf")
            parts = [c for c in sys_el if _local_tag(c.tag) == "part"]
            for part_el in parts:
                staves = [el for el in part_el.iter() if _local_tag(el.tag) in ("staff", "one-line-staff")]
                for staff_el in staves:
                    lines_el = staff_el.find("lines")
                    if lines_el is None:
                        for c in staff_el:
                            if _local_tag(c.tag) == "lines":
                                lines_el = c
                                break
                    if lines_el is not None:
                        for line_el in lines_el:
                            if _local_tag(line_el.tag) != "line":
                                continue
                            for pt in line_el:
                                if _local_tag(pt.tag) != "point":
                                    continue
                                py = _get_float(pt, "y", 0)
                                sys_top = min(sys_top, py)
                                sys_bottom = max(sys_bottom, py)

            if sys_top == float("inf"):
                sys_top = 0
            if sys_bottom == float("-inf"):
                sys_bottom = img_height

            for stack_el in sorted(stacks, key=lambda s: _get_int(s, "left", 0)):
                left = _get_int(stack_el, "left", 0)
                right = _get_int(stack_el, "right", 0)
                if right <= left:
                    continue
                top_r = max(0, min(1, sys_top / img_height))
                bottom_r = max(0, min(1, sys_bottom / img_height))
                left_r = max(0, min(1, left / img_width))
                right_r = max(0, min(1, right / img_width))
                result.append({
                    "page": 0,
                    "top": round(top_r, 4),
                    "left": round(left_r, 4),
                    "bottom": round(bottom_r, 4),
                    "right": round(right_r, 4),
                })

    return result


def parse_omr_layout(omr_path: Path) -> List[Dict[str, Any]]:
    """
    Parse an Audiveris .omr file and extract measure bounding boxes as 0-1 ratios.

    Returns a list of dicts: { "page": int, "top": float, "left": float, "bottom": float, "right": float }
    One entry per measure, in score order. Page is 0-based (sheet index).
    """
    if not omr_path.exists() or omr_path.suffix.lower() != ".omr":
        return []

    try:
        all_measures: List[Dict[str, Any]] = []
        with zipfile.ZipFile(omr_path, "r") as zf:
            # Find sheet#N.xml files
            sheet_files = sorted([n for n in zf.namelist() if "sheet" in n and n.endswith(".xml")])
            if not sheet_files:
                return []

            for sheet_idx, sheet_name in enumerate(sheet_files):
                # Get image dimensions from BINARY.png in same folder or from picture in sheet
                folder = sheet_name.rsplit("/", 1)[0] + "/"
                img_width, img_height = 0, 0

                # Try to get dimensions from BINARY.png
                binary_name = folder + "BINARY.png"
                if binary_name in zf.namelist():
                    try:
                        from PIL import Image
                        import io
                        with zf.open(binary_name) as f:
                            img = Image.open(io.BytesIO(f.read()))
                            img_width, img_height = img.size
                    except Exception:
                        pass

                xml_bytes = zf.read(sheet_name)
                root = ET.fromstring(xml_bytes)

                # Get picture dimensions from XML if we don't have them
                if img_width <= 0 or img_height <= 0:
                    for el in root.iter():
                        if _local_tag(el.tag) == "picture":
                            img_width = _get_int(el, "width", 0)
                            img_height = _get_int(el, "height", 0)
                            break

                if img_width <= 0 or img_height <= 0:
                    continue

                sheet_measures = _parse_sheet_xml(xml_bytes, img_width, img_height)
                for m in sheet_measures:
                    m["page"] = sheet_idx
                    all_measures.append(m)

        return all_measures
    except Exception:
        return []


def _get_bounds(el: ET.Element, img_width: int, img_height: int) -> Optional[Tuple[float, float, float, float]]:
    """Extract bounds (left, top, right, bottom) as 0-1 ratios from element. Returns None if no bounds."""
    bounds = None
    for child in el:
        if _local_tag(child.tag) == "bounds":
            bounds = child
            break
    if bounds is None:
        return None
    x = _get_int(bounds, "x", 0)
    y = _get_int(bounds, "y", 0)
    w = _get_int(bounds, "w", 0) or _get_int(bounds, "width", 0)
    h = _get_int(bounds, "h", 0) or _get_int(bounds, "height", 0)
    if w <= 0 or h <= 0 or img_width <= 0 or img_height <= 0:
        return None
    left = max(0, min(1, x / img_width))
    top = max(0, min(1, y / img_height))
    right = max(0, min(1, (x + w) / img_width))
    bottom = max(0, min(1, (y + h) / img_height))
    return (round(left, 4), round(top, 4), round(right, 4), round(bottom, 4))


def _parse_sig_relations(root: ET.Element) -> Tuple[Dict[str, List[str]], Dict[str, str]]:
    """Parse containment and chord-stem relations from sig. Returns (chord_to_heads, chord_to_stem)."""
    chord_to_heads: Dict[str, List[str]] = {}
    chord_to_stem: Dict[str, str] = {}
    for sig_el in root.iter():
        if _local_tag(sig_el.tag) != "sig":
            continue
        relations_el = None
        for c in sig_el:
            if _local_tag(c.tag) == "relations":
                relations_el = c
                break
        if relations_el is None:
            continue
        for rel in relations_el:
            rtag = _local_tag(rel.tag)
            src = rel.get("source")
            tgt = rel.get("target")
            if src is None or tgt is None:
                continue
            src_s = str(src)
            tgt_s = str(tgt)
            # If wrapped in <relation>, check first child for type
            if rtag == "relation":
                for sub in rel:
                    stag = _local_tag(sub.tag)
                    if stag == "containment":
                        chord_to_heads.setdefault(src_s, []).append(tgt_s)
                        break
                    if stag == "chord-stem":
                        chord_to_stem[src_s] = tgt_s
                        break
            # containment: source=container (head-chord), target=member (head)
            elif rtag == "containment":
                chord_to_heads.setdefault(src_s, []).append(tgt_s)
            # chord-stem: source=chord, target=stem (Audiveris convention)
            elif rtag == "chord-stem":
                chord_to_stem[src_s] = tgt_s
    return chord_to_heads, chord_to_stem


def parse_omr_note_positions(omr_path: Path) -> List[List[Dict[str, Any]]]:
    """
    Parse an Audiveris .omr file and extract note/chord bounding boxes per measure.

    Returns a list of lists: for each measure, a list of note shapes.
    Each note is {head: {left,top,right,bottom}?, stem: {left,top,right,bottom}?} for precise
    single-note highlighting, or {left, top, right, bottom} for backward compatibility.
    Notes are in order: head-chords then rest-chords, as they appear in the measure.
    """
    if not omr_path.exists() or omr_path.suffix.lower() != ".omr":
        return []

    try:
        all_measure_notes: List[List[Dict[str, Any]]] = []
        with zipfile.ZipFile(omr_path, "r") as zf:
            sheet_files = sorted([n for n in zf.namelist() if "sheet" in n and n.endswith(".xml")])
            if not sheet_files:
                return []

            for sheet_idx, sheet_name in enumerate(sheet_files):
                folder = sheet_name.rsplit("/", 1)[0] + "/"
                img_width, img_height = 0, 0
                binary_name = folder + "BINARY.png"
                if binary_name in zf.namelist():
                    try:
                        from PIL import Image
                        import io
                        with zf.open(binary_name) as f:
                            img = Image.open(io.BytesIO(f.read()))
                            img_width, img_height = img.size
                    except Exception:
                        pass

                xml_bytes = zf.read(sheet_name)
                root = ET.fromstring(xml_bytes)

                if img_width <= 0 or img_height <= 0:
                    for el in root.iter():
                        if _local_tag(el.tag) == "picture":
                            img_width = _get_int(el, "width", 0)
                            img_height = _get_int(el, "height", 0)
                            break

                if img_width <= 0 or img_height <= 0:
                    continue

                id_to_bounds: Dict[str, Tuple[float, float, float, float]] = {}
                for el in root.iter():
                    eid = el.get("id")
                    if eid:
                        b = _get_bounds(el, img_width, img_height)
                        if b:
                            id_to_bounds[eid] = b

                chord_to_heads, chord_to_stem = _parse_sig_relations(root)

                pages = [root] if _local_tag(root.tag) == "page" else _iter_children(root, "page")
                if not pages and _local_tag(root.tag) == "sheet":
                    pages = _iter_children(root, "page")
                if not pages:
                    pages = [root]

                for page_el in pages:
                    systems = _iter_children(page_el, "system")
                    if not systems:
                        systems = _iter_children(root, "system")

                    for sys_el in systems:
                        parts = [c for c in sys_el if _local_tag(c.tag) == "part"]
                        if not parts:
                            continue
                        num_measures = len([c for c in parts[0] if _local_tag(c.tag) == "measure"])
                        for mi in range(num_measures):
                            note_rects: List[Dict[str, Any]] = []
                            for part_el in parts:
                                measures = [c for c in part_el if _local_tag(c.tag) == "measure"]
                                if mi >= len(measures):
                                    continue
                                measure_el = measures[mi]
                                for list_name in ("head-chords", "rest-chords"):
                                    list_el = measure_el.find(list_name)
                                    if list_el is None:
                                        for c in measure_el:
                                            if _local_tag(c.tag) == list_name:
                                                list_el = c
                                                break
                                    if list_el is not None:
                                        refs = (list_el.text or "").strip()
                                        for ref in refs.split():
                                            ref = ref.strip()
                                            if not ref or ref not in id_to_bounds:
                                                continue
                                            lb, tb, rb, bb = id_to_bounds[ref]
                                            if list_name == "rest-chords":
                                                note_rects.append({"rest": True, "left": lb, "top": tb, "right": rb, "bottom": bb})
                                                continue
                                            heads = chord_to_heads.get(ref, [])
                                            stem_id = chord_to_stem.get(ref)
                                            head_bounds_list: List[Tuple[float, float, float, float]] = []
                                            for hid in heads:
                                                if hid in id_to_bounds:
                                                    head_bounds_list.append(id_to_bounds[hid])
                                            head_bounds_list.sort(key=lambda b: (b[1], b[0]))
                                            stem_bounds = id_to_bounds[stem_id] if stem_id and stem_id in id_to_bounds else None
                                            if head_bounds_list or stem_bounds:
                                                entry: Dict[str, Any] = {}
                                                if head_bounds_list:
                                                    entry["heads"] = [{"left": b[0], "top": b[1], "right": b[2], "bottom": b[3]} for b in head_bounds_list]
                                                if stem_bounds:
                                                    entry["stem"] = {"left": stem_bounds[0], "top": stem_bounds[1], "right": stem_bounds[2], "bottom": stem_bounds[3]}
                                                note_rects.append(entry)
                                            else:
                                                note_rects.append({"left": lb, "top": tb, "right": rb, "bottom": bb})
                            all_measure_notes.append(note_rects)

        return all_measure_notes
    except Exception:
        return []
