"""Optical Music Recognition via Audiveris CLI or HOMR (fallback).

Playback priorities (see PLAN.md): Pitches and rhythm matter most for playback;
dynamics and ornaments are optional. Auto-selection prefers Audiveris for PDF,
then HOMR, then oemer as fallback.
"""

import logging
import os
import signal

log = logging.getLogger(__name__)
import shutil
import subprocess
import sys
import tempfile
import threading
import zipfile
from pathlib import Path
from typing import Callable, List, Optional, Tuple

from .omr_layout import parse_omr_layout, parse_omr_note_positions

AUDIVERIS_NAMES = ("audiveris", "Audiveris")

# Avoid matplotlib font manager hang on macOS (LastResort.otf) - set before any matplotlib import
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "matplotlib_omr"))
_OMR_ENV = os.environ.copy()
# Suppress dependency warnings from homr's deps (requests, etc.) so real errors are visible
_OMR_ENV["PYTHONWARNINGS"] = "ignore"

# OMR calls may be resource-intensive; serialize
_omr_lock = threading.Lock()

# Default macOS installation path (when not in PATH)
MACOS_AUDIVERIS_PATH = Path("/Applications/Audiveris.app/Contents/MacOS/Audiveris")


# --- oemer (primary OMR engine) ---


def _pdf_to_images(pdf_path: Path, output_dir: Path) -> List[Path]:
    """Convert PDF pages to PNG images using PyMuPDF."""
    import fitz  # PyMuPDF

    log.info("[OMR] Converting PDF to PNG: %s", pdf_path.name)
    doc = fitz.open(pdf_path)
    num_pages = len(doc)
    images = []
    for i in range(num_pages):
        log.info("[OMR] Rendering page %d/%d", i + 1, num_pages)
        page = doc.load_page(i)
        pix = page.get_pixmap(dpi=300, alpha=False)
        img_path = output_dir / f"page_{i:04d}.png"
        pix.save(str(img_path))
        images.append(img_path)
    doc.close()
    log.info("[OMR] PDF converted to %d PNG(s): %s", len(images), [str(p.name) for p in images])
    return images


OMR_PAGE_TIMEOUT = 600  # 10 min per page


