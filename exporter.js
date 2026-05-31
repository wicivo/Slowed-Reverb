/* ==========================================================================
   SLO-FI STUDIO - OFFLINE AUDIO RENDERER & MP3/WAV EXPORTER
   ========================================================================== */

// 1. Web Worker Code as string (Self-Contained Inline Web Worker for absolute reliability)
const mp3WorkerCode = `
importScripts('https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js');

self.onmessage = function(e) {
    const { leftChannel, rightChannel, sampleRate, kbps } = e.data;
    
    // Check if lamejs is loaded correctly
    if (typeof lamejs === 'undefined') {
        self.postMessage({ type: 'error', message: 'Failed to load MP3 encoder library inside background worker.' });
        return;
    }

    try {
        const mp3encoder = new lamejs.Mp3Encoder(2, sampleRate, kbps || 320);
        const mp3Data = [];
        const sampleBlockSize = 1152; // LAME standard block size
        
        // Convert Float32Array to Int16Array PCM
        function floatTo16BitPCM(input) {
            const output = new Int16Array(input.length);
            for (let i = 0; i < input.length; i++) {
                let s = Math.max(-1, Math.min(1, input[i]));
                output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            return output;
        }

        self.postMessage({ type: 'status', message: 'Converting audio data to 16-bit PCM...' });
        const leftPCM = floatTo16BitPCM(leftChannel);
        const rightPCM = floatTo16BitPCM(rightChannel);
        const length = leftPCM.length;
        
        self.postMessage({ type: 'status', message: 'Encoding MP3 stream (320kbps)...' });
        let processed = 0;
        
        for (let i = 0; i < length; i += sampleBlockSize) {
            const leftChunk = leftPCM.subarray(i, i + sampleBlockSize);
            const rightChunk = rightPCM.subarray(i, i + sampleBlockSize);
            
            const mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
            if (mp3buf.length > 0) {
                mp3Data.push(new Uint8Array(mp3buf));
            }
            
            processed += leftChunk.length;
            const progress = Math.round((processed / length) * 100);
            
            // Limit progress callbacks to avoid blocking main thread communication
            if (progress % 2 === 0 || progress === 100) {
                self.postMessage({ type: 'progress', progress: progress });
            }
        }
        
        self.postMessage({ type: 'status', message: 'Flushing encoder cache...' });
        const mp3buf = mp3encoder.flush();
        if (mp3buf.length > 0) {
            mp3Data.push(new Uint8Array(mp3buf));
        }
        
        self.postMessage({ type: 'complete', data: mp3Data });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.toString() });
    }
};
`;

class SloFiExporter {
    constructor() {
        this.isRendering = false;
        this.activeWorker = null;
        
        // Get progress DOM elements
        this.overlay = document.getElementById('render-overlay');
        this.statusText = document.getElementById('render-status');
        this.percentageText = document.getElementById('render-percentage');
        this.circleFill = document.getElementById('render-progress-circle');
        this.elapsedText = document.getElementById('render-time-elapsed');
        this.btnCancel = document.getElementById('btn-cancel-render');
        
        // Progress SVG Ring setup
        // Circumference is 2 * PI * r = 2 * Math.PI * 50 = 314.16
        this.ringCircumference = 314.16;

        this.btnCancel.addEventListener('click', () => this.cancelRendering());
    }

    updateProgress(percent, statusMsg) {
        if (statusMsg) this.statusText.innerText = statusMsg;
        this.percentageText.innerText = `${percent}%`;
        
        const offset = this.ringCircumference - (percent / 100) * this.ringCircumference;
        this.circleFill.style.strokeDashoffset = offset;
    }

    showOverlay() {
        this.overlay.classList.remove('hidden');
        this.startTime = Date.now();
        this.updateProgress(0, 'Initializing audio export...');
        
        this.timerInterval = setInterval(() => {
            const elapsed = Math.round((Date.now() - this.startTime) / 1000);
            this.elapsedText.innerText = `Time elapsed: ${elapsed}s`;
        }, 1000);
    }

