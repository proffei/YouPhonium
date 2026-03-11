(function () {
  "use strict";

  if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const API_URL = (window.location.protocol === "file:" || !window.location.origin || window.location.origin === "null")
    ? "http://localhost:8000"
    : "";

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const browseBtn = document.getElementById("browseBtn");
  const uploadSection = document.getElementById("uploadSection");
  const statusSection = document.getElementById("statusSection");
  const statusEl = document.getElementById("status");
  const playerSection = document.getElementById("playerSection");
  const trackNameEl = document.getElementById("trackName");
  const playBtn = document.getElementById("playBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const stopBtn = document.getElementById("stopBtn");
  const tempoSlider = document.getElementById("tempoSlider");
  const tempoValueEl = document.getElementById("tempoValue");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const errorSection = document.getElementById("errorSection");
  const errorBox = document.getElementById("errorBox");
  const notationSection = document.getElementById("notationSection");
  const pdfCanvas = document.getElementById("pdfCanvas");
  const pdfContainer = document.getElementById("pdfContainer");
  const verovioNotation = document.getElementById("verovioNotation");
  const notationWrapper = document.getElementById("notationWrapper");
  const layoutSection = document.getElementById("layoutSection");
  const measuresPerLineSelect = document.getElementById("measuresPerLineSelect");
  const notationTitle = document.getElementById("notationTitle");
  const playlistSection = document.getElementById("playlistSection");
  const playlistEl = document.getElementById("playlist");
  const mainPlaceholder = document.getElementById("mainPlaceholder");
  const practiceSection = document.getElementById("practiceSection");
  const practiceHint = document.getElementById("practiceHint");
  const recordBtn = document.getElementById("recordBtn");
  const stopRecordBtn = document.getElementById("stopRecordBtn");
  const practiceResults = document.getElementById("practiceResults");
  const accuracyValue = document.getElementById("accuracyValue");
  const correctCount = document.getElementById("correctCount");
  const wrongCount = document.getElementById("wrongCount");
  const missedCount = document.getElementById("missedCount");
  const pageNavSection = document.getElementById("pageNavSection");
  const prevPageBtn = document.getElementById("prevPageBtn");
  const nextPageBtn = document.getElementById("nextPageBtn");
  const pageNavText = document.getElementById("pageNavText");
  const engineSelector = document.getElementById("engineSelector");
  const omrEngineSelect = document.getElementById("omrEngine");
  const viewToggle = document.getElementById("viewToggle");
  const viewPdfBtn = document.getElementById("viewPdfBtn");
  const viewNotationBtn = document.getElementById("viewNotationBtn");
  const pdfOverlay = document.getElementById("pdfOverlay");
  const measureHighlight = document.getElementById("measureHighlight");
  const notationViewport = document.getElementById("notationViewport");

  const MAX_PLAYLIST_SIZE = 20;
  let playlist = [];
  let currentTrackId = null;
  let playlistIdCounter = 0;

  let audioContext = null;
  let instrument = null;
  let midiData = null;
  let notes = [];
  let totalDuration = 0;
  let scoreDuration = 0;  /* when set, use for playback end (matches sheet); else use totalDuration */
  let playhead = 0;
  let lastPlayedIndex = 0;
  let tempo = 1;
  let startRealTime = 0;
  let rafId = null;
  let isPlaying = false;
  let verovioTk = null;
  let verovioReady = null;
  let currentNotationPage = 1;
  let pdfBlobUrl = null;
  let pdfDoc = null;
  let hasVerovioScore = false;
  let viewMode = "pdf";  /* "pdf" | "notation" - PDF preferred, notation has playback highlight */
  let practiceComparison = null;
  let noteIdMap = null;
  let mediaRecorder = null;
  let mediaStream = null;
  let recordedChunks = [];

  verovioReady =
    typeof verovio !== "undefined"
      ? new Promise(function (resolve) {
          verovio.module.onRuntimeInitialized = function () {
            verovioTk = new verovio.toolkit();
            verovioTk.setOptions({ pageWidth: 800, scale: 50 });
            resolve();
          };
        })
      : Promise.resolve();

  function loadPdfAndGetDimensions(blobUrl) {
    if (!blobUrl || typeof pdfjsLib === "undefined") return Promise.resolve({ dims: null });
    return pdfjsLib
      .getDocument(blobUrl)
      .promise.then(function (pdf) {
        pdfDoc = pdf;
        return pdf.getPage(1);
      })
      .then(function (page) {
        var vp = page.getViewport({ scale: 1 });
        return { dims: { width: Math.round(vp.width), height: Math.round(vp.height) } };
      })
      .catch(function () {
        pdfDoc = null;  /* e.g. PNG file, not a PDF */
        return { dims: null };
      });
  }

  var PDF_DISPLAY_SCALE = 1.5;
  var measuresPerLineMultiplier = 3;

  /* Match Verovio page width to PDF content area at display scale */
  var PDF_CONTENT_WIDTH_FACTOR = 0.86;
  /* Verovio tends to fit ~half the expected measures; scale up to match original layout */
  var LAYOUT_PAGE_WIDTH_FACTOR = 2;
  var currentTrackForLayout = null;

  function applyVerovioLayout() {
    if (!verovioTk) return;
    var track = currentTrackForLayout;
    var n = Math.max(1, Math.min(10, measuresPerLineMultiplier));
    var baseW = 2100;
    var baseN = n;
    if (track && track.layoutParams) {
      baseW = track.layoutParams.pageWidthVerovio;
      baseN = track.layoutParams.measuresPerLineForPageWidth;
    }
    var pageW = Math.round(baseW * (n / Math.max(1, baseN)));
    try {
      verovioTk.setOptions({
        pageWidth: pageW,
        scale: 100,
        adjustPageWidth: false,
        condense: "auto",
        spacingNonLinear: 1,
        spacingLinear: 0.03,
      });
    } catch (e) {
      verovioTk.setOptions({
        pageWidth: pageW,
        scale: 100,
        adjustPageWidth: false,
      });
    }
    if (typeof verovioTk.redoLayout === "function") {
      verovioTk.redoLayout();
    }
  }

  function renderPdfPage(pageNum, onRendered) {
    if (!pdfDoc || !pdfCanvas) return;
    pdfDoc.getPage(pageNum).then(function (page) {
      var viewport = page.getViewport({ scale: PDF_DISPLAY_SCALE });
      var ctx = pdfCanvas.getContext("2d");
      pdfCanvas.height = viewport.height;
      pdfCanvas.width = viewport.width;
      var renderTask = page.render({
        canvasContext: ctx,
        viewport: viewport,
      });
      function done() {
        if (viewMode === "pdf" && pdfOverlay) {
          requestAnimationFrame(function () { drawPdfOverlay(); });
        }
        if (onRendered) requestAnimationFrame(onRendered);
      }
      if (renderTask && renderTask.promise) {
        renderTask.promise.then(done);
      } else {
        done();
      }
    });
  }

  function drawPdfOverlay() {
    if (!pdfOverlay || !pdfCanvas || pdfOverlay.getContext === undefined) return;
    var w = pdfCanvas.offsetWidth || pdfCanvas.width;
    var h = pdfCanvas.offsetHeight || pdfCanvas.height;
    if (w <= 0 || h <= 0) return;
    pdfOverlay.width = w;
    pdfOverlay.height = h;
    pdfOverlay.style.width = w + "px";
    pdfOverlay.style.height = h + "px";
    var ctx = pdfOverlay.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    if (totalDuration <= 0) return;
    var track = currentTrackForLayout;
    var boundaries = track && track.measureBoundaries ? track.measureBoundaries : [];
    var layoutPositions = track && track.measureLayoutPositions ? track.measureLayoutPositions : [];
    var notePositions = track && track.measureNotePositions ? track.measureNotePositions : [];

    var currentMeasureIdx = -1;
    for (var i = 0; i < boundaries.length; i++) {
      if (playhead >= boundaries[i][0] && playhead < boundaries[i][1]) {
        currentMeasureIdx = i;
        break;
      }
    }
    if (currentMeasureIdx < 0) return;

    var blockX, blockY, blockW, blockH;
    var layout = currentMeasureIdx < layoutPositions.length ? layoutPositions[currentMeasureIdx] : null;
    var pageId = currentNotationPage - 1;

    if (layout && layout.page === pageId) {
      blockX = layout.left * w;
      blockY = layout.top * h;
      blockW = (layout.right - layout.left) * w;
      blockH = (layout.bottom - layout.top) * h;
    } else {
      var systemTimes = track && track.systemTimeRanges ? track.systemTimeRanges : [];
      var systemRegions = track && track.systemRegions ? track.systemRegions : [];
      var pageCount = pdfDoc ? pdfDoc.numPages || 1 : 1;
      var measureStart = boundaries[currentMeasureIdx][0];
      var measureEnd = boundaries[currentMeasureIdx][1];
      var useSystemLayout = systemTimes.length > 0 && systemRegions.length > 0;

      if (useSystemLayout) {
      var sysIdx = -1;
      for (var s = 0; s < systemTimes.length; s++) {
        if (playhead >= systemTimes[s][0] && playhead < systemTimes[s][1]) {
          sysIdx = s;
          break;
        }
      }
      if (sysIdx < 0 && systemTimes.length > 0) {
        if (playhead >= systemTimes[systemTimes.length - 1][1]) sysIdx = systemTimes.length - 1;
        else sysIdx = 0;
      }

      var systemsPerPage = Math.max(1, Math.ceil(systemTimes.length / pageCount));
      var pageFirstSystem = (currentNotationPage - 1) * systemsPerPage;
      var pageLastSystem = Math.min(systemTimes.length, currentNotationPage * systemsPerPage) - 1;
      if (sysIdx < pageFirstSystem || sysIdx > pageLastSystem) return;

      var systemIdxInPage = sysIdx - pageFirstSystem;
      var systemTop = (systemIdxInPage / systemsPerPage) * h;
      var systemHeight = h / systemsPerPage;

      var measuresInSystem = 1;
      var measureIdxInSystem = 0;
      if (sysIdx < systemRegions.length) {
        var r = systemRegions[sysIdx];
        measuresInSystem = Math.max(1, r[1] - r[0] + 1);
        measureIdxInSystem = (currentMeasureIdx + 1) - r[0];
        measureIdxInSystem = Math.max(0, Math.min(measuresInSystem - 1, measureIdxInSystem));
      }

      var measureWidth = w / measuresInSystem;
      var staffHeight = systemHeight * 0.28;
      blockX = measureIdxInSystem * measureWidth;
      blockY = systemTop + (systemHeight - staffHeight) / 2;
      blockW = measureWidth;
      blockH = staffHeight;
    } else {
      var pageStart = (currentNotationPage - 1) / pageCount * totalDuration;
      var pageEnd = currentNotationPage / pageCount * totalDuration;
      var pageDuration = pageEnd - pageStart;
      if (pageDuration <= 0) return;
      if (playhead < pageStart || playhead >= pageEnd) return;
      var mStartLocal = Math.max(0, measureStart - pageStart);
      var mEndLocal = Math.min(pageDuration, measureEnd - pageStart);
      var y1 = (mStartLocal / pageDuration) * h;
      var y2 = (mEndLocal / pageDuration) * h;
      var bandH = Math.max(4, y2 - y1);
      var staffH = bandH * 0.28;
      blockX = 0;
      blockY = y1 + (bandH - staffH) / 2;
      blockW = w;
      blockH = staffH;
    }
    }

    ctx.fillStyle = "rgba(220, 38, 38, 0.2)";
    ctx.fillRect(blockX, blockY, blockW, blockH);
    ctx.strokeStyle = "rgb(220, 38, 38)";
    ctx.lineWidth = 2;
    ctx.strokeRect(blockX, blockY, blockW, blockH);
    var measureStart = boundaries[currentMeasureIdx][0];
    var measureEnd = boundaries[currentMeasureIdx][1];
    var measureNotes = [];
    for (var n = 0; n < notes.length; n++) {
      var nt = notes[n];
      if (nt.time >= measureEnd) break;
      if (nt.time + nt.duration > measureStart) measureNotes.push(nt);
    }
    var currentNoteIdx = -1;
    for (var n = 0; n < measureNotes.length; n++) {
      var nt = measureNotes[n];
      if (playhead >= nt.time && playhead < nt.time + nt.duration) {
        currentNoteIdx = n;
        break;
      }
    }
    if (currentNoteIdx >= 0) {
      var useNoteRects = layout && layout.page === pageId && currentMeasureIdx < notePositions.length &&
        currentNoteIdx < notePositions[currentMeasureIdx].length;
      if (useNoteRects) {
        var nr = notePositions[currentMeasureIdx][currentNoteIdx];
        var fillStyle = "rgba(22, 101, 52, 0.5)";
        var strokeStyle = "rgb(22, 101, 52)";
        ctx.fillStyle = fillStyle;
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = 1.5;
        if (nr.rest) {
          var l = nr.left * w, t = nr.top * h, r = nr.right * w, b = nr.bottom * h;
          var cx = (l + r) / 2, cy = (t + b) / 2;
          var dashLen = Math.min(20, (r - l) * 0.6);
          ctx.beginPath();
          ctx.moveTo(cx - dashLen / 2, cy);
          ctx.lineTo(cx + dashLen / 2, cy);
          ctx.stroke();
        } else {
          var headsToDraw = nr.heads || (nr.head ? [nr.head] : []);
          for (var i = 0; i < headsToDraw.length; i++) {
            var hdr = headsToDraw[i];
            var hx = hdr.left * w, hy = hdr.top * h;
            var hw = (hdr.right - hdr.left) * w, hh = (hdr.bottom - hdr.top) * h;
            var cx = hx + hw / 2, cy = hy + hh / 2;
            var rx = hw / 2, ry = hh / 2;
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
          if (nr.stem) {
            var s = nr.stem;
            var sx = s.left * w, sy = s.top * h;
            var sw = (s.right - s.left) * w, sh = (s.bottom - s.top) * h;
            ctx.fillRect(sx, sy, sw, sh);
            ctx.strokeRect(sx, sy, sw, sh);
          }
          if (headsToDraw.length === 0 && !nr.stem && nr.left != null) {
            var nx = nr.left * w, ny = nr.top * h;
            var nw = (nr.right - nr.left) * w, nh = (nr.bottom - nr.top) * h;
            var cx = nx + nw / 2, cy = ny + nh / 2;
            var base = Math.min(nw, nh);
            var rx = Math.max(4, base * 0.48), ry = Math.max(5, base * 0.58);
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
      } else if (measureNotes.length > 0) {
        var frac = (currentNoteIdx + 0.5) / measureNotes.length;
        var dotX = blockX + frac * blockW;
        var dotY = blockY + blockH / 2;
        var dotRx = Math.min(10, blockW * 0.08);
        var dotRy = Math.min(8, blockH * 0.35);
        ctx.fillStyle = "rgba(22, 101, 52, 0.35)";
        ctx.beginPath();
        ctx.ellipse(dotX, dotY, dotRx, dotRy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgb(22, 101, 52)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  function updatePageNav() {
    if (!pageNavSection) return;
    var total = 1;
    if (verovioTk && hasVerovioScore) total = verovioTk.getPageCount ? verovioTk.getPageCount() : 1;
    else if (pdfDoc) total = pdfDoc.numPages || 1;
    if (total <= 1) {
      pageNavSection.hidden = true;
      return;
    }
    pageNavSection.hidden = false;
    if (pageNavText) pageNavText.textContent = "Page " + currentNotationPage + " of " + total;
    if (prevPageBtn) prevPageBtn.disabled = currentNotationPage <= 1;
    if (nextPageBtn) nextPageBtn.disabled = currentNotationPage >= total;
  }

  function goToPage(pageNum) {
    var total = 1;
    if (verovioTk && hasVerovioScore) total = verovioTk.getPageCount ? verovioTk.getPageCount() : 1;
    else if (pdfDoc) total = pdfDoc.numPages || 1;
    var p = Math.max(1, Math.min(total, pageNum));
    currentNotationPage = p;
    if (viewMode === "pdf" && pdfDoc) {
      renderPdfPage(p);
    } else if (verovioTk && verovioNotation && hasVerovioScore) {
      verovioNotation.innerHTML = verovioTk.renderToSVG(p);
      updateNotationView();
    }
    updatePageNav();
  }

  function getVerovioScoreDuration() {
    if (!verovioTk || totalDuration <= 0) return totalDuration;
    var pageCount = verovioTk.getPageCount ? verovioTk.getPageCount() : 1;
    if (pageCount > 1) return totalDuration;
    var stepSec = 0.5;
    var lastValidSec = 0;
    for (var t = 0; t <= totalDuration; t += stepSec) {
      var el = verovioTk.getElementsAtTime(t * 1000);
      if (el && el.page && el.page !== 0) lastValidSec = t;
    }
    if (lastValidSec <= 0) return totalDuration;
    return Math.min(totalDuration, lastValidSec + stepSec);
  }

  function updateNotationView() {
    if (viewMode === "pdf") {
      var pageCount = pdfDoc ? pdfDoc.numPages || 1 : 1;
      if (pageCount > 1 && totalDuration > 0) {
        var ratio = playhead / totalDuration;
        var targetPage = Math.min(pageCount, Math.max(1, Math.ceil(ratio * pageCount)));
        if (targetPage !== currentNotationPage) {
          currentNotationPage = targetPage;
          renderPdfPage(currentNotationPage);
          updatePageNav();
        }
      }
      drawPdfOverlay();
      return;
    }
    if (!hasVerovioScore || !verovioTk) return;
    var track = currentTrackForLayout;
    var timeMs = playhead * 1000;
    var currentElements = verovioTk.getElementsAtTime(timeMs);
    var pageCount = verovioTk.getPageCount ? verovioTk.getPageCount() : 1;
    var targetPage = currentNotationPage;

    if (currentElements && currentElements.page && currentElements.page !== 0) {
      targetPage = currentElements.page;
    } else if (pageCount > 1 && totalDuration > 0) {
      var ratio = playhead / totalDuration;
      targetPage = Math.min(pageCount, Math.max(1, Math.ceil(ratio * pageCount)));
    }

    if (targetPage !== currentNotationPage) {
      currentNotationPage = targetPage;
      if (verovioNotation) {
        verovioNotation.innerHTML = verovioTk.renderToSVG(currentNotationPage);
      }
      updatePageNav();
    }

    if (verovioNotation) {
      var playingNotes = verovioNotation.querySelectorAll("g.note.playing, [data-playing]");
      for (var i = 0; i < playingNotes.length; i++) {
        var p = playingNotes[i];
        p.classList.remove("playing");
        p.removeAttribute("data-playing");
        p.style.fill = "";
        p.style.stroke = "";
        var kids = p.querySelectorAll("*");
        for (var k = 0; k < kids.length; k++) {
          kids[k].style.fill = "";
          kids[k].style.stroke = "";
        }
      }
      var measureEl = null;
      var hasPlayingNotes = currentElements && currentElements.notes && currentElements.notes.length;
      if (hasPlayingNotes) {
        var firstNoteEl = verovioNotation.querySelector("#" + CSS.escape(currentElements.notes[0])) || document.getElementById(currentElements.notes[0]);
        measureEl = firstNoteEl && firstNoteEl.closest ? (firstNoteEl.closest("g.measure") || firstNoteEl.closest("[class*='measure']")) : null;
      }
      if (!measureEl && currentElements && track && track.measureBoundaries) {
        var boundaries = track.measureBoundaries;
        for (var b = 0; b < boundaries.length; b++) {
          if (playhead >= boundaries[b][0] && playhead < boundaries[b][1]) {
            var sampleMs = (boundaries[b][0] + 0.05) * 1000;
            var sampleEl = verovioTk.getElementsAtTime(sampleMs);
            if (sampleEl && sampleEl.notes && sampleEl.notes.length) {
              var sampleNoteEl = verovioNotation.querySelector("#" + CSS.escape(sampleEl.notes[0])) || document.getElementById(sampleEl.notes[0]);
              measureEl = sampleNoteEl && sampleNoteEl.closest ? (sampleNoteEl.closest("g.measure") || sampleNoteEl.closest("[class*='measure']")) : null;
            }
            break;
          }
        }
      }
      if (measureEl || hasPlayingNotes) {
        if (hasPlayingNotes) {
          for (var j = 0; j < currentElements.notes.length; j++) {
            var noteId = currentElements.notes[j];
            var el = document.getElementById(noteId) || verovioNotation.querySelector("#" + CSS.escape(noteId));
            if (el) {
              el.classList.add("playing");
              el.setAttribute("data-playing", "1");
            }
          }
        }
        if (measureHighlight && notationViewport && measureEl) {
          var vpRect = notationViewport.getBoundingClientRect();
          var mRect = measureEl.getBoundingClientRect();
          measureHighlight.style.display = "block";
          measureHighlight.style.left = (mRect.left - vpRect.left) + "px";
          measureHighlight.style.top = (mRect.top - vpRect.top) + "px";
          measureHighlight.style.width = mRect.width + "px";
          measureHighlight.style.height = mRect.height + "px";
        } else if (measureHighlight) {
          measureHighlight.style.display = "none";
        }
      } else if (measureHighlight) {
        measureHighlight.style.display = "none";
      }
    }
  }

  function clearVerovioHighlights() {
    if (viewMode === "pdf" && pdfOverlay && pdfOverlay.getContext) {
      var ctx = pdfOverlay.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, pdfOverlay.width || 0, pdfOverlay.height || 0);
    }
    if (measureHighlight) {
      measureHighlight.style.display = "none";
    }
    if (verovioNotation) {
      var playingNotes = verovioNotation.querySelectorAll("g.note.playing, [data-playing]");
      for (var i = 0; i < playingNotes.length; i++) {
        var p = playingNotes[i];
        p.classList.remove("playing");
        p.removeAttribute("data-playing");
        p.style.fill = "";
        p.style.stroke = "";
        var kids = p.querySelectorAll("*");
        for (var k = 0; k < kids.length; k++) {
          kids[k].style.fill = "";
          kids[k].style.stroke = "";
        }
      }
    }
  }

  function switchView(mode) {
    viewMode = mode;
    if (viewPdfBtn) viewPdfBtn.classList.toggle("active", mode === "pdf");
    if (viewNotationBtn) viewNotationBtn.classList.toggle("active", mode === "notation");
    if (mode === "pdf") {
      if (pdfContainer) pdfContainer.hidden = false;
      if (notationViewport) notationViewport.hidden = true;
      if (verovioNotation) verovioNotation.hidden = true;
      if (pdfDoc) renderPdfPage(currentNotationPage);
    } else {
      if (pdfContainer) pdfContainer.hidden = true;
      if (notationViewport) notationViewport.hidden = false;
      if (verovioNotation) verovioNotation.hidden = false;
      if (verovioTk && hasVerovioScore) {
        verovioNotation.innerHTML = verovioTk.renderToSVG(currentNotationPage);
        updateNotationView();
      }
    }
  }

  function clearPracticeFeedback() {
    practiceComparison = null;
    noteIdMap = null;
    if (verovioNotation) {
      var els = verovioNotation.querySelectorAll("[data-practice]");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        el.removeAttribute("data-practice");
        el.style.fill = "";
        el.style.stroke = "";
        var kids = el.querySelectorAll("*");
        for (var k = 0; k < kids.length; k++) {
          kids[k].style.fill = "";
          kids[k].style.stroke = "";
        }
      }
    }
  }

  function compareNotes(expectedNotes, recordedNotes) {
    var TIME_WINDOW = 0.2;
    var PITCH_TOLERANCE = 1;
    var correct = [];
    var wrong = [];
    var missed = [];
    var used = {};
    for (var i = 0; i < expectedNotes.length; i++) {
      var exp = expectedNotes[i];
      var expTime = exp.time;
      var expMidi = exp.midi;
      var best = null;
      var bestDist = Infinity;
      for (var j = 0; j < recordedNotes.length; j++) {
        if (used[j]) continue;
        var rec = recordedNotes[j];
        var recTime = rec.start !== undefined ? rec.start : rec.time;
        var recMidi = rec.midi;
        var timeDist = Math.abs(recTime - expTime);
        var pitchDist = Math.abs(recMidi - expMidi);
        if (timeDist <= TIME_WINDOW && pitchDist < bestDist) {
          bestDist = pitchDist;
          best = { j: j, rec: rec, pitchDist: pitchDist };
        }
      }
      if (best && best.pitchDist <= PITCH_TOLERANCE) {
        correct.push({ expIdx: i, recIdx: best.j });
        used[best.j] = true;
      } else if (best) {
        wrong.push({ expIdx: i, recIdx: best.j });
        used[best.j] = true;
      } else {
        missed.push({ expIdx: i });
      }
    }
    var accuracy = expectedNotes.length > 0
      ? Math.round((correct.length / expectedNotes.length) * 100)
      : 0;
    return { correct: correct, wrong: wrong, missed: missed, accuracy: accuracy };
  }

  function applyPracticeFeedback(comparison) {
    if (!verovioTk || !verovioNotation || !comparison) return;
    clearPracticeFeedback();
    var correctColor = "rgb(34, 197, 94)";  /* green for agreed notes */
    var errorColor = "rgb(239, 68, 68)";    /* red for wrong or missed notes */
    for (var i = 0; i < notes.length; i++) {
      var timeMs = notes[i].time * 1000;
      var el = verovioTk.getElementsAtTime(timeMs);
      if (!el || !el.notes) continue;
      var noteIds = el.notes;
      var color = null;
      if (comparison.correct.some(function (c) { return c.expIdx === i; })) {
        color = correctColor;
      } else if (comparison.wrong.some(function (w) { return w.expIdx === i; }) ||
                 comparison.missed.some(function (m) { return m.expIdx === i; })) {
        color = errorColor;
      }
      if (color) {
        for (var j = 0; j < noteIds.length; j++) {
          var noteEl = verovioNotation.querySelector("#" + CSS.escape(noteIds[j]));
          if (noteEl) {
            noteEl.setAttribute("data-practice", "1");
            noteEl.style.fill = color;
            noteEl.style.stroke = color;
            var kids = noteEl.querySelectorAll("*");
            for (var k = 0; k < kids.length; k++) {
              kids[k].style.fill = color;
              kids[k].style.stroke = color;
            }
          }
        }
      }
    }
  }

  function showStatus(msg, type = "") {
    statusSection.hidden = false;
    statusEl.textContent = msg;
    statusEl.className = "status " + type;
  }

  function hideStatus() {
    statusSection.hidden = true;
  }

  function showError(msg) {
    errorSection.hidden = false;
    errorBox.textContent = msg;
  }

  function hideError() {
    errorSection.hidden = true;
  }

  function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError("Microphone access is not supported in this browser.");
      return;
    }
    if (!hasVerovioScore || notes.length === 0) {
      showError("Load a track with sheet music first.");
      return;
    }
    recordedChunks = [];
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        mediaStream = stream;
        var mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
        try {
          mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
        } catch (e) {
          mediaRecorder = new MediaRecorder(stream);
        }
        mediaRecorder.ondataavailable = function (e) {
          if (e.data && e.data.size > 0) recordedChunks.push(e.data);
        };
        mediaRecorder.start();
        recordBtn.disabled = true;
        stopRecordBtn.disabled = false;
        practiceResults.hidden = true;
        if (recordBtn.classList) recordBtn.classList.add("recording");
      })
      .catch(function (err) {
        showError("Could not access microphone: " + (err.message || "Permission denied"));
      });
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === "inactive") return;
    mediaRecorder.stop();
    stopRecordBtn.disabled = true;
    if (recordBtn.classList) recordBtn.classList.remove("recording");
    mediaRecorder.onstop = function () {
      if (mediaStream) {
        mediaStream.getTracks().forEach(function (t) { t.stop(); });
        mediaStream = null;
      }
      mediaRecorder = null;
      if (recordedChunks.length === 0) {
        showError("Recording was empty. Try again.");
        recordBtn.disabled = false;
        return;
      }
      var blob = new Blob(recordedChunks, { type: "audio/webm" });
      recordedChunks = [];
      showStatus("Transcribing…", "loading");
      var formData = new FormData();
      formData.append("file", blob, "recording.webm");
      fetch((API_URL || window.location.origin) + "/transcribe", {
        method: "POST",
        body: formData,
      })
        .then(function (res) {
          return res.text().then(function (t) {
            if (!res.ok) {
              var msg = res.statusText || "Transcription failed";
              try {
                var body = JSON.parse(t);
                if (body.detail) msg = body.detail;
              } catch (e) { if (t) msg = t; }
              throw new Error(msg);
            }
            return JSON.parse(t);
          });
        })
        .then(function (data) {
          hideStatus();
          var recordedNotes = data.notes || [];
          var comparison = compareNotes(notes, recordedNotes);
          practiceComparison = comparison;
          accuracyValue.textContent = String(comparison.accuracy);
          correctCount.textContent = String(comparison.correct.length);
          wrongCount.textContent = String(comparison.wrong.length);
          missedCount.textContent = String(comparison.missed.length);
          practiceResults.hidden = false;
          applyPracticeFeedback(comparison);
          recordBtn.disabled = false;
        })
        .catch(function (err) {
          hideStatus();
          showError(err.message || "Transcription failed");
          recordBtn.disabled = false;
        });
    };
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function ensureAudioContext() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
  }

  function loadInstrument() {
    if (instrument) return Promise.resolve(instrument);
    const ac = ensureAudioContext();
    return Soundfont.instrument(ac, "trombone", {
      soundfont: "FluidR3_GM",
    }).then(function (inst) {
      instrument = inst;
      return inst;
    });
  }

  function collectNotes(midi) {
    const all = [];
    midi.tracks.forEach(function (track) {
      if (track.notes && track.notes.length) {
        track.notes.forEach(function (note) {
          all.push({
            time: note.time,
            midi: note.midi,
            duration: note.duration,
            velocity: note.velocity != null ? note.velocity : 0.8,
          });
        });
      }
    });
    all.sort(function (a, b) {
      return a.time - b.time;
    });
    return all;
  }

  function tick() {
    if (!isPlaying || !instrument) return;
    var endTime = scoreDuration > 0 ? scoreDuration : totalDuration;
    const elapsed = (performance.now() - startRealTime) / 1000 * tempo;
    playhead = Math.min(elapsed, endTime);

    while (lastPlayedIndex < notes.length && notes[lastPlayedIndex].time <= playhead) {
      const note = notes[lastPlayedIndex];
      const scaledDuration = note.duration / tempo;
      instrument.play(note.midi, 0, {
        duration: scaledDuration,
        gain: note.velocity,
      });
      lastPlayedIndex++;
    }

    var progressPct = endTime > 0 ? Math.min(100, (playhead / endTime) * 100) : 0;
    progressBar.style.width = progressPct + "%";
    progressText.textContent = formatTime(playhead) + " / " + formatTime(endTime);
    updateNotationView();

    var reachedEnd = lastPlayedIndex >= notes.length || playhead >= endTime;
    if (!reachedEnd) {
      rafId = requestAnimationFrame(tick);
    } else {
      isPlaying = false;
      playhead = 0;
      lastPlayedIndex = 0;
      progressBar.style.width = "0%";
      progressText.textContent = "0:00 / " + formatTime(endTime);
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
      clearVerovioHighlights();
    }
  }

  function play() {
    if (!instrument || !notes.length) return;
    clearPracticeFeedback();
    ensureAudioContext().resume();
    hideError();
    isPlaying = true;
    playBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
    startRealTime = performance.now() - (playhead / tempo) * 1000;
    rafId = requestAnimationFrame(tick);
  }

  function pause() {
    isPlaying = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (instrument) instrument.stop();
    playBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled = false;
  }

  function stop() {
    pause();
    playhead = 0;
    lastPlayedIndex = 0;
    progressBar.style.width = "0%";
    var endTime = scoreDuration > 0 ? scoreDuration : totalDuration;
    progressText.textContent = "0:00 / " + formatTime(endTime);
    clearVerovioHighlights();
  }

  function onTempoChange() {
    tempo = parseFloat(tempoSlider.value);
    tempoValueEl.textContent = tempo.toFixed(1) + "×";
  }

  function seekTo(seconds) {
    if (!notes.length || totalDuration <= 0) return;
    var endTime = scoreDuration > 0 ? scoreDuration : totalDuration;
    var t = Math.max(0, Math.min(endTime, seconds));
    playhead = t;
    lastPlayedIndex = 0;
    while (lastPlayedIndex < notes.length && notes[lastPlayedIndex].time < playhead) {
      lastPlayedIndex++;
    }
    if (instrument) instrument.stop();
    progressBar.style.width = (playhead / endTime) * 100 + "%";
    progressText.textContent = formatTime(playhead) + " / " + formatTime(endTime);
    updateNotationView();
    if (isPlaying) {
      startRealTime = performance.now() - (playhead / tempo) * 1000;
    }
  }

  function handleProgressSeek(e) {
    var trackEl = document.getElementById("progressTrack");
    if (!trackEl || !notes.length) return;
    var endTime = scoreDuration > 0 ? scoreDuration : totalDuration;
    var rect = trackEl.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var ratio = Math.max(0, Math.min(1, x / rect.width));
    seekTo(ratio * endTime);
  }

  function setupTrackFromStoredData(track) {
    if (pdfBlobUrl) {
      URL.revokeObjectURL(pdfBlobUrl);
      pdfBlobUrl = null;
    }
    var pdfLoadPromise = Promise.resolve({ dims: null });
    if (track.file) {
      pdfBlobUrl = URL.createObjectURL(track.file);
      pdfLoadPromise = loadPdfAndGetDimensions(pdfBlobUrl);
    }
    return pdfLoadPromise.then(function (pdfResult) {
      currentTrackForLayout = track;
      var pdfDims = pdfResult && pdfResult.dims;
      var pdfWidthPt = pdfDims && pdfDims.width ? pdfDims.width : 0;
      var n = track.measuresPerLine != null ? track.measuresPerLine : track.measuresPerFirstSystem;
      if (n == null) n = 2;
      if (n != null && n > 4) n = 4;
      measuresPerLineMultiplier = Math.max(1, Math.min(10, n));
      if (measuresPerLineSelect) measuresPerLineSelect.value = String(measuresPerLineMultiplier);
      if (pdfWidthPt > 0 && n != null && n > 0) {
        var contentWidthPx = pdfWidthPt * PDF_CONTENT_WIDTH_FACTOR * PDF_DISPLAY_SCALE * LAYOUT_PAGE_WIDTH_FACTOR;
        track.layoutParams = {
          pageWidthVerovio: Math.round(contentWidthPx),
          measuresPerLineForPageWidth: n,
        };
      } else {
        track.layoutParams = null;
      }
      return verovioReady.then(function () {
        var uploadData = {
          midi_base64: track.midiBase64,
          musicxml_base64: track.musicxmlBase64 || null,
          musicxml_format: track.musicxmlFormat || null,
        };
        if (viewToggle) viewToggle.hidden = true;
        if (uploadData.musicxml_base64 && typeof verovio !== "undefined") {
          try {
            var binary = atob(uploadData.musicxml_base64);
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            if (uploadData.musicxml_format === "mxl") {
              verovioTk.loadZipDataBuffer(bytes.buffer);
            } else {
              verovioTk.loadData(new TextDecoder().decode(bytes));
            }
            var verovioMidiBase64 = verovioTk.renderToMIDI();
            var useBackendMidi = false;
            if (verovioMidiBase64) {
              var midiBinary = atob(verovioMidiBase64);
              var midiBytes = new Uint8Array(midiBinary.length);
              for (var j = 0; j < midiBinary.length; j++) {
                midiBytes[j] = midiBinary.charCodeAt(j);
              }
              midiData = new Midi(midiBytes.buffer);
              notes = collectNotes(midiData);
              if (notes.length === 0 && uploadData.midi_base64) {
                useBackendMidi = true;
              }
            } else {
              useBackendMidi = true;
            }
            if (useBackendMidi && uploadData.midi_base64) {
              var fallbackBinary = atob(uploadData.midi_base64);
              var fallbackBytes = new Uint8Array(fallbackBinary.length);
              for (var k = 0; k < fallbackBytes.length; k++) {
                fallbackBytes[k] = fallbackBinary.charCodeAt(k);
              }
              midiData = new Midi(fallbackBytes.buffer);
              notes = collectNotes(midiData);
            }
            if (midiData) {
              totalDuration = midiData.duration;
              currentNotationPage = 1;
              hasVerovioScore = true;
              applyVerovioLayout();
              if (verovioNotation) verovioNotation.innerHTML = verovioTk.renderToSVG(1);
              /* If Verovio rendered title-only/blank (no note elements), show PDF instead */
              var svgHasNotes = verovioNotation && verovioNotation.querySelector && verovioNotation.querySelector('[class*="note"]');
              if (!svgHasNotes && pdfContainer && track.file) {
                hasVerovioScore = false;
                if (verovioNotation) verovioNotation.hidden = true;
                if (notationViewport) notationViewport.hidden = true;
                if (pdfContainer) pdfContainer.hidden = false;
                if (pdfDoc) renderPdfPage(1);
                if (notationTitle) notationTitle.textContent = "Sheet Music (PDF – notation preview unavailable)";
              } else if (pdfContainer && track.file && pdfDoc) {
                /* PDF preferred; Notation has playback highlight (red) */
                viewMode = "pdf";
                if (viewToggle) viewToggle.hidden = false;
                switchView("pdf");
              } else {
                if (pdfContainer) pdfContainer.hidden = true;
                if (notationViewport) notationViewport.hidden = false;
                if (verovioNotation) verovioNotation.hidden = false;
              }
              if (layoutSection) layoutSection.hidden = false;
              if (notationTitle && hasVerovioScore) notationTitle.textContent = "Sheet Music";
              notationSection.hidden = false;
              scoreDuration = hasVerovioScore ? getVerovioScoreDuration() : 0;
              updatePageNav();
              if (recordBtn) recordBtn.disabled = notes.length === 0;
              if (stopRecordBtn) stopRecordBtn.disabled = true;
              if (practiceHint) { practiceHint.hidden = false; practiceHint.textContent = "Record your playing and compare it to the sheet music."; }
            } else {
              throw new Error("Verovio MIDI failed");
            }
          } catch (e) {
            var fallbackBinary = atob(uploadData.midi_base64);
            var fallbackBytes = new Uint8Array(fallbackBinary.length);
            for (var k = 0; k < fallbackBytes.length; k++) {
              fallbackBytes[k] = fallbackBinary.charCodeAt(k);
            }
            midiData = new Midi(fallbackBytes.buffer);
            notes = collectNotes(midiData);
            totalDuration = midiData.duration;
            currentNotationPage = 1;
            hasVerovioScore = true;
            applyVerovioLayout();
            if (pdfContainer) pdfContainer.hidden = true;
            if (notationViewport) notationViewport.hidden = false;
            if (verovioNotation) {
              verovioNotation.innerHTML = verovioTk.renderToSVG(1);
              verovioNotation.hidden = false;
            }
            var svgHasNotes = verovioNotation && verovioNotation.querySelector && verovioNotation.querySelector('[class*="note"]');
            if (!svgHasNotes && pdfContainer && track.file) {
              hasVerovioScore = false;
              if (verovioNotation) verovioNotation.hidden = true;
              if (notationViewport) notationViewport.hidden = true;
              if (pdfContainer) pdfContainer.hidden = false;
              if (pdfDoc) renderPdfPage(1);
              if (notationTitle) notationTitle.textContent = "Sheet Music (PDF – notation preview unavailable)";
            } else if (svgHasNotes && pdfContainer && track.file && pdfDoc) {
              viewMode = "pdf";
              if (viewToggle) viewToggle.hidden = false;
              switchView("pdf");
            } else if (svgHasNotes) {
              if (pdfContainer) pdfContainer.hidden = true;
              if (notationViewport) notationViewport.hidden = false;
              if (verovioNotation) verovioNotation.hidden = false;
            }
            if (layoutSection) layoutSection.hidden = false;
            if (notationTitle && hasVerovioScore) notationTitle.textContent = "Sheet Music";
            notationSection.hidden = false;
            scoreDuration = hasVerovioScore ? getVerovioScoreDuration() : 0;
            updatePageNav();
            if (recordBtn) recordBtn.disabled = notes.length === 0;
            if (stopRecordBtn) stopRecordBtn.disabled = true;
            if (practiceHint) { practiceHint.hidden = false; practiceHint.textContent = "Record your playing and compare it to the sheet music."; }
          }
        } else {
          var fallbackBinary = atob(uploadData.midi_base64);
          var fallbackBytes = new Uint8Array(fallbackBinary.length);
          for (var k = 0; k < fallbackBytes.length; k++) {
            fallbackBytes[k] = fallbackBinary.charCodeAt(k);
          }
          midiData = new Midi(fallbackBytes.buffer);
          notes = collectNotes(midiData);
          totalDuration = midiData.duration;
          currentNotationPage = 1;
          hasVerovioScore = false;
          if (pdfContainer) pdfContainer.hidden = false;
          if (notationViewport) notationViewport.hidden = true;
          if (verovioNotation) verovioNotation.hidden = true;
          if (layoutSection) layoutSection.hidden = true;
          if (pageNavSection) pageNavSection.hidden = true;
          if (notationTitle) notationTitle.textContent = "Original Sheet Music";
          if (track.file && pdfDoc) {
            renderPdfPage(1);
          }
          notationSection.hidden = false;
          scoreDuration = 0;
          if (recordBtn) recordBtn.disabled = true;
          if (stopRecordBtn) stopRecordBtn.disabled = true;
          if (practiceHint) { practiceHint.hidden = false; practiceHint.textContent = "Practice requires sheet music. This track shows PDF only."; }
        }
        return loadInstrument();
      });
    });
  }

  function renderPlaylist() {
    if (!playlistEl) return;
    playlistEl.innerHTML = "";
    playlist.forEach(function (track) {
      var li = document.createElement("li");
      li.className = "playlist-item" + (track.id === currentTrackId ? " active" : "");
      li.dataset.trackId = track.id;
      var title = document.createElement("span");
      title.className = "playlist-item-title";
      title.textContent = track.filename;
      li.appendChild(title);
      var actions = document.createElement("div");
      actions.className = "playlist-item-actions";
      var upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "btn btn-icon";
      upBtn.title = "Move up";
      upBtn.textContent = "\u2191";
      upBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        reorderTrack(track.id, -1);
      });
      var downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "btn btn-icon";
      downBtn.title = "Move down";
      downBtn.textContent = "\u2193";
      downBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        reorderTrack(track.id, 1);
      });
      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-icon";
      delBtn.title = "Remove";
      delBtn.textContent = "\u00d7";
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        deleteTrack(track.id);
      });
      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(delBtn);
      li.appendChild(actions);
      li.addEventListener("click", function (e) {
        if (!e.target.closest(".playlist-item-actions")) {
          loadTrack(track.id);
        }
      });
      playlistEl.appendChild(li);
    });
  }

  function addToPlaylist(data, file) {
    if (playlist.length >= MAX_PLAYLIST_SIZE) {
      showError("Playlist is full. Remove a track to add more.");
      return;
    }
    var id = "track-" + (++playlistIdCounter);
    var filename = file.name.replace(/\.(pdf|png|jpg|jpeg)$/i, "");
    var track = {
      id: id,
      filename: filename,
      midiBase64: data.midi_base64,
      musicxmlBase64: data.musicxml_base64 || null,
      musicxmlFormat: data.musicxml_format || null,
      measuresPerFirstSystem: data.measures_per_first_system,
      measuresPerLine: data.measures_per_line,
      measureBoundaries: data.measure_boundaries || [],
      systemTimeRanges: data.system_time_ranges || [],
      systemRegions: data.system_regions || [],
      measureLayoutPositions: data.measure_layout_positions || [],
      measureNotePositions: data.measure_note_positions || [],
      file: file,
    };
    playlist.push(track);
    currentTrackId = playlist[0].id;
    if (playlistSection) playlistSection.hidden = false;
    renderPlaylist();
  }

  function loadTrack(id) {
    var track = playlist.find(function (t) { return t.id === id; });
    if (!track) return;
    if (isPlaying) pause();
    clearPracticeFeedback();
    currentTrackId = id;
    renderPlaylist();
    showStatus("Loading track…", "loading");
    setupTrackFromStoredData(track).then(function () {
      hideStatus();
      trackNameEl.textContent = track.filename;
      progressBar.style.width = "0%";
      var endTime = scoreDuration > 0 ? scoreDuration : totalDuration;
      progressText.textContent = "0:00 / " + formatTime(endTime);
      tempoSlider.value = "1";
      onTempoChange();
      playhead = 0;
      lastPlayedIndex = 0;
      playerSection.hidden = false;
      if (mainPlaceholder) mainPlaceholder.hidden = true;
    }).catch(function (err) {
      showError(err.message || "Failed to load track");
      hideStatus();
    });
  }

  function deleteTrack(id) {
    var idx = playlist.findIndex(function (t) { return t.id === id; });
    if (idx < 0) return;
    var wasCurrent = playlist[idx].id === currentTrackId;
    playlist.splice(idx, 1);
    if (wasCurrent) {
      if (playlist.length > 0) {
        var nextIdx = Math.min(idx, playlist.length - 1);
        loadTrack(playlist[nextIdx].id);
      } else {
        currentTrackId = null;
        if (playlistSection) playlistSection.hidden = true;
        playerSection.hidden = true;
        if (mainPlaceholder) mainPlaceholder.hidden = false;
        if (pdfBlobUrl) {
          URL.revokeObjectURL(pdfBlobUrl);
          pdfBlobUrl = null;
        }
        midiData = null;
        notes = [];
        totalDuration = 0;
      }
    } else {
      renderPlaylist();
    }
  }

  function reorderTrack(id, direction) {
    var idx = playlist.findIndex(function (t) { return t.id === id; });
    if (idx < 0) return;
    var newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= playlist.length) return;
    var tmp = playlist[idx];
    playlist[idx] = playlist[newIdx];
    playlist[newIdx] = tmp;
    renderPlaylist();
  }

  browseBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener("click", function (e) {
    if (e.target === dropzone || e.target.closest(".dropzone-content")) {
      fileInput.click();
    }
  });

  dropzone.addEventListener("dragover", function (e) {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", function () {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const files = e.dataTransfer.files;
    if (files.length) handleFile(files[0]);
  });

  fileInput.addEventListener("change", function () {
    const files = fileInput.files;
    if (files.length) handleFile(files[0]);
    fileInput.value = "";
  });

  playBtn.addEventListener("click", play);
  pauseBtn.addEventListener("click", pause);
  stopBtn.addEventListener("click", stop);
  tempoSlider.addEventListener("input", onTempoChange);

  if (recordBtn) recordBtn.addEventListener("click", startRecording);
  if (stopRecordBtn) stopRecordBtn.addEventListener("click", stopRecording);

  var progressTrack = document.getElementById("progressTrack");
  if (progressTrack) {
    progressTrack.addEventListener("click", handleProgressSeek);
    progressTrack.addEventListener("mousedown", function (e) {
      e.preventDefault();
      handleProgressSeek(e);
      function onMove(ev) {
        handleProgressSeek(ev);
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  if (measuresPerLineSelect) {
    measuresPerLineSelect.addEventListener("change", function () {
      measuresPerLineMultiplier = parseInt(measuresPerLineSelect.value, 10);
      if (verovioTk && hasVerovioScore) {
        applyVerovioLayout();
        if (verovioNotation) {
          verovioNotation.innerHTML = verovioTk.renderToSVG(currentNotationPage);
        }
        updatePageNav();
      }
    });
  }

  if (prevPageBtn) prevPageBtn.addEventListener("click", function () { goToPage(currentNotationPage - 1); });
  if (nextPageBtn) nextPageBtn.addEventListener("click", function () { goToPage(currentNotationPage + 1); });
  if (viewPdfBtn) viewPdfBtn.addEventListener("click", function () { switchView("pdf"); });
  if (viewNotationBtn) viewNotationBtn.addEventListener("click", function () { switchView("notation"); });

  // Check backend on load (read body once to avoid "stream already read" error)
  fetch((API_URL || window.location.origin) + "/health")
    .then(function (r) { return r.text().then(function (t) { return JSON.parse(t); }); })
    .then(function (data) {
      var hasEngine = data.omr_audiveris === true || data.omr_homr === true || data.omr_oemer === true;
      if (!hasEngine) {
        showError("No OMR engine found. Install HOMR (pip install homr), oemer (./install_oemer.sh), or Audiveris (https://audiveris.com/).");
      } else if (engineSelector) {
        engineSelector.hidden = false;
        // Hide engine options that are not installed
        var opts = omrEngineSelect ? omrEngineSelect.options : [];
        for (var i = 0; i < opts.length; i++) {
          var v = opts[i].value;
          if (v === "") continue;
          opts[i].hidden = v === "homr" && !data.omr_homr || v === "oemer" && !data.omr_oemer || v === "audiveris" && !data.omr_audiveris;
        }
        // Default to Audiveris when available
        if (omrEngineSelect && data.omr_audiveris === true) {
          omrEngineSelect.value = "";
        } else if (omrEngineSelect && data.omr_homr === true) {
          omrEngineSelect.value = "homr";
        } else if (omrEngineSelect && data.omr_oemer === true) {
          omrEngineSelect.value = "oemer";
        }
      }
    })
    .catch(function () {
      showError("Cannot reach the backend. Start it with: cd backend && python -m uvicorn main:app --port 8000");
    });

  function pollUploadStatus(jobId, file, pollInterval) {
    var baseUrl = API_URL || window.location.origin;
    pollInterval = pollInterval || 800;
    function poll() {
      return fetch(baseUrl + "/upload/status/" + jobId)
        .then(function (r) {
          if (!r.ok) {
            if (r.status === 404) {
              throw new Error("Job not found. The server may have restarted. Please try uploading again.");
            }
            return r.json()
              .then(function (body) { throw new Error(body.detail || body.error || r.statusText || "Upload status check failed"); })
              .catch(function () { throw new Error(r.statusText || "Upload status check failed"); });
          }
          return r.json();
        })
        .then(function (data) {
          var msg = data.message || "Processing…";
          showStatus(msg, "loading");
          if (mainPlaceholder) {
            mainPlaceholder.textContent = msg + " (this may take a few minutes)";
            mainPlaceholder.hidden = false;
          }
          if (data.status === "complete" && data.result) {
            return data.result;
          }
          if (data.status === "error") {
            throw new Error(data.error || "Upload failed");
          }
          return new Promise(function (resolve, reject) {
            setTimeout(function () {
              poll().then(resolve).catch(reject);
            }, pollInterval);
          });
        });
    }
    return poll();
  }

  function handleFile(file) {
    var ext = file.name.toLowerCase().split(".").pop();
    if (!/^(pdf|png|jpg|jpeg)$/.test(ext)) {
      showError("Please select a PDF or image file (PNG, JPG).");
      return;
    }

    if (pdfBlobUrl) {
      URL.revokeObjectURL(pdfBlobUrl);
      pdfBlobUrl = null;
    }

    hideError();
    showStatus("Uploading file…", "loading");
    playerSection.hidden = true;
    if (mainPlaceholder) {
      mainPlaceholder.textContent = "Uploading file…";
      mainPlaceholder.hidden = false;
    }

    var baseUrl = API_URL || window.location.origin;
    var formData = new FormData();
    formData.append("file", file);
    var engine = omrEngineSelect ? omrEngineSelect.value : "";
    if (engine) formData.append("engine", engine);

    fetch(baseUrl + "/upload", {
      method: "POST",
      body: formData,
    })
      .then(function (res) {
        return res.text().then(function (t) {
          if (!res.ok) {
            var msg = res.statusText || "Upload failed";
            try {
              var body = JSON.parse(t);
              var detail = body.detail;
              if (Array.isArray(detail) && detail[0] && detail[0].msg) {
                msg = detail[0].msg;
              } else if (typeof detail === "string") {
                msg = detail;
              } else if (detail) {
                msg = String(detail);
              } else if (t) {
                msg = t;
              }
            } catch (e) {
              if (t) msg = t;
            }
            throw new Error(msg);
          }
          return JSON.parse(t);
        });
      })
      .then(function (data) {
        var jobId = data.job_id;
        if (!jobId) {
          throw new Error("Invalid response from server");
        }
        return pollUploadStatus(jobId, file, 800);
      })
      .then(function (data) {
        if (!data.success || !data.midi_base64) {
          throw new Error("Invalid response from server");
        }
        if (data.musicxml_path) {
          console.log("MusicXML saved at:", data.musicxml_path);
        }
        showStatus("Ready to play! Loading Euphonium sound…", "loading");
        var track = {
          id: null,
          filename: file.name.replace(/\.(pdf|png|jpg|jpeg)$/i, ""),
          midiBase64: data.midi_base64,
          musicxmlBase64: data.musicxml_base64 || null,
          musicxmlFormat: data.musicxml_format || null,
          measuresPerFirstSystem: data.measures_per_first_system,
          measuresPerLine: data.measures_per_line,
          measureBoundaries: data.measure_boundaries || [],
          systemTimeRanges: data.system_time_ranges || [],
          systemRegions: data.system_regions || [],
          measureLayoutPositions: data.measure_layout_positions || [],
          measureNotePositions: data.measure_note_positions || [],
          file: file,
        };
        return setupTrackFromStoredData(track).then(function () { return data; });
      })
      .then(function (data) {
        if (notes.length === 0) {
          throw new Error("No notes found in the sheet music. The PDF may not have been recognized correctly. Try a different OMR engine (Audiveris, HOMR, oemer) or use a clearer, higher-resolution image.");
        }
        addToPlaylist(data, file);
        if (playlist.length === 1) {
          hideStatus();
          trackNameEl.textContent = playlist[0].filename;
          progressBar.style.width = "0%";
          var endTime = scoreDuration > 0 ? scoreDuration : totalDuration;
          progressText.textContent = "0:00 / " + formatTime(endTime);
          tempoSlider.value = "1";
          onTempoChange();
          playhead = 0;
          lastPlayedIndex = 0;
          playerSection.hidden = false;
          if (mainPlaceholder) mainPlaceholder.hidden = true;
        } else {
          loadTrack(playlist[0].id);
        }
      })
      .catch(function (err) {
        if (pdfBlobUrl) {
          URL.revokeObjectURL(pdfBlobUrl);
          pdfBlobUrl = null;
        }
        var msg = err.message || "Something went wrong.";
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
          msg = "Could not reach the server. Make sure the backend is running (python -m uvicorn main:app --reload).";
        } else if (msg.includes("body stream already read") || msg.includes("already read")) {
          msg = "Audio loading error. Try refreshing the page, or use Chrome/Firefox. If it persists, the soundfont CDN may be blocked.";
        }
        showError(msg);
        hideStatus();
        if (playlist.length > 0) {
          playerSection.hidden = false;
          if (mainPlaceholder) mainPlaceholder.hidden = true;
        } else if (mainPlaceholder) {
          mainPlaceholder.textContent = "Upload a PDF to get started";
        }
      });
  }
})();
