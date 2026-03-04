"""Optical Music Recognition via Audiveris CLI."""

import shutil
import subprocess
import tempfile
import threading
import uuid
import zipfile
from pathlib import Path
from typing import Optional

AUDIVERIS_NAMES = ("audiveris", "Audiveris")

# Audiveris may not handle concurrent runs well; serialize OMR calls
_omr_lock = threading.Lock()

# Default macOS installation path (when not in PATH)
MACOS_AUDIVERIS_PATH = Path("/Applications/Audiveris.app/Contents/MacOS/Audiveris")


def find_audiveris() -> Optional[str]:
    """Find Audiveris executable in PATH or default macOS location."""
    for name in AUDIVERIS_NAMES:
        path = shutil.which(name)
        if path:
            return path
    # Fallback: standard macOS app location
    if MACOS_AUDIVERIS_PATH.exists():
        return str(MACOS_AUDIVERIS_PATH)
    return None


def run_omr(pdf_path: Path, output_dir: Path) -> Path:
    """
    Run Audiveris OMR on a PDF file.

    Args:
        pdf_path: Path to the input PDF
        output_dir: Directory for Audiveris output

    Returns:
        Path to the generated MusicXML file (.mxl or .xml)

    Raises:
        FileNotFoundError: If Audiveris is not installed
        RuntimeError: If OMR fails
    """
    audiveris = find_audiveris()
    if not audiveris:
        raise FileNotFoundError(
            "Audiveris is not installed or not in PATH. "
            "Download from https://audiveris.com/ and add it to your PATH."
        )

    output_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: Transcribe PDF to .omr
    transcribe_cmd = [
        audiveris,
        "-batch",
        "-transcribe",
        "-output",
        str(output_dir),
        str(pdf_path),
    ]
    result = subprocess.run(
        transcribe_cmd,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        stderr = result.stderr or result.stdout or "Unknown error"
        raise RuntimeError(
            f"Audiveris transcribe failed (exit code {result.returncode}): {stderr}"
        )

    # Find the .omr file (direct or in subfolder)
    stem = pdf_path.stem
    omr_path = None
    for candidate in [
        output_dir / f"{stem}.omr",
        output_dir / stem / f"{stem}.omr",
        *output_dir.rglob("*.omr"),
    ]:
        if isinstance(candidate, Path) and candidate.is_file():
            omr_path = candidate
            break
    if omr_path is None:
        out_files = [str(p.relative_to(output_dir)) for p in output_dir.rglob("*") if p.is_file()]
        raise RuntimeError(
            f"Audiveris did not produce .omr file. Output: {out_files or '(empty)'}"
        )

    # Step 2: Export .omr to MusicXML
    export_cmd = [
        audiveris,
        "-batch",
        "-export",
        "-output",
        str(output_dir),
        str(omr_path),
    ]
    result = subprocess.run(
        export_cmd,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        stderr = result.stderr or result.stdout or "Unknown error"
        raise RuntimeError(
            f"Audiveris export failed (exit code {result.returncode}): {stderr}"
        )

    def _is_musicxml(path: Path) -> bool:
        """Check that file is actually MusicXML (not e.g. plist)."""
        try:
            if path.suffix.lower() == ".mxl":
                with zipfile.ZipFile(path, "r") as zf:
                    for name in zf.namelist():
                        if name.endswith(".xml"):
                            sample = zf.read(name)[:4096].decode("utf-8", errors="ignore")
                            return "score-partwise" in sample or "score-timewise" in sample
                return False
            data = path.read_bytes()
            sample = data[:4096].decode("utf-8", errors="ignore")
            return "score-partwise" in sample or "score-timewise" in sample
        except Exception:
            return False

    def _find_musicxml(search_dir: Path) -> Optional[Path]:
        """Search for .mxl or .xml in output_dir only (avoid system temp plist files)."""
        if not search_dir.exists():
            return None
        stem = pdf_path.stem
        for ext in (".mxl", ".xml"):
            candidate = search_dir / f"{stem}{ext}"
            if candidate.exists() and _is_musicxml(candidate):
                return candidate
            candidate = search_dir / stem / f"{stem}{ext}"
            if candidate.exists() and _is_musicxml(candidate):
                return candidate
        for f in search_dir.rglob("*"):
            if f.is_file() and f.suffix.lower() in (".mxl", ".xml") and _is_musicxml(f):
                return f
        return None

    # Search only output_dir (pdf_path.parent can contain plist .xml files)
    found = _find_musicxml(output_dir)
    if found:
        return found

    # Diagnostic: list what Audiveris actually produced
    def _list_files(d: Path) -> list[str]:
        if not d.exists():
            return []
        return [str(p.relative_to(d)) for p in d.rglob("*") if p.is_file()]

    out_files = _list_files(output_dir)
    raise RuntimeError(
        f"Audiveris did not produce a MusicXML file in {output_dir}. "
        f"Output dir contents: {out_files or '(empty)'}."
    )


def pdf_to_musicxml(pdf_path: Path) -> Path:
    """
    Convert PDF to MusicXML using Audiveris. Uses a temp directory for output.

    Args:
        pdf_path: Path to the PDF file

    Returns:
        Path to the generated MusicXML file
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        out_dir = Path(tmpdir) / "omr_output"
        with _omr_lock:
            musicxml_path = run_omr(pdf_path, out_dir)
        # Copy to a persistent temp file so caller can read it
        persistent = Path(tempfile.gettempdir()) / f"sheet_music_{uuid.uuid4().hex}{musicxml_path.suffix}"
        shutil.copy2(musicxml_path, persistent)
        return persistent
