"""Convert MusicXML to MIDI using music21."""

import io
from pathlib import Path

from music21 import converter, midi


def musicxml_to_midi(musicxml_path: Path) -> bytes:
    """
    Convert a MusicXML file (.xml or .mxl) to MIDI bytes.

    Args:
        musicxml_path: Path to the MusicXML file

    Returns:
        MIDI file as bytes

    Raises:
        ValueError: If conversion fails
    """
    try:
        score = converter.parse(str(musicxml_path))
    except Exception as e:
        raise ValueError(f"Failed to parse MusicXML: {e}") from e

    try:
        mf = midi.translate.streamToMidiFile(score)
        midi_stream = io.BytesIO()
        mf.openFileLike(midi_stream)
        mf.write()
        result = midi_stream.getvalue()
        mf.close()
        return result
    except Exception as e:
        raise ValueError(f"Failed to convert to MIDI: {e}") from e