    hideOverlay() {
        this.overlay.classList.add('hidden');
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    cancelRendering() {
        if (this.activeWorker) {
            this.activeWorker.terminate();
            this.activeWorker = null;
        }
        this.isRendering = false;
        this.hideOverlay();
        document.getElementById('app-status').classList.add('active');
        document.getElementById('app-status').querySelector('.status-text').innerText = 'Export Canceled';
    }

    // Dynamic Programmatic Impulse Response for Offline Rendering
    createOfflineReverbIR(offlineCtx, duration, decay) {
        const sampleRate = offlineCtx.sampleRate;
        const length = sampleRate * duration;
        const impulse = offlineCtx.createBuffer(2, length, sampleRate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);
        
        let lastLeft = 0;
        let lastRight = 0;
        
        for (let i = 0; i < length; i++) {
            const percent = i / length;
            const envelope = Math.pow(1 - percent, decay);
            
            const noiseLeft = (Math.random() * 2 - 1) * envelope;
            const noiseRight = (Math.random() * 2 - 1) * envelope;
            
            // Warm muffle filtering
            left[i] = lastLeft + 0.15 * (noiseLeft - lastLeft);
            right[i] = lastRight + 0.15 * (noiseRight - lastRight);
            
            lastLeft = left[i];
            lastRight = right[i];
        }
        return impulse;
    }

    async renderAndExport(sourceBuffer, settings, format) {
        if (this.isRendering) return;
        this.isRendering = true;
        this.showOverlay();

        // 1. Prepare Offline Context
        // Compute final duration of active song section (slowedDuration = originalActiveDuration / speed)
        const speed = settings.speed;
        const isTrimmed = settings.isTrimEnabled;
        const startSecs = isTrimmed ? settings.trimStart : 0;
        const endSecs = isTrimmed ? settings.trimEnd : sourceBuffer.duration;
        const originalActiveDuration = endSecs - startSecs;

        const targetDuration = originalActiveDuration / speed;
        const sampleRate = sourceBuffer.sampleRate;
        const lengthSamples = Math.floor(targetDuration * sampleRate);

        this.updateProgress(5, 'Building offline AudioContext graph...');

        try {
            const offlineCtx = new OfflineAudioContext(2, lengthSamples, sampleRate);

            // Rebuild the full audio processing graph in offline context
            const sourceNode = offlineCtx.createBufferSource();
            sourceNode.buffer = sourceBuffer;
            sourceNode.playbackRate.value = speed;

            // Bass Boost Node
            const bassNode = offlineCtx.createBiquadFilter();
            bassNode.type = 'lowshelf';
            bassNode.frequency.value = 150;
            bassNode.gain.value = settings.bass;

            // Lowpass Cozy Filter Node
            const lowpassNode = offlineCtx.createBiquadFilter();
            lowpassNode.type = 'lowpass';
            lowpassNode.frequency.value = settings.muffle;

            // Reverb Sub-Graph
            const dryGain = offlineCtx.createGain();
            const wetGain = offlineCtx.createGain();
            const convolver = offlineCtx.createConvolver();

            // Set Dry/Wet gains
            const wetPct = settings.reverb / 100;
            dryGain.gain.value = 1 - wetPct;
            wetGain.gain.value = wetPct;

            // Create a junction node to mix dry and wet paths before panning
            const mixJunction = offlineCtx.createGain();
            mixJunction.gain.value = 1.0;

            // Wire graph
            sourceNode.connect(bassNode);
            bassNode.connect(lowpassNode);

            // Split into Dry and Wet paths
            lowpassNode.connect(dryGain);
            dryGain.connect(mixJunction);

            if (wetPct > 0) {
                this.updateProgress(10, 'Synthesizing high-fidelity Reverb impulse...');
                const decay = 1.0 + (settings.reverb / 100) * 4.0;
                const irBuffer = this.createOfflineReverbIR(offlineCtx, decay, 2.0);
                convolver.buffer = irBuffer;

                lowpassNode.connect(convolver);
                convolver.connect(wetGain);
                wetGain.connect(mixJunction);
            }

            // Route through automated 3D HRTF panners if 8D is enabled
            if (settings.panSpeed > 0) {
                this.updateProgress(12, 'Synthesizing 8D spatial audio rotation...');
                
                const splitter = offlineCtx.createChannelSplitter(2);
                const leftPanner = offlineCtx.createPanner();
                const rightPanner = offlineCtx.createPanner();

                leftPanner.panningModel = 'HRTF';
                leftPanner.distanceModel = 'inverse';
                leftPanner.refDistance = 1;
                leftPanner.rolloffFactor = 1;

                rightPanner.panningModel = 'HRTF';
                rightPanner.distanceModel = 'inverse';
                rightPanner.refDistance = 1;
                rightPanner.rolloffFactor = 1;

                // Wire stereo splitter & 3D panners
                mixJunction.connect(splitter);
                splitter.connect(leftPanner, 0); // Channel 0 is Left
                splitter.connect(rightPanner, 1); // Channel 1 is Right

                leftPanner.connect(offlineCtx.destination);
                rightPanner.connect(offlineCtx.destination);

                // Automate 3D circular panning over the physical duration of the song
                // frequency: 0.03Hz (slow 33s cycle) to 0.18Hz (fast 5.5s cycle)
                const frequency = 0.03 + (settings.panSpeed / 100) * 0.15;
                const sampleRatePan = 0.05; // 50ms intervals
                const totalPoints = Math.ceil(targetDuration / sampleRatePan);
                const radius = 2.5;
                const stereoOffset = 0.52; // 30 degrees in radians

                // Set initial speaker coordinates at t = 0
                leftPanner.positionX.setValueAtTime(-1.5, 0);
                leftPanner.positionZ.setValueAtTime(-0.5, 0);
                rightPanner.positionX.setValueAtTime(1.5, 0);
                rightPanner.positionZ.setValueAtTime(-0.5, 0);
                
                for (let i = 0; i <= totalPoints; i++) {
                    const t = i * sampleRatePan;
                    const angle = 2 * Math.PI * frequency * t;

                    // Left channel spatial orientation
                    const angleL = angle - stereoOffset;
                    const xL = radius * Math.sin(angleL);
                    const zL = radius * Math.cos(angleL);

                    // Right channel spatial orientation
                    const angleR = angle + stereoOffset;
                    const xR = radius * Math.sin(angleR);
                    const zR = radius * Math.cos(angleR);

                    // Schedule linear ramps to prevent zipper noise and make movements fluid
                    leftPanner.positionX.linearRampToValueAtTime(xL, t);
                    leftPanner.positionZ.linearRampToValueAtTime(zL, t);

                    rightPanner.positionX.linearRampToValueAtTime(xR, t);
                    rightPanner.positionZ.linearRampToValueAtTime(zR, t);
                }
            } else {
                mixJunction.connect(offlineCtx.destination);
            }

            // Start playing source node in offline buffer with trimming bounds
            if (isTrimmed) {
                sourceNode.start(0, startSecs, originalActiveDuration);
            } else {
                sourceNode.start(0);
            }

            this.updateProgress(15, 'Rendering audio effects graph...');

            // Start processing buffer
            const renderedBuffer = await offlineCtx.startRendering();

            if (format === 'wav') {
                this.updateProgress(70, 'Encoding audio to WAV format...');
                
                // Yield thread briefly to let UI update
                await new Promise(resolve => setTimeout(resolve, 50));
                
                const wavData = this.bufferToWav(renderedBuffer);
                this.updateProgress(100, 'Export complete!');
                
                this.downloadBlob(new Blob([wavData], { type: 'audio/wav' }), settings.filename, 'wav');
                this.hideOverlay();
                this.isRendering = false;
                
                const statusBadge = document.getElementById('app-status');
                if (statusBadge) {
                    statusBadge.classList.add('active');
                    statusBadge.querySelector('.status-text').innerText = 'Track Loaded';
                }
            } else {
                // MP3 format
                this.updateProgress(45, 'Booting background audio worker...');
                const leftChannel = renderedBuffer.getChannelData(0);
                const rightChannel = renderedBuffer.getChannelData(1);

                // Setup inline worker
                const blob = new Blob([mp3WorkerCode], { type: 'application/javascript' });
                const workerUrl = URL.createObjectURL(blob);
                this.activeWorker = new Worker(workerUrl);

                this.activeWorker.onmessage = (e) => {
                    const msg = e.data;
                    if (msg.type === 'progress') {
                        // Map worker progress (0-100) to overall rendering progress (45-100)
                        const overallProgress = 45 + Math.round(msg.progress * 0.55);
                        this.updateProgress(overallProgress, `Encoding MP3...`);
                    } else if (msg.type === 'status') {
                        this.statusText.innerText = msg.message;
                    } else if (msg.type === 'complete') {
                        this.updateProgress(100, 'Finishing up...');
                        
                        const mp3Blob = new Blob(msg.data, { type: 'audio/mp3' });
                        this.downloadBlob(mp3Blob, settings.filename, 'mp3');
                        
                        this.hideOverlay();
                        this.activeWorker.terminate();
                        this.activeWorker = null;
                        this.isRendering = false;

                        const statusBadge = document.getElementById('app-status');
                        if (statusBadge) {
                            statusBadge.classList.add('active');
                            statusBadge.querySelector('.status-text').innerText = 'Track Loaded';
                        }
                    } else if (msg.type === 'error') {
                        console.error('Worker error:', msg.message);
                        alert(`MP3 Export Error: ${msg.message}`);
                        this.cancelRendering();
                    }
                };

                // Send data to Web Worker to process asynchronously
                this.activeWorker.postMessage({
                    leftChannel: leftChannel,
                    rightChannel: rightChannel,
                    sampleRate: sampleRate,
                    kbps: 320
                });
            }

        } catch (err) {
            console.error('Render failure:', err);
            alert(`Audio rendering failed: ${err.message}`);
            this.cancelRendering();
        }
    }

    // RIFF WAV 16-bit stereo encoder helper
    bufferToWav(buffer) {
        const numOfChan = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const format = 1; // raw PCM
        const bitDepth = 16;
        
        let result;
        if (numOfChan === 2) {
            result = this.interleave(buffer.getChannelData(0), buffer.getChannelData(1));
        } else {
            result = buffer.getChannelData(0);
        }
        
        const bufferLength = result.length * 2;
        const wavBuffer = new ArrayBuffer(44 + bufferLength);
        const view = new DataView(wavBuffer);
        
        // Write WAV Header
        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + bufferLength, true); // filesize - 8
        this.writeString(view, 8, 'WAVE');
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true); // size of format chunk
        view.setUint16(20, format, true);
        view.setUint16(22, numOfChan, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numOfChan * (bitDepth / 8), true); // byte rate
        view.setUint16(32, numOfChan * (bitDepth / 8), true); // block align
        view.setUint16(34, bitDepth, true);
        this.writeString(view, 36, 'data');
        view.setUint32(40, bufferLength, true);
        
        // Convert Float32 samples to 16-bit PCM and write
        this.floatTo16BitPCM(view, 44, result);
        
        return wavBuffer;
    }

    interleave(inputL, inputR) {
        const length = inputL.length + inputR.length;
        const result = new Float32Array(length);
        let index = 0;
        let inputIndex = 0;
        while (index < length) {
            result[index++] = inputL[inputIndex];
            result[index++] = inputR[inputIndex];
            inputIndex++;
        }
        return result;
    }

    floatTo16BitPCM(output, offset, input) {
        for (let i = 0; i < input.length; i++, offset += 2) {
            let s = Math.max(-1, Math.min(1, input[i]));
            output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
    }

    writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    // Trigger standard browser download dialog
    downloadBlob(blob, filename, extension) {
        const cleanName = filename.replace(/\.[^/.]+$/, ""); // strip existing extension if any
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `${cleanName} (Slowed & Reverb).${extension}`;
        
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }
}
