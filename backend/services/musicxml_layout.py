"""Parse MusicXML to extract layout information (e.g. measures per system)."""

from pathlib import Path
from typing import Optional

import collections


def get_measures_per_first_system(musicxml_path: Path) -> Optional[int]:
    """
    Parse MusicXML and return the number of measures on the first system.

    Uses music21's layout module. Returns None if layout cannot be determined.
    """
    result = _get_system_measure_counts(musicxml_path)
    if not result:
        return None
    return result[0]  # first system


def get_measures_per_system_for_layout(musicxml_path: Path) -> Optional[int]:
    """
    Return the typical measures-per-line for layout matching the original sheet.

    Prefers the most common system size (e.g. 4) over the first system which may
    have 1 measure (pickup/anacrusis). Use this for proportional Verovio layout.
    """
    counts = _get_all_system_measure_counts(musicxml_path)
    if not counts:
        return None
    # Use most common count (typical system), but ignore single-measure systems
    # which are often pickups
    filtered = [c for c in counts if c > 1 and c <= 12]
    if filtered:
        most_common = collections.Counter(filtered).most_common(1)[0][0]
        return most_common
    # Fallback: first system or first count > 1
    for c in counts:
        if 1 < c <= 12:
            return c
    return counts[0] if counts[0] <= 12 else None


def _get_system_measure_counts(musicxml_path: Path) -> Optional[list]:
    """Return list of measure counts per system, or None."""
    path = Path(musicxml_path)
    if not path.exists():
        return None

    try:
        from music21 import converter, layout

        score = converter.parse(str(path))
        if not score.parts:
            return None

        system_regions = layout.getSystemRegionMeasureNumbers(score)
        if not system_regions:
            return None

        return [end - start + 1 for start, end in system_regions]
    except Exception:
        return None


def _get_all_system_measure_counts(musicxml_path: Path) -> list:
    """Return list of measure counts per system (empty if parse fails)."""
    result = _get_system_measure_counts(musicxml_path)
    return result if result else []
