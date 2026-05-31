/* ==========================================================================
   SLO-FI STUDIO - CORE COORDINATOR & WEB AUDIO ENGINE
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // ----------------------------------------------------------------------
    // UI ELEMENTS SELECTORS
    // ----------------------------------------------------------------------
    const uploadZone = document.getElementById('upload-zone');
    const audioFileInput = document.getElementById('audio-file');
    const trackInfo = document.getElementById('track-info');
    const trackTitle = document.getElementById('track-title');
    const trackMeta = document.getElementById('track-meta');
    const btnRemove = document.getElementById('btn-remove');
    
    // Sliders
    const sliderSpeed = document.getElementById('slider-speed');
    const sliderReverb = document.getElementById('slider-reverb');
    const sliderBass = document.getElementById('slider-bass');
    const sliderMuffle = document.getElementById('slider-muffle');
    const slider8d = document.getElementById('slider-8d');
    const sliderVolume = document.getElementById('slider-volume');
    
    // Value Displays
    const valSpeed = document.getElementById('val-speed');
    const valReverb = document.getElementById('val-reverb');
    const valBass = document.getElementById('val-bass');
    const valMuffle = document.getElementById('val-muffle');
    const val8d = document.getElementById('val-8d');

    // Controls Buttons
    const btnPlay = document.getElementById('btn-play');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnMute = document.getElementById('btn-mute');
    const btnLoop = document.getElementById('btn-loop');
    const btnExport = document.getElementById('btn-export');
    
    // Playback Progress
    const progressBarTrack = document.getElementById('progress-bar-track');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const progressBarHandle = document.getElementById('progress-handle');
    const labelCurrentTime = document.getElementById('current-time');
    const labelTotalTime = document.getElementById('total-time');

    // App Status & Modes
    const appStatusBadge = document.getElementById('app-status');
    const canvasWatermark = document.getElementById('canvas-watermark');
    const visualizerCanvas = document.getElementById('visualizer-canvas');
    
    // Trim Elements Selectors
    const toggleTrim = document.getElementById('toggle-trim');
    const trimControls = document.getElementById('trim-controls');
    const sliderTrimStart = document.getElementById('slider-trim-start');
    const sliderTrimEnd = document.getElementById('slider-trim-end');
    const valTrimStart = document.getElementById('val-trim-start');
    const valTrimEnd = document.getElementById('val-trim-end');

    // ----------------------------------------------------------------------
    // STATE & ENGINE VARIABLES
    // ----------------------------------------------------------------------
    let audioCtx = null;
    let decodedBuffer = null;
    let sourceNode = null;
    
    // Audio Graph Nodes
    let bassNode = null;
    let lowpassNode = null;
    let dryGainNode = null;
    let wetGainNode = null;
    let convolverNode = null;
    let analyserNode = null;
    let channelSplitter = null;
    let leftPanner = null;
    let rightPanner = null;
    let masterGainNode = null;

    // Playback Control States
    let isPlaying = false;
    let isMuted = false;
    let isLooping = false;
    let currentVolume = 1.0;
    let previousVolume = 1.0; // for muting
    let playbackSpeed = 1.0;
    
    // Timing states
    let totalDuration = 0;   // original duration in seconds
    let startTime = 0;       // AudioContext time when play started
    let startOffset = 0;     // original timeline offset in seconds from start of track
    let animationFrameId = null;
    let filename = "track";
    let fileSizeMb = "0.0";

    // Trim States
    let isTrimEnabled = false;
    let trimStart = 0;       // in original buffer seconds
    let trimEnd = 0;         // in original buffer seconds

    // ----------------------------------------------------------------------
    // COMPONENT INITIALIZATIONS
    // ----------------------------------------------------------------------
    const visualizer = new SloFiWaveformVisualizer('visualizer-canvas');
    const exporter = new SloFiExporter();

    // ----------------------------------------------------------------------
    // INTERACTIVE SCRUBBING (DRAG-TO-SEEK) CONTROLLERS
    // ----------------------------------------------------------------------
    let isScrubbing = false;
    let scrubbingSource = null; // 'waveform' or 'progressbar'
    let wasPlayingBeforeScrub = false;

    // Helper to get clientX for both mouse and touch events
    function getClientX(e) {
        if (e.touches && e.touches.length > 0) {
            return e.touches[0].clientX;
        }
        if (e.changedTouches && e.changedTouches.length > 0) {
            return e.changedTouches[0].clientX;
        }
        return e.clientX;
    }

    function handleScrub(e) {
        if (!decodedBuffer) return;
        
        const clientX = getClientX(e);
        let pct = 0;

        if (scrubbingSource === 'waveform') {
            const rect = visualizerCanvas.getBoundingClientRect();
            const xCoord = clientX - rect.left;
            const activeWidth = rect.width - 32;
            pct = (xCoord - 16) / activeWidth;
        } else if (scrubbingSource === 'progressbar') {
            const rect = progressBarTrack.getBoundingClientRect();
            pct = (clientX - rect.left) / rect.width;
        }

        pct = Math.max(0, Math.min(1, pct));
        const targetSeconds = pct * totalDuration;
        
        let finalSeconds = targetSeconds;
        if (isTrimEnabled) {
            finalSeconds = Math.max(trimStart, Math.min(trimEnd, targetSeconds));
        }

        startOffset = finalSeconds;
        updateProgressBar(finalSeconds);
    }

    function startScrubbing(e, source) {
        if (!decodedBuffer) return;
        isScrubbing = true;
        scrubbingSource = source;
        wasPlayingBeforeScrub = isPlaying;
        
        if (isPlaying) {
            pausePlayback();
        }
        
        handleScrub(e);
    }

    // Attach mousedown and touchstart to both targets
    visualizerCanvas.addEventListener('mousedown', (e) => startScrubbing(e, 'waveform'));
    visualizerCanvas.addEventListener('touchstart', (e) => {
        // Prevent default touch scrolling behavior while scrubbing
        e.preventDefault();
        startScrubbing(e, 'waveform');
    }, { passive: false });

    progressBarTrack.addEventListener('mousedown', (e) => startScrubbing(e, 'progressbar'));
    progressBarTrack.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startScrubbing(e, 'progressbar');
    }, { passive: false });

    // Global drag / move listener on window
    window.addEventListener('mousemove', (e) => {
        if (isScrubbing) {
            handleScrub(e);
        }
    });

    window.addEventListener('touchmove', (e) => {
        if (isScrubbing) {
            // Prevent default touch scrolling while dragging
            e.preventDefault();
            handleScrub(e);
        }
    }, { passive: false });

    // Global release listener on window
    function stopScrubbing() {
        if (isScrubbing) {
            isScrubbing = false;
            scrubbingSource = null;
            
            // Perform actual audio seek to current playhead offset
            seekToTime(startOffset);
            
            if (wasPlayingBeforeScrub) {
                startPlayback();
            }
        }
    }

    window.addEventListener('mouseup', stopScrubbing);
    window.addEventListener('touchend', stopScrubbing);
    window.addEventListener('touchcancel', stopScrubbing);

    // ----------------------------------------------------------------------
    // WEB AUDIO API GRAPH BUILDER
    // ----------------------------------------------------------------------
    function initAudioEngine() {
        if (audioCtx) return;
        
        // Support cross-browser AudioContext
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContextClass();

        // 1. Create Nodes
        bassNode = audioCtx.createBiquadFilter();
        bassNode.type = 'lowshelf';
        bassNode.frequency.value = 150; // Low frequency bass range
        bassNode.gain.value = 0; // Flat initially

        lowpassNode = audioCtx.createBiquadFilter();
        lowpassNode.type = 'lowpass';
        lowpassNode.frequency.value = 20000; // Open initially

        convolverNode = audioCtx.createConvolver();
        dryGainNode = audioCtx.createGain();
        wetGainNode = audioCtx.createGain();
        
        analyserNode = audioCtx.createAnalyser();
        channelSplitter = audioCtx.createChannelSplitter(2);
        leftPanner = audioCtx.createPanner();
        rightPanner = audioCtx.createPanner();
        masterGainNode = audioCtx.createGain();

        // Configure HRTF 3D Panners for premium spatialization
        leftPanner.panningModel = 'HRTF';
        leftPanner.distanceModel = 'inverse';
        leftPanner.refDistance = 1;
        leftPanner.rolloffFactor = 1;
        
        rightPanner.panningModel = 'HRTF';
        rightPanner.distanceModel = 'inverse';
        rightPanner.refDistance = 1;
        rightPanner.rolloffFactor = 1;

        // Position panners at standard premium speaker coordinates initially
        leftPanner.positionX.setValueAtTime(-1.5, audioCtx.currentTime);
        leftPanner.positionZ.setValueAtTime(-0.5, audioCtx.currentTime);
        rightPanner.positionX.setValueAtTime(1.5, audioCtx.currentTime);
        rightPanner.positionZ.setValueAtTime(-0.5, audioCtx.currentTime);

        // Initialize gains
        dryGainNode.gain.value = 1.0;
        wetGainNode.gain.value = 0.0;
        masterGainNode.gain.value = currentVolume;

        // 2. Wire Node Graph
        bassNode.connect(lowpassNode);
        
        // Dry connection
        lowpassNode.connect(dryGainNode);
        dryGainNode.connect(analyserNode);

        // Wet connection (Reverb)
        lowpassNode.connect(convolverNode);
        convolverNode.connect(wetGainNode);
        wetGainNode.connect(analyserNode);

        // Output connection: Split stereo into L/R, spatialize independently in 3D, and merge
        analyserNode.connect(channelSplitter);
        channelSplitter.connect(leftPanner, 0); // Left channel to Left Panner
        channelSplitter.connect(rightPanner, 1); // Right channel to Right Panner
        
        leftPanner.connect(masterGainNode);
        rightPanner.connect(masterGainNode);
        masterGainNode.connect(audioCtx.destination);
    }

    // Programmatic Reverb Buffer Generator (Exponentially decaying filtered white noise)
    function generateReverbImpulseResponse(duration, decay) {
        if (!audioCtx) return null;
        
        const sampleRate = audioCtx.sampleRate;
        const length = sampleRate * duration;
        const impulse = audioCtx.createBuffer(2, length, sampleRate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        // One-pole smoothing filters for cozy warmth
        let lastLeft = 0;
        let lastRight = 0;

        for (let i = 0; i < length; i++) {
            const percent = i / length;
            const envelope = Math.pow(1 - percent, decay);
            
            const noiseLeft = (Math.random() * 2 - 1) * envelope;
            const noiseRight = (Math.random() * 2 - 1) * envelope;

            left[i] = lastLeft + 0.15 * (noiseLeft - lastLeft);
            right[i] = lastRight + 0.15 * (noiseRight - lastRight);

            lastLeft = left[i];
            lastRight = right[i];
        }
        return impulse;
    }

    function updateReverbNode() {
        if (!audioCtx) return;

        const reverbVal = parseInt(sliderReverb.value);
        const wetPct = reverbVal / 100;

        // Apply dry/wet volumes instantly
        dryGainNode.gain.setValueAtTime(1 - wetPct, audioCtx.currentTime);
        wetGainNode.gain.setValueAtTime(wetPct, audioCtx.currentTime);

        if (wetPct > 0) {
            // Programmatic room size scaling: 1.0s decay (at 1% reverb) up to 5.0s (at 100% reverb)
            const decay = 1.0 + (reverbVal / 100) * 4.0;
            const impulse = generateReverbImpulseResponse(decay, 2.0);
            convolverNode.buffer = impulse;
        }
    }

    // Dynamic scaled duration updater
    function updateDurationUI() {
        if (!decodedBuffer) return;
        
        // Active original buffer length accounts for trimming limits
        const activeDuration = isTrimEnabled ? (trimEnd - trimStart) : totalDuration;
        const scaledDur = activeDuration / playbackSpeed;
        
        labelTotalTime.innerText = formatTime(scaledDur);
        trackMeta.innerText = `${fileSizeMb} MB • ${formatTime(scaledDur)}`;
        
        // Pass scaled physical duration bounds to the visualizer for accurate tooltips
        visualizer.setDuration(scaledDur);
    }

    // Peak subsampling algorithm for high-fidelity waveform seekbar rendering
    function extractPeaks(buffer, numBars) {
        const channelData = buffer.getChannelData(0);
        const step = Math.floor(channelData.length / numBars);
        const peaks = [];
        
        for (let i = 0; i < numBars; i++) {
            let max = 0;
            const start = i * step;
            for (let j = 0; j < step; j++) {
                const val = Math.abs(channelData[start + j]);
                if (val > max) max = val;
            }
            peaks.push(max);
        }
        
        // Normalize peaks so the highest bar is padded at 1.0
        const maxPeak = Math.max(...peaks);
        if (maxPeak > 0) {
            for (let i = 0; i < peaks.length; i++) {
                peaks[i] = peaks[i] / maxPeak;
            }
        }
        return peaks;
    }

    // ----------------------------------------------------------------------
    // FILE DRAG & DROP / SELECTION HANDLING
    // ----------------------------------------------------------------------
    // File selection trigger
    uploadZone.addEventListener('click', () => audioFileInput.click());

    audioFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleLoadedFile(e.target.files[0]);
        }
    });

    // Drag events
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = 'var(--primary)';
        uploadZone.style.background = 'rgba(0, 242, 254, 0.05)';
    });

    uploadZone.addEventListener('dragleave', () => {
        uploadZone.style.borderColor = 'var(--glass-border)';
        uploadZone.style.background = 'rgba(255, 255, 255, 0.01)';
    });

    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = 'var(--glass-border)';
        uploadZone.style.background = 'rgba(255, 255, 255, 0.01)';
        
        if (e.dataTransfer.files.length > 0) {
            handleLoadedFile(e.dataTransfer.files[0]);
        }
    });

    function handleLoadedFile(file) {
        if (!file.type.startsWith('audio/')) {
            alert('Please select an audio file (MP3, WAV, etc.)');
            return;
        }

        filename = file.name;
        
        // Show status loading
        appStatusBadge.classList.remove('active');
        appStatusBadge.querySelector('.status-text').innerText = 'Loading track...';
        
        // UI Layout changes
        uploadZone.classList.add('hidden');
        trackInfo.classList.remove('hidden');
        trackTitle.innerText = file.name;
        
        fileSizeMb = (file.size / (1024 * 1024)).toFixed(1);
        trackMeta.innerText = `${fileSizeMb} MB • Analyzing`;

        // Read file into memory buffer
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                // Initialize the web audio engine safely
                initAudioEngine();

                const arrayBuffer = event.target.result;
                
                appStatusBadge.querySelector('.status-text').innerText = 'Decoding audio...';
                
                // Decode the data asynchronously
                decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                
                // Track details successfully read
                totalDuration = decodedBuffer.duration;
                
                // Setup Trim Sliders boundaries
                sliderTrimStart.max = totalDuration;
                sliderTrimStart.value = 0;
                sliderTrimEnd.max = totalDuration;
                sliderTrimEnd.value = totalDuration;
                
                trimStart = 0;
                trimEnd = totalDuration;

                // Generate dynamic notches for trim sliders
                generateNotches(sliderTrimStart);
                generateNotches(sliderTrimEnd);
                
                valTrimStart.innerText = formatTime(0);
                valTrimEnd.innerText = formatTime(totalDuration / playbackSpeed);

                // Enable UI elements
                enableControls();
                
                // Extract waveform peak indices for SoundCloud layout (220 bars)
                appStatusBadge.querySelector('.status-text').innerText = 'Drawing waveform...';
                const peaks = extractPeaks(decodedBuffer, 220);
                visualizer.setPeaks(peaks);
                visualizer.setTrim(isTrimEnabled, 0, 1);
                
                // Reset states
                stopPlayback();
                startOffset = 0;
                updateProgressBar(0);
                updateDurationUI();
                
                appStatusBadge.classList.add('active');
                appStatusBadge.querySelector('.status-text').innerText = 'Track Loaded';
                canvasWatermark.classList.add('hidden');
                
                // Setup reverb buffer dynamically
                updateReverbNode();

            } catch (err) {
                console.error('Decoding failed:', err);
                alert('Failed to decode audio. Please try another file format (like Standard WAV or MP3).');
                resetToUploadState();
            }
        };

        reader.readAsArrayBuffer(file);
    }

    // ----------------------------------------------------------------------
    // PLAYBACK CORE CONTROLLER
    // ----------------------------------------------------------------------
    function createSourceNode() {
        if (!audioCtx || !decodedBuffer) return;
        
        // Cleanup old source if any
        if (sourceNode) {
            try {
                sourceNode.disconnect();
            } catch(e) {}
        }

        sourceNode = audioCtx.createBufferSource();
        sourceNode.buffer = decodedBuffer;
        sourceNode.playbackRate.value = playbackSpeed;

        // Native sample-accurate looping bounds support
        if (isLooping) {
            sourceNode.loop = true;
            if (isTrimEnabled) {
                sourceNode.loopStart = trimStart;
                sourceNode.loopEnd = trimEnd;
            } else {
                sourceNode.loopStart = 0;
                sourceNode.loopEnd = totalDuration;
            }
        } else {
            sourceNode.loop = false;
        }

        // Route source to bass node
        sourceNode.connect(bassNode);

        // Listen for standard playback completion (clamped inside trimming boundaries)
        sourceNode.onended = () => {
            if (isPlaying && !isLooping) {
                const elapsed = getPlayheadTime();
                const limit = isTrimEnabled ? trimEnd : totalDuration;
                if (elapsed >= limit - 0.15) {
                    stopPlayback();
                    startOffset = isTrimEnabled ? trimStart : 0;
                    updateProgressBar(startOffset);
                }
            }
        };
    }

    function startPlayback() {
        if (isPlaying || !decodedBuffer) return;

        // Resume audio context if suspended (browser security autoplay policies)
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }

        // Clamp playhead offset boundaries if trimming is active
        if (isTrimEnabled) {
            if (startOffset < trimStart || startOffset > trimEnd) {
                startOffset = trimStart;
            }
        }

        createSourceNode();
        
        // Start playback at current original timeline offset
        startTime = audioCtx.currentTime;
        
        // Native Web Audio support for buffer trimming offset & duration limits
        if (isTrimEnabled) {
            if (isLooping) {
                sourceNode.start(0, startOffset);
            } else {
                const activeDur = trimEnd - startOffset;
                if (activeDur > 0) {
                    sourceNode.start(0, startOffset, activeDur);
                } else {
                    startOffset = trimStart;
                    sourceNode.start(0, trimStart, trimEnd - trimStart);
                }
            }
        } else {
            sourceNode.start(0, startOffset);
        }
        
        isPlaying = true;
        btnPlay.innerHTML = '<i class="ti ti-player-pause"></i>';
        btnPlay.title = 'Pause';
        
        appStatusBadge.querySelector('.status-text').innerText = 'Playing';
        
        // Start time update progress loop
        animateProgress();
    }

    function pausePlayback() {
        if (!isPlaying || !sourceNode) return;

        // Record exact current playhead position in original timeline seconds
        startOffset += (audioCtx.currentTime - startTime) * playbackSpeed;
        
        try {
            sourceNode.stop();
        } catch(e) {}
        
        isPlaying = false;
        btnPlay.innerHTML = '<i class="ti ti-player-play"></i>';
        btnPlay.title = 'Play';
        
        appStatusBadge.querySelector('.status-text').innerText = 'Paused';
        
        if (leftPanner && rightPanner && audioCtx) {
            leftPanner.positionX.setValueAtTime(-1.5, audioCtx.currentTime);
            leftPanner.positionZ.setValueAtTime(-0.5, audioCtx.currentTime);
            rightPanner.positionX.setValueAtTime(1.5, audioCtx.currentTime);
            rightPanner.positionZ.setValueAtTime(-0.5, audioCtx.currentTime);
        }
        
        cancelAnimationFrame(animationFrameId);
    }

    function stopPlayback() {
        if (sourceNode) {
            try {
                sourceNode.stop();
            } catch(e) {}
        }
        isPlaying = false;
        btnPlay.innerHTML = '<i class="ti ti-player-play"></i>';
        btnPlay.title = 'Play';
        
        if (leftPanner && rightPanner && audioCtx) {
            leftPanner.positionX.setValueAtTime(-1.5, audioCtx.currentTime);
            leftPanner.positionZ.setValueAtTime(-0.5, audioCtx.currentTime);
            rightPanner.positionX.setValueAtTime(1.5, audioCtx.currentTime);
            rightPanner.positionZ.setValueAtTime(-0.5, audioCtx.currentTime);
        }
        
        cancelAnimationFrame(animationFrameId);
    }

    function getPlayheadTime() {
        if (!isPlaying) return startOffset;
        const totalElapsed = (audioCtx.currentTime - startTime) * playbackSpeed;
        
        if (isTrimEnabled && isLooping) {
            const firstCycleDur = trimEnd - startOffset;
            if (totalElapsed < firstCycleDur) {
                return startOffset + totalElapsed;
            } else {
                const remainingElapsed = totalElapsed - firstCycleDur;
                const loopDur = trimEnd - trimStart;
                return trimStart + (remainingElapsed % loopDur);
            }
        } else if (!isTrimEnabled && isLooping) {
            const loopDur = totalDuration;
            return (startOffset + totalElapsed) % loopDur;
        }
        
        return startOffset + totalElapsed;
    }

    function seekToTime(seconds) {
        // Clamp boundaries (either full track or trimmed segment bounds)
        const minBound = isTrimEnabled ? trimStart : 0;
        const maxBound = isTrimEnabled ? trimEnd : totalDuration;
        seconds = Math.max(minBound, Math.min(maxBound, seconds));
        
        const wasPlaying = isPlaying;
        
        if (wasPlaying) {
            stopPlayback();
        }
        
        startOffset = seconds;
        updateProgressBar(seconds);
        
        if (wasPlaying) {
            startPlayback();
        } else {
            // Force redrawing progress bar with physical timeline scale
            const elapsedPhysical = isTrimEnabled ? (seconds - trimStart) / playbackSpeed : seconds / playbackSpeed;
            labelCurrentTime.innerText = formatTime(Math.max(0, elapsedPhysical));
        }
    }

    // Smooth animation tick to update time tracker and progress bar
    function animateProgress() {
        if (!isPlaying) return;

        const currentPos = getPlayheadTime();
        updateProgressBar(currentPos);

        // Dynamic 8D Panning modulation in real-time
        if (leftPanner && rightPanner && audioCtx) {
            const val8dSpeed = parseInt(slider8d.value);
            if (val8dSpeed > 0) {
                const t = audioCtx.currentTime;
                // frequency: 0.03Hz (slow 33s cycle) to 0.18Hz (fast 5.5s cycle)
                const frequency = 0.03 + (val8dSpeed / 100) * 0.15;
                const angle = 2 * Math.PI * frequency * t;
                const radius = 2.5;
                const stereoOffset = 0.52; // 30 degrees offset in radians

                // Left panner position
                const angleL = angle - stereoOffset;
                const xL = radius * Math.sin(angleL);
                const zL = radius * Math.cos(angleL);

                // Right panner position
                const angleR = angle + stereoOffset;
                const xR = radius * Math.sin(angleR);
                const zR = radius * Math.cos(angleR);

                leftPanner.positionX.setValueAtTime(xL, audioCtx.currentTime);
                leftPanner.positionZ.setValueAtTime(zL, audioCtx.currentTime);
                rightPanner.positionX.setValueAtTime(xR, audioCtx.currentTime);
                rightPanner.positionZ.setValueAtTime(zR, audioCtx.currentTime);
            } else {
                // Settle at standard premium front-speaker positions
                leftPanner.positionX.setValueAtTime(-1.5, audioCtx.currentTime);
                leftPanner.positionZ.setValueAtTime(-0.5, audioCtx.currentTime);
                rightPanner.positionX.setValueAtTime(1.5, audioCtx.currentTime);
                rightPanner.positionZ.setValueAtTime(-0.5, audioCtx.currentTime);
            }
        }

        const limit = isTrimEnabled ? trimEnd : totalDuration;

        if (currentPos >= limit) {
            if (isLooping) {
                stopPlayback();
                startOffset = isTrimEnabled ? trimStart : 0;
                startPlayback();
            } else {
                stopPlayback();
                startOffset = isTrimEnabled ? trimStart : 0;
                updateProgressBar(startOffset);
                return;
            }
        }

        animationFrameId = requestAnimationFrame(animateProgress);
    }

    // Updates progress bar and scales timers dynamically for physical duration
    function updateProgressBar(originalSeconds) {
        const pct = originalSeconds / totalDuration;
        
        // Update both SoundCloud seekbar and flat progress track bar
        progressBarFill.style.width = `${pct * 100}%`;
        visualizer.setProgress(pct);
        
        // Physical current time counts from 0:00 starting at the offset boundary if trim enabled
        const elapsedPhysical = isTrimEnabled ? (originalSeconds - trimStart) / playbackSpeed : originalSeconds / playbackSpeed;
        labelCurrentTime.innerText = formatTime(Math.max(0, elapsedPhysical));
    }

    // (Scrubbing for progress bar is unified under global scrubbing controller above)

    // ----------------------------------------------------------------------
    // UI CONTROL TRIGGERS
    // ----------------------------------------------------------------------
    btnPlay.addEventListener('click', () => {
        if (isPlaying) {
            pausePlayback();
        } else {
            startPlayback();
        }
    });

    btnBack.addEventListener('click', () => {
        if (!decodedBuffer) return;
        seekToTime(getPlayheadTime() - 10 * playbackSpeed);
    });

    btnForward.addEventListener('click', () => {
        if (!decodedBuffer) return;
        seekToTime(getPlayheadTime() + 10 * playbackSpeed);
    });

    // Volume adjustment
    sliderVolume.addEventListener('input', (e) => {
        const vol = parseInt(e.target.value) / 100;
        currentVolume = vol;
        if (masterGainNode) {
            masterGainNode.gain.setValueAtTime(vol, audioCtx.currentTime);
        }
        
        // Manage mute icons
        if (vol === 0) {
            btnMute.innerHTML = '<i class="ti ti-volume-3"></i>';
            isMuted = true;
        } else if (vol < 0.4) {
            btnMute.innerHTML = '<i class="ti ti-volume-2"></i>';
            isMuted = false;
        } else {
            btnMute.innerHTML = '<i class="ti ti-volume"></i>';
            isMuted = false;
        }
    });

    btnMute.addEventListener('click', () => {
        if (!audioCtx) return;
        
        if (isMuted) {
            currentVolume = previousVolume > 0 ? previousVolume : 0.8;
            sliderVolume.value = Math.round(currentVolume * 100);
            masterGainNode.gain.setValueAtTime(currentVolume, audioCtx.currentTime);
            btnMute.innerHTML = currentVolume < 0.4 ? '<i class="ti ti-volume-2"></i>' : '<i class="ti ti-volume"></i>';
            isMuted = false;
        } else {
            previousVolume = currentVolume;
            currentVolume = 0;
            sliderVolume.value = 0;
            masterGainNode.gain.setValueAtTime(0, audioCtx.currentTime);
            btnMute.innerHTML = '<i class="ti ti-volume-3"></i>';
            isMuted = true;
        }
    });

    btnLoop.addEventListener('click', () => {
        isLooping = !isLooping;
        btnLoop.classList.toggle('active', isLooping);
        if (sourceNode) {
            if (isLooping) {
                sourceNode.loop = true;
                if (isTrimEnabled) {
                    sourceNode.loopStart = trimStart;
                    sourceNode.loopEnd = trimEnd;
                } else {
                    sourceNode.loopStart = 0;
                    sourceNode.loopEnd = totalDuration;
                }
            } else {
                sourceNode.loop = false;
            }
        }
    });

    // ----------------------------------------------------------------------
    // AUDIO TRIMMING STUDIO CONTROLLERS
    // ----------------------------------------------------------------------
    toggleTrim.addEventListener('change', (e) => {
        isTrimEnabled = e.target.checked;
        
        if (isTrimEnabled) {
            trimControls.classList.remove('hidden');
        } else {
            trimControls.classList.add('hidden');
        }

        // Propagate trim boundaries visually to waveform
        visualizer.setTrim(isTrimEnabled, trimStart / totalDuration, trimEnd / totalDuration);
        
        // Update total time and labels
        updateDurationUI();

        // Snap playback position inside boundaries if needed
        seekToTime(getPlayheadTime());
    });

    // Start Trim slider handler
    sliderTrimStart.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        
        // Clamp: Start trim must be at least 1.0s behind End trim bounds
        trimStart = Math.min(val, trimEnd - 1.0);
        sliderTrimStart.value = trimStart;
        updateNotches(sliderTrimStart);

        if (sourceNode && isLooping && isTrimEnabled) {
            sourceNode.loopStart = trimStart;
        }

        valTrimStart.innerText = formatTime(trimStart / playbackSpeed);

        // Redraw visualizer regions
        visualizer.setTrim(isTrimEnabled, trimStart / totalDuration, trimEnd / totalDuration);
        
        // Update timer text values
        updateDurationUI();

        // Snap current playing playhead to Start trim if it drifts out
        if (getPlayheadTime() < trimStart) {
            seekToTime(trimStart);
        }
    });

    // End Trim slider handler
    sliderTrimEnd.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        
        // Clamp: End trim must be at least 1.0s ahead of Start trim bounds
        trimEnd = Math.max(val, trimStart + 1.0);
        sliderTrimEnd.value = trimEnd;
        updateNotches(sliderTrimEnd);

        if (sourceNode && isLooping && isTrimEnabled) {
            sourceNode.loopEnd = trimEnd;
        }

        valTrimEnd.innerText = formatTime(trimEnd / playbackSpeed);

        // Redraw visualizer regions
        visualizer.setTrim(isTrimEnabled, trimStart / totalDuration, trimEnd / totalDuration);
        
        // Update timer text values
        updateDurationUI();

        // Snap current playing playhead to Start trim if it drifts out past End trim
        if (getPlayheadTime() > trimEnd) {
            seekToTime(trimStart);
        }
    });

    // ----------------------------------------------------------------------
    // FINE TUNING EFFECT SLIDERS
    // ----------------------------------------------------------------------
    
    // Playback Speed / Pitch Control
    sliderSpeed.addEventListener('input', (e) => {
        const speed = parseFloat(e.target.value);
        playbackSpeed = speed;
        valSpeed.innerText = `${speed.toFixed(2)}x`;
        updateNotches(sliderSpeed);

        if (isPlaying && sourceNode) {
            const currentAudioTime = audioCtx.currentTime;
            startOffset += (currentAudioTime - startTime) * sourceNode.playbackRate.value;
            startTime = currentAudioTime;
            
            sourceNode.playbackRate.setValueAtTime(speed, audioCtx.currentTime);
        }
        
        // Dynamically adjust total duration and metadata labels
        updateDurationUI();
        
        // Update Trim values displays for physical timelines
        valTrimStart.innerText = formatTime(trimStart / playbackSpeed);
        valTrimEnd.innerText = formatTime(trimEnd / playbackSpeed);

        // If paused, update the playhead label immediately to reflect new physical scaling
        if (!isPlaying) {
            const elapsedPhysical = isTrimEnabled ? (startOffset - trimStart) / playbackSpeed : startOffset / playbackSpeed;
            labelCurrentTime.innerText = formatTime(Math.max(0, elapsedPhysical));
            visualizer.setProgress(startOffset / totalDuration);
        }
    });

    // Single Reverb control
    sliderReverb.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        valReverb.innerText = `${val}%`;
        updateReverbNode();
        updateNotches(sliderReverb);
    });

    // Bass Boost Gain
    sliderBass.addEventListener('input', (e) => {
        const db = parseFloat(e.target.value);
        valBass.innerText = `${db.toFixed(1)} dB`;
        if (bassNode) {
            bassNode.gain.setValueAtTime(db, audioCtx.currentTime);
        }
        updateNotches(sliderBass);
    });

    // Lowpass Cozy Filter
    sliderMuffle.addEventListener('input', (e) => {
        const pct = parseInt(e.target.value);
        updateNotches(sliderMuffle);
        
        // Map 0-100% to 20000-1000 Hz (open to muffled)
        const freq = Math.round(20000 - (pct / 100) * 19000);
        
        if (pct === 0) {
            valMuffle.innerText = 'Off';
            if (lowpassNode) {
                lowpassNode.frequency.setValueAtTime(20000, audioCtx.currentTime);
            }
        } else {
            valMuffle.innerText = `${pct}% (${freq} Hz)`;
            if (lowpassNode) {
                lowpassNode.frequency.setValueAtTime(freq, audioCtx.currentTime);
            }
        }
    });

    // 8D Audio Spatializer Control
    slider8d.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        updateNotches(slider8d);
        if (val === 0) {
            val8d.innerText = 'Off';
            if (leftPanner && rightPanner && audioCtx) {
                leftPanner.positionX.setValueAtTime(-1.5, audioCtx.currentTime);
                leftPanner.positionZ.setValueAtTime(-0.5, audioCtx.currentTime);
                rightPanner.positionX.setValueAtTime(1.5, audioCtx.currentTime);
                rightPanner.positionZ.setValueAtTime(-0.5, audioCtx.currentTime);
            }
        } else {
            val8d.innerText = `${val}%`;
        }
    });

    // ----------------------------------------------------------------------
    // OFFLINE EXPORT TRIGGER
    // ----------------------------------------------------------------------
    btnExport.addEventListener('click', () => {
        if (!decodedBuffer) return;
        
        const formatSelect = document.querySelector('input[name="export-format"]:checked');
        const format = formatSelect ? formatSelect.value : 'mp3';

        const pctMuffle = parseInt(sliderMuffle.value);
        const freqMuffle = Math.round(20000 - (pctMuffle / 100) * 19000);

        const config = {
            speed: parseFloat(sliderSpeed.value),
            reverb: parseInt(sliderReverb.value),
            bass: parseFloat(sliderBass.value),
            muffle: freqMuffle, // Pass the computed frequency in Hz
            panSpeed: parseInt(slider8d.value),
            filename: filename,
            isTrimEnabled: isTrimEnabled,
            trimStart: trimStart,
            trimEnd: trimEnd
        };

        pausePlayback();
        appStatusBadge.classList.remove('active');
        appStatusBadge.querySelector('.status-text').innerText = 'Exporting...';

        exporter.renderAndExport(decodedBuffer, config, format);
    });

    // ----------------------------------------------------------------------
    // UI LAYOUT HELPERS
    // ----------------------------------------------------------------------
    btnRemove.addEventListener('click', () => {
        resetToUploadState();
    });

    function resetToUploadState() {
        stopPlayback();
        decodedBuffer = null;
        startOffset = 0;
        fileSizeMb = "0.0";
        
        isTrimEnabled = false;
        toggleTrim.checked = false;
        trimControls.classList.add('hidden');
        
        slider8d.value = 0;
        val8d.innerText = 'Off';
        updateNotches(slider8d);
        
        // Disable UI
        disableControls();

        // Clear files and titles
        audioFileInput.value = "";
        trackTitle.innerText = "No file loaded";
        trackMeta.innerText = "0.0 MB • 00:00";
        labelCurrentTime.innerText = "0:00";
        labelTotalTime.innerText = "0:00";
        progressBarFill.style.width = "0%";
        
        trackInfo.classList.add('hidden');
        uploadZone.classList.remove('hidden');
        canvasWatermark.classList.remove('hidden');

        appStatusBadge.classList.remove('active');
        appStatusBadge.querySelector('.status-text').innerText = 'Ready to slow';
        
        // Clear peaks on visualizer
        visualizer.setPeaks([]);
        visualizer.setTrim(false, 0, 1);
    }

    function enableControls() {
        // Enable Sliders
        sliderSpeed.disabled = false;
        sliderReverb.disabled = false;
        sliderBass.disabled = false;
        sliderMuffle.disabled = false;
        slider8d.disabled = false;
        sliderVolume.disabled = false;

        // Trimmer elements
        toggleTrim.disabled = false;
        sliderTrimStart.disabled = false;
        sliderTrimEnd.disabled = false;

        // Buttons
        btnPlay.disabled = false;
        btnBack.disabled = false;
        btnForward.disabled = false;
        btnMute.disabled = false;
        btnLoop.disabled = false;
        btnExport.disabled = false;
    }

    function disableControls() {
        // Disable Sliders
        sliderSpeed.disabled = true;
        sliderReverb.disabled = true;
        sliderBass.disabled = true;
        sliderMuffle.disabled = true;
        slider8d.disabled = true;
        sliderVolume.disabled = true;

        // Trimmer elements
        toggleTrim.disabled = true;
        sliderTrimStart.disabled = true;
        sliderTrimEnd.disabled = true;

        // Buttons
        btnPlay.disabled = true;
        btnBack.disabled = true;
        btnForward.disabled = true;
        btnMute.disabled = true;
        btnLoop.disabled = true;
        btnExport.disabled = true;
    }

    // Generate notches for all static neon-sliders initially
    const staticSliders = [sliderSpeed, sliderReverb, sliderBass, sliderMuffle, slider8d];
    staticSliders.forEach(slider => generateNotches(slider));

    // Generate visual tick notches for ranges
    function generateNotches(slider) {
        const existing = slider.parentNode.querySelector('.slider-notches');
        if (existing) {
            existing.remove();
        }

        const min = parseFloat(slider.getAttribute('min') || 0);
        const max = parseFloat(slider.getAttribute('max') || 100);
        let step = parseFloat(slider.getAttribute('step') || 1);
        
        let notchStep = step;
        const totalSteps = (max - min) / step;
        
        // Prevent overcrowding
        if (totalSteps > 25) {
            if (slider.id === 'slider-muffle') {
                notchStep = 1000; // 19 ticks
            } else if (slider.id === 'slider-trim-start' || slider.id === 'slider-trim-end') {
                notchStep = (max - min) / 20; // 20 ticks
            } else {
                notchStep = step * Math.ceil(totalSteps / 20);
            }
        }
        
        const notchesContainer = document.createElement('div');
        notchesContainer.className = 'slider-notches';
        
        const numNotches = Math.round((max - min) / notchStep) + 1;
        for (let i = 0; i < numNotches; i++) {
            const notchVal = min + i * notchStep;
            if (notchVal > max) continue;
            
            const notch = document.createElement('span');
            notch.dataset.value = notchVal;
            
            // Mark center notch
            const pct = (notchVal - min) / (max - min);
            if (Math.abs(pct - 0.5) < 0.015) {
                notch.classList.add('center-notch');
            }
            
            notchesContainer.appendChild(notch);
        }
        
        slider.parentNode.insertBefore(notchesContainer, slider.nextSibling);
        updateNotches(slider);
    }

    function updateNotches(slider) {
        const val = parseFloat(slider.value);
        const container = slider.parentNode.querySelector('.slider-notches');
        if (!container) return;
        
        const notches = container.querySelectorAll('span');
        notches.forEach(notch => {
            const notchVal = parseFloat(notch.dataset.value);
            if (notchVal <= val) {
                notch.classList.add('active');
            } else {
                notch.classList.remove('active');
            }
        });
    }

    // Double digit padding for audio duration representation
    function formatTime(secs) {
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }
});