def _run_oemer_on_image(
    img_path: Path,
    output_dir: Path,
    on_progress: Optional[Callable[[str], None]] = None,
    page_num: int = 1,
    total_pages: int = 1,
) -> Path:
    """Run oemer on a single image. Returns path to .musicxml file."""
    log.info("[OMR] Running oemer on %s (timeout: %d min per page)", img_path.name, OMR_PAGE_TIMEOUT // 60)
    # Use wrapper to suppress matplotlib font_manager INFO (e.g. NISC18030.ttf on macOS)
    run_oemer = Path(__file__).resolve().parent.parent / "run_oemer.py"
    env = {**_OMR_ENV, "LOG_LEVEL": "info"}  # Show oemer's progress
    proc = subprocess.Popen(
        [
            sys.executable, str(run_oemer),
            str(img_path), "-o", str(output_dir),
            "--without-deskew",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        start_new_session=True,  # Process group for clean kill
    )
    # Stream oemer output and capture for error messages
    output_lines: List[str] = []

    def read_output() -> None:
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                output_lines.append(line)
                log.info("[oemer] %s", line)

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()

    # Periodic "still running" updates so UI doesn't look stuck
    stop_timer = threading.Event()

    def elapsed_updater() -> None:
        for elapsed in range(60, OMR_PAGE_TIMEOUT + 1, 60):
            if stop_timer.wait(timeout=60):
                return
            if on_progress:
                on_progress(
                    f"Processing page {page_num}/{total_pages}… "
                    f"({elapsed // 60} min elapsed, {OMR_PAGE_TIMEOUT // 60} min timeout)"
                )

    timer = threading.Thread(target=elapsed_updater, daemon=True)
    timer.start()
    try:
        proc.wait(timeout=OMR_PAGE_TIMEOUT)
    except subprocess.TimeoutExpired:
        log.error("[OMR] TIMEOUT after %d min on %s - killing process", OMR_PAGE_TIMEOUT // 60, img_path.name)
        sys.stderr.write(f"\n*** OMR TIMEOUT: {img_path.name} exceeded {OMR_PAGE_TIMEOUT // 60} min per page ***\n\n")
        sys.stderr.flush()
        try:
            if hasattr(os, "killpg"):
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except (ProcessLookupError, OSError):
            proc.kill()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            log.warning("[OMR] Process did not exit after kill")
        raise RuntimeError(
            f"OMR timed out after {OMR_PAGE_TIMEOUT // 60} minutes per page on {img_path.name}. "
            "Try a simpler image or smaller resolution."
        )
    finally:
        stop_timer.set()
    if proc.returncode != 0:
        err_detail = ""
        if output_lines:
            # Include last 20 lines (often the traceback/error)
            tail = output_lines[-20:] if len(output_lines) > 20 else output_lines
            err_detail = "\n  oemer output: " + "\n  ".join(tail)
        raise RuntimeError(
            f"oemer failed (exit code {proc.returncode}){err_detail}"
        )

    stem = img_path.stem
    musicxml_path = output_dir / f"{stem}.musicxml"
    log.info("[OMR] Page done: %s -> %s", img_path.name, musicxml_path.name)
    if not musicxml_path.exists():
        candidates = list(output_dir.glob("*.musicxml"))
        if candidates:
            musicxml_path = candidates[0]
        else:
            raise RuntimeError(f"oemer did not produce MusicXML. Output: {list(output_dir.iterdir())}")
    return musicxml_path


def _merge_musicxml(paths: List[Path], output_path: Path) -> None:
    """
    Merge multiple MusicXML files (e.g. from multi-page PDF) into one.
    Preserves PDF layout: adds explicit page and system breaks so the merged
    MusicXML matches the original PDF page/system structure.
    """
    from music21 import converter, layout, stream

    if len(paths) == 1:
        shutil.copy2(paths[0], output_path)
        return

    scores = [converter.parse(str(p)) for p in paths]
    merged = scores[0]
    merged.definesExplicitPageBreaks = True
    merged.definesExplicitSystemBreaks = True

    def add_layout_to_measure(m, needs_new_page: bool, page_num: int, needs_new_system: bool):
        if needs_new_page:
            m.insert(0, layout.PageLayout(pageNumber=page_num, isNew=True))
        if needs_new_system:
            m.insert(0, layout.SystemLayout(isNew=True))

    part = merged.parts[0]
    page0_regions = layout.getSystemRegionMeasureNumbers(scores[0]) or []
    for m_idx, m in enumerate(part.getElementsByClass(stream.Measure)):
        needs_sys = (
            m_idx == 0
            or (page0_regions and any(m_idx + 1 == start for start, _ in page0_regions))
        )
        if needs_sys:
            add_layout_to_measure(m, False, 1, True)

    for page_idx, s in enumerate(scores[1:], start=1):
        if not s.parts:
            continue
        page_measures = list(s.parts[0].getElementsByClass(stream.Measure))
        page_regions = layout.getSystemRegionMeasureNumbers(s) or []
        first_of_page = True
        for m_idx, m in enumerate(page_measures):
            needs_page = first_of_page
            needs_sys = first_of_page or any(m_idx + 1 == start for start, _ in page_regions)
            add_layout_to_measure(m, needs_page, page_idx + 1, needs_sys)
            part.append(m)
            first_of_page = False

    merged.write("musicxml", fp=str(output_path))


def run_omr_oemer(
    pdf_path: Path,
    output_dir: Path,
    on_progress: Optional[Callable[[str], None]] = None,
) -> Path:
    """Run oemer OMR on a PDF file (converts to images first)."""
    def _progress(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    output_dir.mkdir(parents=True, exist_ok=True)
    images_dir = output_dir / "pages"
    images_dir.mkdir(exist_ok=True)
    _progress("Converting PDF to images…")
    log.info("[OMR] Step 1: Converting PDF to images")
    images = _pdf_to_images(pdf_path, images_dir)
    if not images:
        raise RuntimeError("PDF has no pages")
    log.info("[OMR] Step 1 done: %d page(s) converted to PNG", len(images))
    return _run_omr_on_images(images, output_dir, pdf_path.stem, on_progress)


def run_omr_from_images(
    image_paths: List[Path],
    output_dir: Path,
    stem: str = "output",
    on_progress: Optional[Callable[[str], None]] = None,
) -> Path:
    """Run oemer OMR on PNG images (no PDF conversion)."""
    if not image_paths:
        raise RuntimeError("No images provided")
    output_dir.mkdir(parents=True, exist_ok=True)
    log.info("[OMR] Running oemer on %d image(s), skipping PDF conversion", len(image_paths))
    return _run_omr_on_images(image_paths, output_dir, stem, on_progress)


def _run_omr_on_images(
    images: List[Path],
    output_dir: Path,
    stem: str,
    on_progress: Optional[Callable[[str], None]] = None,
) -> Path:
    """Run oemer on a list of images and merge results."""
    def _progress(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    total = len(images)
    timeout_min = OMR_PAGE_TIMEOUT // 60
    musicxml_paths = []
    for i, img_path in enumerate(images):
        _progress(f"Processing page {i + 1}/{total}… ({timeout_min} min timeout per page)")
        log.info("[OMR] Processing page %d/%d (%s)", i + 1, total, img_path.name)
        page_out = output_dir / f"omr_{img_path.stem}"
        page_out.mkdir(exist_ok=True)
        with _omr_lock:
            mxl = _run_oemer_on_image(
                img_path, page_out,
                on_progress=on_progress,
                page_num=i + 1,
                total_pages=total,
            )
        musicxml_paths.append(mxl)
        log.info("[OMR] Page %d/%d OMR complete", i + 1, total)

    _progress("Merging pages…")
    log.info("[OMR] Merging %d MusicXML files", len(musicxml_paths))
    merged_path = output_dir / f"{stem}.musicxml"
    _merge_musicxml(musicxml_paths, merged_path)
    return merged_path


_oemer_available: Optional[bool] = None


def _oemer_installed() -> bool:
    """Fast check if oemer package is installed (no heavy import). For health endpoint."""
    import importlib.util
    try:
        return importlib.util.find_spec("oemer.ete") is not None
    except ModuleNotFoundError:
        return False


def find_oemer_fast() -> bool:
    """Fast check if oemer is installed (no import). Use for health/lifespan."""
    return _oemer_installed()


def find_oemer() -> bool:
    """Check if oemer is installed. Import in-process (cached) to avoid subprocess timeout."""
    global _oemer_available
    if _oemer_available is not None:
        return _oemer_available
    try:
        import oemer.ete  # noqa: F401
        _oemer_available = True
    except ImportError:
        _oemer_available = False
    return _oemer_available


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


def _homr_installed() -> bool:
    """Fast check if homr package is installed."""
    import importlib.util
    return importlib.util.find_spec("homr") is not None


def find_homr() -> bool:
    """Check if homr is installed."""
    return _homr_installed()


def _run_homr_on_image(img_path: Path) -> Path:
    """Run homr on a single image. homr saves .musicxml next to the image."""
    log.info("[OMR] Running homr on %s", img_path.name)
    # homr has no __main__; use the CLI script (homr.main:main) from pip
    bin_dir = Path(sys.executable).parent
    homr_cmd = shutil.which("homr")
    if homr_cmd is None:
        for name in ("homr", "homr.exe"):
            p = bin_dir / name
            if p.exists():
                homr_cmd = str(p)
                break
    if homr_cmd is None:
        raise RuntimeError(
            "homr CLI not found. Install with: pip install homr "
            "(script should be in same dir as python)"
        )
    result = subprocess.run(
        [homr_cmd, str(img_path)],
        capture_output=True,
        text=True,
        timeout=120,
        env=_OMR_ENV,
    )
    if result.returncode != 0:
        err_parts = []
        if result.stderr and result.stderr.strip():
            err_parts.append(result.stderr.strip())
        if result.stdout and result.stdout.strip():
            err_parts.append(result.stdout.strip())
        err = "\n".join(err_parts) if err_parts else "Unknown error (check homr supports your Python version: 3.10–3.12)"
        raise RuntimeError(f"homr failed (exit code {result.returncode}): {err}")

    # homr saves to same directory as input, same stem + .musicxml
    mxl_path = img_path.with_suffix(".musicxml")
    if mxl_path.exists():
        return mxl_path
    # Try .mxl
    mxl_path = img_path.with_suffix(".mxl")
    if mxl_path.exists():
        return mxl_path
    candidates = list(img_path.parent.glob("*.musicxml")) + list(img_path.parent.glob("*.mxl"))
    if candidates:
        return candidates[0]
    raise RuntimeError(f"homr did not produce MusicXML. Output: {list(img_path.parent.iterdir())}")


def run_omr_homr(
    pdf_path: Path,
    output_dir: Path,
    on_progress: Optional[Callable[[str], None]] = None,
) -> Path:
    """
    Run HOMR OMR on a PDF (converts to images first).
    HOMR is a Python-based OMR using vision transformers; lighter than oemer.
    """
    def _progress(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    output_dir.mkdir(parents=True, exist_ok=True)
    images_dir = output_dir / "pages"
    images_dir.mkdir(exist_ok=True)

    _progress("Converting PDF to images…")
    images = _pdf_to_images(pdf_path, images_dir)
    if not images:
        raise RuntimeError("PDF has no pages")

    total = len(images)
    musicxml_paths = []
    for i, img_path in enumerate(images):
        msg = f"Processing page {i + 1}/{total}…"
        if i == 0:
            msg += " (HOMR model load: 1–2 min on first page)"
        _progress(msg)
        with _omr_lock:
            mxl = _run_homr_on_image(img_path)
        musicxml_paths.append(mxl)

    _progress("Merging pages…")
    merged_path = output_dir / f"{pdf_path.stem}.musicxml"
    _merge_musicxml(musicxml_paths, merged_path)
    return merged_path


def run_omr_homr_from_images(
    image_paths: List[Path],
    output_dir: Path,
    stem: str = "output",
    on_progress: Optional[Callable[[str], None]] = None,
) -> Path:
    """Run HOMR OMR on image files (no PDF conversion)."""
    def _progress(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    if not image_paths:
        raise RuntimeError("No images provided")

    output_dir.mkdir(parents=True, exist_ok=True)
    total = len(image_paths)
    musicxml_paths = []
    for i, img_path in enumerate(image_paths):
        msg = f"Processing page {i + 1}/{total}…"
        if i == 0:
            msg += " (HOMR model load: 1–2 min on first page)"
        _progress(msg)
        with _omr_lock:
            mxl = _run_homr_on_image(img_path)
        musicxml_paths.append(mxl)

    _progress("Merging pages…")
    merged_path = output_dir / f"{stem}.musicxml"
    _merge_musicxml(musicxml_paths, merged_path)
    return merged_path


def run_omr(
    pdf_path: Path,
    output_dir: Path,
    on_progress: Optional[Callable[[str], None]] = None,
) -> Path:
    """
    Run Audiveris OMR on a PDF file.
    Uses -batch -export (transcribe + export in one command).

    Args:
        pdf_path: Path to the input PDF
        output_dir: Directory for Audiveris output
        on_progress: Optional callback for progress messages

    Returns:
        Path to the generated MusicXML file (.mxl or .xml)

    Raises:
        FileNotFoundError: If Audiveris is not installed
        RuntimeError: If OMR fails
    """
    def _progress(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    audiveris = find_audiveris()
    if not audiveris:
        raise FileNotFoundError(
            "Audiveris is not installed or not in PATH. "
            "Download from https://audiveris.com/ and add it to your PATH."
        )

    output_dir.mkdir(parents=True, exist_ok=True)

    # CLI constants: match GUI settings not saved in run.properties (compiled-in defaults
    # that the GUI shows but doesn't write to file unless explicitly overridden).
    # BlackHeadSizer.minHeight=1.2: match GUI default; ensures small noteheads are recognized.
    _CLI_CONSTANTS = [
        "org.audiveris.omr.sheet.beam.BlackHeadSizer.minHeight=1.2",
    ]

    _progress("Running Audiveris (transcribe + export)…")
    log.info("[OMR] Audiveris batch export: %s", pdf_path.name)
    env = os.environ.copy()
    env.setdefault("JAVA_TOOL_OPTIONS", "-Djava.awt.headless=true")

    def _constant_flags(constants: list) -> list:
        flags = []
        for c in constants:
            flags.extend(["-constant", c])
        return flags

    export_cmd = [
        audiveris,
        "-batch",
        "-force",
        *_constant_flags(_CLI_CONSTANTS),
        "-export",
        "-output",
        str(output_dir),
        "-option",
        "org.audiveris.omr.sheet.BookManager.useSeparateBookFolders=false",
        str(pdf_path),
    ]
    result = subprocess.run(
        export_cmd,
        capture_output=True,
        text=True,
        timeout=300,  # 5 min for complex PDFs
        env=env,
    )
    if result.returncode != 0:
        err = (result.stderr or "").strip() or (result.stdout or "").strip() or "Unknown error"
        log.error("[OMR] Audiveris failed: %s", err)
        raise RuntimeError(
            f"Audiveris failed (exit code {result.returncode}): {err}"
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

    def _find_all_musicxml(search_dir: Path) -> List[Path]:
        """Find all .mxl/.xml files in search_dir, sorted (mvt1 before mvt2, etc.)."""
        if not search_dir.exists():
            return []
        valid = []
        for f in search_dir.rglob("*"):
            if f.is_file() and f.suffix.lower() in (".mxl", ".xml") and _is_musicxml(f):
                valid.append(f)
        # Sort by name so mvt1, mvt2, ... are in order
        valid.sort(key=lambda p: p.name)
        return valid

    # With useSeparateBookFolders=false: output_dir/stem.mxl or output_dir/stem.mvt1.mxl, etc.
    mxl_files = _find_all_musicxml(output_dir)
    if not mxl_files:
        # Fallback: Audiveris may have produced .omr (project file) but not .mxl.
        # Run a second pass to export from the .omr file.
        omr_paths = list(output_dir.glob("*.omr"))
        if omr_paths:
            omr_path = omr_paths[0]
            log.info("[OMR] No MusicXML found, retrying export from .omr: %s", omr_path.name)
            _progress("Exporting from Audiveris project…")
            export_from_omr = subprocess.run(
                [
                    audiveris,
                    "-batch",
                    *_constant_flags(_CLI_CONSTANTS),
                    "-export",
                    "-output",
                    str(output_dir),
                    "-option",
                    "org.audiveris.omr.sheet.BookManager.useSeparateBookFolders=false",
                    str(omr_path),
                ],
                capture_output=True,
                text=True,
                timeout=120,
                env=env,
            )
            if export_from_omr.returncode == 0:
                mxl_files = _find_all_musicxml(output_dir)
        if not mxl_files:
            def _list_files(d: Path) -> list[str]:
                if not d.exists():
                    return []
                return [str(p.relative_to(d)) for p in d.rglob("*") if p.is_file()]

            out_files = _list_files(output_dir)
            # Include log snippet if available (e.g. tmpiiyq1a7k-20260308T2259.log)
            log_hint = ""
            for log_f in output_dir.glob("*.log"):
                try:
                    tail = log_f.read_text(encoding="utf-8", errors="ignore").strip().split("\n")[-10:]
                    if tail:
                        log_hint = f"\n\nLast lines of {log_f.name}:\n" + "\n".join(tail)
                except Exception:
                    pass
                break
            raise RuntimeError(
                f"Audiveris did not produce a MusicXML file in {output_dir}. "
                f"Output: {out_files or '(empty)'}.{log_hint}"
            )

    if len(mxl_files) == 1:
        return mxl_files[0]

    # Multiple movements (mvt1, mvt2, ...): merge into one
    _progress("Merging movements…")
    log.info("[OMR] Merging %d movement file(s)", len(mxl_files))
    merged_path = output_dir / f"{pdf_path.stem}_merged.musicxml"
    _merge_musicxml(mxl_files, merged_path)
    return merged_path


def pdf_to_musicxml(
    pdf_path: Path,
    original_filename: Optional[str] = None,
    on_progress: Optional[Callable[[str], None]] = None,
    engine: Optional[str] = None,
) -> Tuple[Path, Optional[List[dict]], Optional[List[List[dict]]]]:
    """
    Convert PDF to MusicXML using HOMR, oemer, or Audiveris.

    Args:
        pdf_path: Path to the PDF file
        original_filename: Optional original filename (e.g. from upload) for output naming
        on_progress: Optional callback for progress messages
        engine: "homr", "oemer", or "audiveris" to force one; None = auto (Audiveris > HOMR > oemer for PDF)

    Returns:
        (path, omr_layout, omr_note_positions)
        When Audiveris is used, omr_layout and omr_note_positions provide precise PDF overlay data.
    """
    def _progress(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    project_root = Path(__file__).resolve().parent.parent.parent
    output_dir = project_root / "omr_output"
    output_dir.mkdir(exist_ok=True)
    stem = Path(original_filename).stem if original_filename else pdf_path.stem

    with tempfile.TemporaryDirectory() as tmpdir:
        out_dir = Path(tmpdir) / "omr_output"
        musicxml_path = None

        use_audiveris = engine == "audiveris" or (engine is None and find_audiveris())
        use_homr = engine == "homr" or (engine is None and not find_audiveris() and find_homr())
        use_oemer = engine == "oemer" or (
            engine is None and not find_audiveris() and not find_homr() and find_oemer()
        )

        if use_audiveris and find_audiveris():
            if engine is None:
                log.info("[OMR] Auto: using Audiveris for %s", pdf_path.name)
            _progress("Running Audiveris OMR…")
            log.info("[OMR] Using Audiveris for %s", pdf_path.name)
            musicxml_path = run_omr(pdf_path, out_dir, on_progress=on_progress)
        elif use_homr and find_homr():
            if engine is None:
                log.info("[OMR] Auto: Audiveris not installed, using HOMR for %s", pdf_path.name)
            _progress("Running HOMR OMR…")
            log.info("[OMR] Using HOMR for %s", pdf_path.name)
            musicxml_path = run_omr_homr(pdf_path, out_dir, on_progress=on_progress)
        elif use_oemer and find_oemer():
            if engine is None:
                log.info("[OMR] Auto: HOMR and Audiveris not installed, using oemer for %s", pdf_path.name)
            _progress("Running oemer OMR…")
            log.info("[OMR] Using oemer for %s", pdf_path.name)
            musicxml_path = run_omr_oemer(pdf_path, out_dir, on_progress=on_progress)
        elif engine == "audiveris" and not find_audiveris():
            raise RuntimeError(
                "Audiveris not found. Install from https://audiveris.com/ and add to PATH."
            )
        elif (engine == "homr" or use_homr) and not find_homr():
            raise RuntimeError(
                "HOMR not found. Install with: pip install homr"
            )
        elif (engine == "oemer" or use_oemer) and not find_oemer():
            raise RuntimeError(
                "oemer not found. Install with: ./install_oemer.sh (from backend directory)"
            )
        else:
            raise RuntimeError(
                "No OMR engine found. Install HOMR (pip install homr), oemer (./install_oemer.sh), or "
                "Audiveris (https://audiveris.com/)."
            )

        suffix = musicxml_path.suffix
        persistent = output_dir / f"{stem}{suffix}"
        shutil.copy(musicxml_path, persistent)
        persistent.touch()  # Update mtime to now so file date reflects this run
        log.info("[OMR] MusicXML saved to: %s", persistent.resolve())

        # When Audiveris was used, parse .omr for precise measure layout and note positions (PDF overlay)
        omr_layout = None
        omr_note_positions = None
        if use_audiveris:
            omr_paths = list(out_dir.glob("*.omr"))
            if omr_paths:
                omr_layout = parse_omr_layout(omr_paths[0])
                omr_note_positions = parse_omr_note_positions(omr_paths[0])
                if omr_layout:
                    log.info("[OMR] Parsed %d measure positions from .omr for overlay", len(omr_layout))
                if omr_note_positions:
                    total_notes = sum(len(m) for m in omr_note_positions)
                    log.info("[OMR] Parsed %d note positions across %d measures", total_notes, len(omr_note_positions))

        return (persistent, omr_layout, omr_note_positions)


def image_to_musicxml(
    image_path: Path,
    original_filename: Optional[str] = None,
    on_progress: Optional[Callable[[str], None]] = None,
    engine: Optional[str] = None,
) -> Tuple[Path, Optional[List[dict]]]:
    """
    Convert image (PNG, JPG) to MusicXML using HOMR or oemer.
    Audiveris only supports PDF; use HOMR or oemer for images.
    Returns (path, None) - no .omr layout for image engines.
    """
    def _progress(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    if engine == "audiveris":
        raise RuntimeError(
            "Audiveris only supports PDF files. Use HOMR or oemer for image files (PNG, JPG)."
        )

    project_root = Path(__file__).resolve().parent.parent.parent
    output_dir = project_root / "omr_output"
    output_dir.mkdir(exist_ok=True)
    stem = Path(original_filename).stem if original_filename else image_path.stem

    with tempfile.TemporaryDirectory() as tmpdir:
        out_dir = Path(tmpdir) / "omr_output"
        musicxml_path = None
        image_paths = [image_path]

        use_homr = engine == "homr" or (engine is None and find_homr())
        use_oemer = engine == "oemer" or (engine is None and not find_homr() and find_oemer())

        if use_homr and find_homr():
            _progress("Running HOMR OMR…")
            log.info("[OMR] Using HOMR for %s", image_path.name)
            musicxml_path = run_omr_homr_from_images(
                image_paths, out_dir, stem=stem, on_progress=on_progress
            )
        elif use_oemer and find_oemer():
            if engine is None:
                log.warning("[OMR] HOMR not installed. Using oemer for image.")
            _progress("Running oemer OMR…")
            log.info("[OMR] Using oemer for %s", image_path.name)
            musicxml_path = run_omr_from_images(
                image_paths, out_dir, stem=stem, on_progress=on_progress
            )
        elif (engine == "homr" or use_homr) and not find_homr():
            raise RuntimeError("HOMR not found. Install with: pip install homr")
        elif (engine == "oemer" or use_oemer) and not find_oemer():
            raise RuntimeError(
                "oemer not found. Install with: ./install_oemer.sh (from backend directory)"
            )
        else:
            raise RuntimeError(
                "No OMR engine found for images. Install HOMR (pip install homr) or "
                "oemer (./install_oemer.sh). Audiveris only supports PDF."
            )

        suffix = musicxml_path.suffix
        persistent = output_dir / f"{stem}{suffix}"
        shutil.copy2(musicxml_path, persistent)
        log.info("[OMR] MusicXML saved to: %s", persistent.resolve())
        return (persistent, None, None)
