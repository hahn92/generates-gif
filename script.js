(() => {
    'use strict';

    const MAX_OUTPUT = 1024;

    // Build the worker URL from the embedded source so generation works under
    // both http(s):// and file:// (Worker construction from a file:// URL is
    // blocked because that origin is treated as `null`; a blob URL avoids it).
    const GIF_WORKER_URL = (() => {
        const src = window.GIF_WORKER_SOURCE;
        if (typeof src !== 'string' || !src.length) return null;
        return URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    })();

    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const frameList = document.getElementById('frame-list');
    const frameActions = document.getElementById('frame-actions');
    const frameCount = document.getElementById('frame-count');
    const clearBtn = document.getElementById('clear-btn');

    const delayInput = document.getElementById('delay-input');
    const qualityInput = document.getElementById('quality-input');
    const qualityOutput = document.getElementById('quality-output');
    const loopInput = document.getElementById('loop-input');
    const bgInput = document.getElementById('bg-input');
    const sizeInput = document.getElementById('size-input');
    const customSizeControl = document.getElementById('custom-size-control');
    const customW = document.getElementById('custom-w');
    const customH = document.getElementById('custom-h');

    const generateBtn = document.getElementById('generate-btn');
    const statusEl = document.getElementById('status');
    const statusMessage = document.getElementById('status-message');
    const progressBar = document.getElementById('progress-bar');
    const errorEl = document.getElementById('error');

    const output = document.getElementById('output');
    const outputPreview = document.getElementById('output-preview');
    const outputSize = document.getElementById('output-size');
    const downloadLink = document.getElementById('download-link');

    const modal = document.getElementById('editor-modal');
    const editorCanvas = document.getElementById('editor-canvas');
    const editorCtx = editorCanvas.getContext('2d');
    const zoomInput = document.getElementById('zoom-input');
    const editorReset = document.getElementById('editor-reset');
    const editorSave = document.getElementById('editor-save');

    /**
     * @typedef {Object} Frame
     * @property {number} id
     * @property {File} file
     * @property {string} url
     * @property {HTMLImageElement} image
     * @property {{srcX:number, srcY:number, srcW:number, srcH:number}} crop
     * @property {boolean} edited - true if user manually adjusted the crop
     */
    /** @type {Frame[]} */
    let frames = [];
    let frameIdCounter = 0;
    let lastBlobUrl = null;
    let lastOutputAspect = null;

    let editingFrame = null;
    let editorState = null;

    // ----- UI bindings -----

    qualityInput.addEventListener('input', () => {
        qualityOutput.textContent = qualityInput.value;
    });

    sizeInput.addEventListener('change', () => {
        customSizeControl.hidden = sizeInput.value !== 'custom';
        onOutputSizeChanged();
    });

    [customW, customH].forEach((el) => {
        el.addEventListener('change', onOutputSizeChanged);
    });

    bgInput.addEventListener('change', renderFrames);

    fileInput.addEventListener('change', (e) => {
        addFiles(e.target.files);
        fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach((evt) => {
        dropZone.addEventListener(evt, (e) => {
            e.preventDefault();
            dropZone.classList.add('drop-zone--active');
        });
    });

    ['dragleave', 'drop'].forEach((evt) => {
        dropZone.addEventListener(evt, (e) => {
            e.preventDefault();
            dropZone.classList.remove('drop-zone--active');
        });
    });

    dropZone.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files.length) {
            addFiles(e.dataTransfer.files);
        }
    });

    clearBtn.addEventListener('click', () => {
        frames.forEach((f) => URL.revokeObjectURL(f.url));
        frames = [];
        renderFrames();
        clearError();
    });

    generateBtn.addEventListener('click', generate);

    // ----- Output sizing -----

    function computeOutputSize() {
        const mode = sizeInput.value;
        let width, height;

        if (mode === 'custom') {
            width = clamp(parseInt(customW.value, 10) || 600, 32, 2048);
            height = clamp(parseInt(customH.value, 10) || 600, 32, 2048);
            return makeEven(width, height);
        }

        let maxW = 0, maxH = 0;
        for (const f of frames) {
            if (f.image.naturalWidth > maxW) maxW = f.image.naturalWidth;
            if (f.image.naturalHeight > maxH) maxH = f.image.naturalHeight;
        }
        if (!maxW || !maxH) { maxW = 600; maxH = 600; }

        if (mode === 'auto') {
            width = maxW; height = maxH;
        } else if (mode === 'square') {
            const side = Math.max(maxW, maxH);
            width = side; height = side;
        } else if (mode === 'landscape') {
            const base = Math.max(maxW, maxH);
            width = base;
            height = Math.round(base * 9 / 16);
        } else if (mode === 'portrait') {
            const base = Math.max(maxW, maxH);
            width = Math.round(base * 9 / 16);
            height = base;
        }

        if (width > MAX_OUTPUT || height > MAX_OUTPUT) {
            const scale = MAX_OUTPUT / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }
        return makeEven(width, height);
    }

    function makeEven(w, h) {
        return {
            width: Math.max(2, w - (w % 2)),
            height: Math.max(2, h - (h % 2)),
        };
    }

    function onOutputSizeChanged() {
        const { width, height } = computeOutputSize();
        const newAspect = width / height;
        if (lastOutputAspect && Math.abs(newAspect - lastOutputAspect) > 0.001) {
            // Adapt every existing crop to the new aspect (preserve center).
            for (const f of frames) {
                f.crop = adjustCropAspect(f.crop, newAspect);
            }
        }
        lastOutputAspect = newAspect;
        renderFrames();
    }

    // ----- Crop helpers (source-rect representation) -----

    function defaultCoverCrop(image, canvasAspect) {
        const iw = image.naturalWidth;
        const ih = image.naturalHeight;
        const iAspect = iw / ih;
        let srcW, srcH;
        if (iAspect > canvasAspect) {
            srcH = ih;
            srcW = srcH * canvasAspect;
        } else {
            srcW = iw;
            srcH = srcW / canvasAspect;
        }
        return {
            srcX: (iw - srcW) / 2,
            srcY: (ih - srcH) / 2,
            srcW,
            srcH,
        };
    }

    function adjustCropAspect(crop, newAspect) {
        const cx = crop.srcX + crop.srcW / 2;
        const cy = crop.srcY + crop.srcH / 2;
        const oldAspect = crop.srcW / crop.srcH;
        let srcW = crop.srcW;
        let srcH = crop.srcH;
        if (newAspect > oldAspect) {
            srcH = srcW / newAspect;
        } else {
            srcW = srcH * newAspect;
        }
        return {
            srcX: cx - srcW / 2,
            srcY: cy - srcH / 2,
            srcW,
            srcH,
        };
    }

    function drawCrop(ctx, image, crop, canvasW, canvasH) {
        const { srcX, srcY, srcW, srcH } = crop;
        // Intersect crop with image bounds so we never pass negative source coords to drawImage.
        const ix1 = Math.max(0, srcX);
        const iy1 = Math.max(0, srcY);
        const ix2 = Math.min(image.naturalWidth, srcX + srcW);
        const iy2 = Math.min(image.naturalHeight, srcY + srcH);
        if (ix1 >= ix2 || iy1 >= iy2) return;
        const sx = ix1, sy = iy1;
        const sw = ix2 - ix1;
        const sh = iy2 - iy1;
        const scaleX = canvasW / srcW;
        const scaleY = canvasH / srcH;
        const dx = (ix1 - srcX) * scaleX;
        const dy = (iy1 - srcY) * scaleY;
        const dw = sw * scaleX;
        const dh = sh * scaleY;
        ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
    }

    function drawFrame(ctx, frame, canvasW, canvasH, bgColor) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvasW, canvasH);
        drawCrop(ctx, frame.image, frame.crop, canvasW, canvasH);
    }

    // ----- File handling -----

    async function addFiles(fileList) {
        clearError();
        const images = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
        if (!images.length) {
            showError('No image files were selected.');
            return;
        }

        for (const file of images) {
            const url = URL.createObjectURL(file);
            try {
                const image = await loadImage(url);
                // Compute output size after this frame is added so aspect reflects new sources.
                const tempFrames = frames.concat([{ image }]);
                const aspect = computeAspectFromFrames(tempFrames);
                frames.push({
                    id: frameIdCounter++,
                    file,
                    url,
                    image,
                    crop: defaultCoverCrop(image, aspect),
                    edited: false,
                });
            } catch (err) {
                URL.revokeObjectURL(url);
                console.warn('Failed to load image:', file.name, err);
            }
        }

        // After upload, update aspect tracking and refit any unedited frames if aspect changed.
        const { width, height } = computeOutputSize();
        const aspect = width / height;
        if (lastOutputAspect && Math.abs(aspect - lastOutputAspect) > 0.001) {
            for (const f of frames) {
                if (!f.edited) f.crop = defaultCoverCrop(f.image, aspect);
                else f.crop = adjustCropAspect(f.crop, aspect);
            }
        }
        lastOutputAspect = aspect;
        renderFrames();
    }

    function computeAspectFromFrames(frameItems) {
        const mode = sizeInput.value;
        if (mode === 'custom') {
            return clamp(parseInt(customW.value, 10) || 600, 32, 2048) /
                   clamp(parseInt(customH.value, 10) || 600, 32, 2048);
        }
        let maxW = 0, maxH = 0;
        for (const f of frameItems) {
            if (f.image.naturalWidth > maxW) maxW = f.image.naturalWidth;
            if (f.image.naturalHeight > maxH) maxH = f.image.naturalHeight;
        }
        if (!maxW || !maxH) return 1;
        if (mode === 'auto') return maxW / maxH;
        if (mode === 'square') return 1;
        if (mode === 'landscape') return 16 / 9;
        if (mode === 'portrait') return 9 / 16;
        return 1;
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to decode image'));
            img.src = src;
        });
    }

    function renderFrames() {
        frameList.replaceChildren();
        const { width: outW, height: outH } = computeOutputSize();
        const bgColor = bgInput.value;

        frames.forEach((frame, index) => {
            const item = document.createElement('div');
            item.className = 'frame';
            if (frame.edited) item.classList.add('frame--edited');

            // Render the actual cropped result into a thumbnail canvas so the
            // user sees exactly what the GIF will contain.
            const thumb = document.createElement('canvas');
            const tw = 160;
            const th = Math.round(tw * outH / outW);
            thumb.width = tw;
            thumb.height = th;
            const tctx = thumb.getContext('2d');
            tctx.fillStyle = bgColor;
            tctx.fillRect(0, 0, tw, th);
            drawCrop(tctx, frame.image, frame.crop, tw, th);
            thumb.setAttribute('aria-label', `Frame ${index + 1}: ${frame.file.name}`);

            const idx = document.createElement('span');
            idx.className = 'frame__index';
            idx.textContent = String(index + 1);

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'frame__edit';
            editBtn.setAttribute('aria-label', `Adjust frame ${index + 1}`);
            editBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>Edit';
            editBtn.addEventListener('click', () => openEditor(frame.id));

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'frame__remove';
            remove.setAttribute('aria-label', `Remove frame ${index + 1}`);
            remove.textContent = '×';
            remove.addEventListener('click', (e) => {
                e.stopPropagation();
                removeFrame(frame.id);
            });

            item.append(thumb, idx, editBtn, remove);
            frameList.append(item);
        });

        const has = frames.length > 0;
        frameActions.hidden = !has;
        frameCount.textContent = `${frames.length} frame${frames.length === 1 ? '' : 's'}`;
        generateBtn.disabled = frames.length < 1;
    }

    function removeFrame(id) {
        const idx = frames.findIndex((f) => f.id === id);
        if (idx === -1) return;
        URL.revokeObjectURL(frames[idx].url);
        frames.splice(idx, 1);
        renderFrames();
    }

    function showError(message) {
        errorEl.textContent = message;
        errorEl.hidden = false;
    }

    function clearError() {
        errorEl.textContent = '';
        errorEl.hidden = true;
    }

    function setBusy(busy, message = '') {
        statusEl.hidden = !busy;
        statusMessage.textContent = message;
        if (!busy) progressBar.style.width = '0%';
        generateBtn.disabled = busy || frames.length < 1;
        clearBtn.disabled = busy;
    }

    // ----- Editor modal -----

    function openEditor(frameId) {
        const frame = frames.find((f) => f.id === frameId);
        if (!frame) return;
        editingFrame = frame;

        const { width, height } = computeOutputSize();
        const iw = frame.image.naturalWidth;
        const ih = frame.image.naturalHeight;

        // Convert source-rect crop into an interactive (scale, dx, dy) representation.
        // crop.srcW maps to canvasW, so scale = canvasW / crop.srcW.
        const scale = width / frame.crop.srcW;
        // imageOriginX (canvas px) = -crop.srcX * scale
        // and imageOriginX = (canvasW - iw*scale)/2 + dx, therefore:
        const dx = -frame.crop.srcX * scale - (width - iw * scale) / 2;
        const dy = -frame.crop.srcY * scale - (height - ih * scale) / 2;

        // Cover-fit baseline used for "Reset" and as the slider's reference value.
        const coverScale = Math.max(width / iw, height / ih);

        editorState = {
            canvasW: width,
            canvasH: height,
            iw,
            ih,
            coverScale,
            scale,
            dx,
            dy,
            dragging: false,
            lastX: 0,
            lastY: 0,
            displayScale: 1,
        };

        modal.hidden = false;
        document.body.style.overflow = 'hidden';
        sizeEditorCanvas();
        zoomInput.min = String((coverScale * 0.5).toFixed(4));
        zoomInput.max = String((coverScale * 4).toFixed(4));
        zoomInput.step = String((coverScale / 100).toFixed(4));
        zoomInput.value = String(scale);
        drawEditor();
    }

    function sizeEditorCanvas() {
        const stage = document.getElementById('editor-stage');
        const stageRect = stage.getBoundingClientRect();
        const maxW = stageRect.width || 480;
        const maxH = stageRect.height || 480;
        const ratio = editorState.canvasW / editorState.canvasH;
        let dispW = maxW;
        let dispH = maxW / ratio;
        if (dispH > maxH) {
            dispH = maxH;
            dispW = maxH * ratio;
        }
        editorCanvas.style.width = `${dispW}px`;
        editorCanvas.style.height = `${dispH}px`;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        editorCanvas.width = Math.round(dispW * dpr);
        editorCanvas.height = Math.round(dispH * dpr);
        editorState.displayScale = editorCanvas.width / editorState.canvasW;
    }

    function drawEditor() {
        const s = editorState;
        if (!s || !editingFrame) return;
        const bg = bgInput.value;

        editorCtx.setTransform(1, 0, 0, 1, 0, 0);
        editorCtx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
        editorCtx.scale(s.displayScale, s.displayScale);

        editorCtx.fillStyle = bg;
        editorCtx.fillRect(0, 0, s.canvasW, s.canvasH);

        const w = s.iw * s.scale;
        const h = s.ih * s.scale;
        const x = (s.canvasW - w) / 2 + s.dx;
        const y = (s.canvasH - h) / 2 + s.dy;
        editorCtx.drawImage(editingFrame.image, x, y, w, h);

        // Crop guide outline
        editorCtx.strokeStyle = 'rgba(91, 108, 255, 0.85)';
        editorCtx.lineWidth = 2 / s.displayScale;
        editorCtx.strokeRect(1, 1, s.canvasW - 2, s.canvasH - 2);
    }

    editorCanvas.addEventListener('pointerdown', (e) => {
        if (!editorState) return;
        editorState.dragging = true;
        editorState.lastX = e.clientX;
        editorState.lastY = e.clientY;
        editorCanvas.setPointerCapture(e.pointerId);
    });

    editorCanvas.addEventListener('pointermove', (e) => {
        if (!editorState || !editorState.dragging) return;
        const rect = editorCanvas.getBoundingClientRect();
        const ratioX = editorState.canvasW / rect.width;
        const ratioY = editorState.canvasH / rect.height;
        editorState.dx += (e.clientX - editorState.lastX) * ratioX;
        editorState.dy += (e.clientY - editorState.lastY) * ratioY;
        editorState.lastX = e.clientX;
        editorState.lastY = e.clientY;
        drawEditor();
    });

    editorCanvas.addEventListener('pointerup', (e) => {
        if (!editorState) return;
        editorState.dragging = false;
        try { editorCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
    });

    editorCanvas.addEventListener('wheel', (e) => {
        if (!editorState) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const min = parseFloat(zoomInput.min);
        const max = parseFloat(zoomInput.max);
        editorState.scale = clamp(editorState.scale * factor, min, max);
        zoomInput.value = String(editorState.scale);
        drawEditor();
    }, { passive: false });

    zoomInput.addEventListener('input', () => {
        if (!editorState) return;
        editorState.scale = parseFloat(zoomInput.value);
        drawEditor();
    });

    editorReset.addEventListener('click', () => {
        if (!editorState) return;
        editorState.scale = editorState.coverScale;
        editorState.dx = 0;
        editorState.dy = 0;
        zoomInput.value = String(editorState.coverScale);
        drawEditor();
    });

    editorSave.addEventListener('click', () => {
        if (!editingFrame || !editorState) return;
        const s = editorState;
        // Derive the source rectangle currently mapped to the canvas viewport.
        const imgOriginX = (s.canvasW - s.iw * s.scale) / 2 + s.dx;
        const imgOriginY = (s.canvasH - s.ih * s.scale) / 2 + s.dy;
        editingFrame.crop = {
            srcX: -imgOriginX / s.scale,
            srcY: -imgOriginY / s.scale,
            srcW: s.canvasW / s.scale,
            srcH: s.canvasH / s.scale,
        };
        editingFrame.edited = true;
        closeEditor();
        renderFrames();
    });

    modal.addEventListener('click', (e) => {
        if (e.target.dataset && 'close' in e.target.dataset) closeEditor();
    });

    document.addEventListener('keydown', (e) => {
        if (!modal.hidden && e.key === 'Escape') closeEditor();
    });

    function closeEditor() {
        modal.hidden = true;
        document.body.style.overflow = '';
        editingFrame = null;
        editorState = null;
    }

    // ----- Generation -----

    function generate() {
        clearError();
        if (!frames.length) {
            showError('Please add at least one image.');
            return;
        }
        if (typeof window.GIF !== 'function') {
            showError('GIF encoder failed to load. Please refresh the page.');
            return;
        }
        if (!GIF_WORKER_URL) {
            showError('GIF worker source missing. Please refresh the page.');
            return;
        }

        const delay = clamp(parseInt(delayInput.value, 10) || 200, 20, 60000);
        const quality = clamp(parseInt(qualityInput.value, 10) || 10, 1, 30);
        const repeat = parseInt(loopInput.value, 10);
        const bgColor = bgInput.value;
        const { width, height } = computeOutputSize();

        if (lastBlobUrl) {
            URL.revokeObjectURL(lastBlobUrl);
            lastBlobUrl = null;
        }
        output.hidden = true;

        setBusy(true, 'Adding frames…');

        const gif = new window.GIF({
            workers: 2,
            quality,
            width,
            height,
            workerScript: GIF_WORKER_URL,
            repeat,
            transparent: null,
            background: bgColor,
        });

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        for (const frame of frames) {
            drawFrame(ctx, frame, width, height, bgColor);
            gif.addFrame(ctx, { copy: true, delay });
        }

        gif.on('progress', (p) => {
            const pct = Math.round(p * 100);
            statusMessage.textContent = `Encoding GIF… ${pct}%`;
            progressBar.style.width = `${pct}%`;
        });

        gif.on('finished', (blob) => {
            const url = URL.createObjectURL(blob);
            lastBlobUrl = url;
            outputPreview.src = url;
            downloadLink.href = url;
            downloadLink.download = `animation-${Date.now()}.gif`;
            outputSize.textContent = `${width} × ${height} • ${formatBytes(blob.size)}`;
            output.hidden = false;
            setBusy(false);
            output.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });

        gif.on('abort', () => {
            setBusy(false);
            showError('GIF generation was aborted.');
        });

        try {
            statusMessage.textContent = 'Encoding GIF…';
            gif.render();
        } catch (err) {
            console.error(err);
            setBusy(false);
            showError(`Failed to start encoder: ${err.message}`);
        }
    }

    // ----- Helpers -----

    function clamp(n, min, max) {
        return Math.min(max, Math.max(min, n));
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    window.addEventListener('beforeunload', () => {
        frames.forEach((f) => URL.revokeObjectURL(f.url));
        if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
    });
})();
