# YouPhonium

Upload a PDF sheet music file and play it in Euphonium sound (approximated by trombone) in your browser.

## Prerequisites

1. **Python 3.9+** – for the backend
2. **OMR engine** (one or more):
   - **HOMR** – `pip install homr` (Python 3.10–3.12). Better beams and eighth notes.
   - **oemer** – `./install_oemer.sh` (from backend directory). Deep learning OMR.
   - **Audiveris** – Download from [audiveris.com](https://audiveris.com/) and add to PATH. Better accidentals and dynamics.

### OMR engine comparison

| Aspect | HOMR | oemer | Audiveris |
|--------|------|-------|------------|
| Beams, eighth notes | ✓ Better | ✓ | — |
| Accidentals (flat, sharp) | Often missed | Often missed | ✓ Better |
| Dynamics (forte, pianissimo) | Often missed | Often missed | ✓ Better |
| Note accuracy | Good | Many errors reported | Good |
| Instrument header | May default to Piano | Defaults to Piano | Better detection |
| Speed | Faster | 2–5 min/page | ~1 min/page |
| Input | PDF, image | PDF, image | PDF only |

**Summary:** **HOMR** is the default (best for rhythm: beams, eighth notes). **Audiveris** is best for accidentals and dynamics. **oemer** can have many wrong notes. Use **HOMR** for playback-focused recognition; switch to **Audiveris** when accidentals matter.

**Playback priorities:** For playback, pitches and rhythm matter most; dynamics and grace notes are optional. See [PLAN.md](PLAN.md) for the full analysis (based on commercial apps like Sheet Music Scanner).

## Setup

1. Create a virtual environment and install dependencies:

   ```bash
   cd sheet-music-player/backend
   python3 -m venv venv
   source venv/bin/activate   # On Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. **Optional:** Install [Audiveris](https://audiveris.com/) for better symbol recognition (accidentals, dynamics).

3. **Optional:** Install oemer for an alternative deep-learning engine: `./install_oemer.sh`

## Run

From the `backend` directory:

**Option A – run script (recommended, shows status immediately):**
```bash
./run.sh
```

**Option B – manual:**
```bash
source venv/bin/activate
export PYTHONUNBUFFERED=1   # Ensures output shows immediately (no buffering)
python -m uvicorn main:app --reload --reload-exclude 'venv*/**' --host 0.0.0.0 --port 8000 --log-level info
```

**If nothing appears in the terminal:**
1. Run in **Terminal.app** or **iTerm** (not Cursor's Run panel)
2. Try `./run-no-reload.sh` instead of `./run.sh` — the reloader can hide output in some IDEs
3. In Cursor: **Terminal → Run Task → "Run backend (no reload, shows output)"**
4. Ensure `PYTHONUNBUFFERED=1` is set (run.sh does this automatically)

Matplotlib env vars are set automatically to avoid font manager hang on macOS.

Then open [http://localhost:8000](http://localhost:8000) in your browser.

## Usage

1. Drag and drop a PDF sheet music file onto the upload area, or click to browse.
2. If multiple OMR engines are installed, choose one (or leave on Auto).
3. Wait for processing (HOMR: faster; oemer: 2–5 min/page; Audiveris: ~1 min/page).
4. Use Play, Pause, Stop and the Tempo slider to control playback.

## Limitations

- **OMR accuracy** varies: clean digital PDFs work best; handwritten or low-quality scans may fail.
- **Complex scores** (many staves, dense notation) may have recognition errors.
- **Euphonium sound** is approximated by trombone (General MIDI has no Euphonium). A custom Euphonium soundfont can be added later.
- **Multi-page PDFs** are processed page by page and merged into one score.

## Project Structure

```
sheet-music-player/
├── backend/
│   ├── main.py           # FastAPI app, upload endpoint, static file serving
│   ├── requirements.txt
│   └── services/
│       ├── omr.py        # HOMR, oemer, and Audiveris OMR engines
│       └── converter.py  # MusicXML → MIDI via music21
├── frontend/
│   ├── index.html
│   ├── app.js            # Upload, MIDI playback, controls
│   └── styles.css
├── PLAN.md               # Development plan, playback prioritization (see Appendix)
└── README.md
```
