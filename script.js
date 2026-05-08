(() => {
    'use strict';

    const GIF_WORKER_URL = 'vendor/gif.worker.js';

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

    const generateBtn = document.getElementById('generate-btn');
    const statusEl = document.getElementById('status');
    const statusMessage = document.getElementById('status-message');
    const progressBar = document.getElementById('progress-bar');
    const errorEl = document.getElementById('error');

    const output = document.getElementById('output');
    const outputPreview = document.getElementById('output-preview');
    const outputSize = document.getElementById('output-size');
    const downloadLink = document.getElementById('download-link');

    /** @type {{id: number, file: File, url: string, image: HTMLImageElement}[]} */
    let frames = [];
    let frameIdCounter = 0;
    let lastBlobUrl = null;

    qualityInput.addEventListener('input', () => {
        qualityOutput.textContent = qualityInput.value;
    });

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
                frames.push({
                    id: frameIdCounter++,
                    file,
                    url,
                    image,
                });
            } catch (err) {
                URL.revokeObjectURL(url);
                console.warn('Failed to load image:', file.name, err);
            }
        }
        renderFrames();
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
        frames.forEach((frame, index) => {
            const item = document.createElement('div');
            item.className = 'frame';

            const img = document.createElement('img');
            img.src = frame.url;
            img.alt = `Frame ${index + 1}: ${frame.file.name}`;

            const idx = document.createElement('span');
            idx.className = 'frame__index';
            idx.textContent = String(index + 1);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'frame__remove';
            remove.setAttribute('aria-label', `Remove frame ${index + 1}`);
            remove.textContent = '×';
            remove.addEventListener('click', () => removeFrame(frame.id));

            item.append(img, idx, remove);
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

    function generate() {
        clearError();
        if (!frames.length) {
            showError('Please add at least one image.');
            return;
        }
        if (typeof window.GIF !== 'function') {
            showError('GIF encoder failed to load. Please check your connection and refresh.');
            return;
        }

        const delay = clamp(parseInt(delayInput.value, 10) || 200, 20, 60000);
        const quality = clamp(parseInt(qualityInput.value, 10) || 10, 1, 30);
        const repeat = parseInt(loopInput.value, 10);

        const { width, height } = computeOutputSize(frames);

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
        });

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        for (const frame of frames) {
            ctx.clearRect(0, 0, width, height);
            drawContained(ctx, frame.image, width, height);
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

    function computeOutputSize(frameItems) {
        let width = 0;
        let height = 0;
        for (const f of frameItems) {
            if (f.image.naturalWidth > width) width = f.image.naturalWidth;
            if (f.image.naturalHeight > height) height = f.image.naturalHeight;
        }
        const MAX = 1024;
        if (width > MAX || height > MAX) {
            const scale = MAX / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }
        return { width, height };
    }

    function drawContained(ctx, image, targetW, targetH) {
        const iw = image.naturalWidth;
        const ih = image.naturalHeight;
        const scale = Math.min(targetW / iw, targetH / ih);
        const w = iw * scale;
        const h = ih * scale;
        const x = (targetW - w) / 2;
        const y = (targetH - h) / 2;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.drawImage(image, x, y, w, h);
    }

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
