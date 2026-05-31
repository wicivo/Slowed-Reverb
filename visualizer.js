/* ==========================================================================
   SLO-FI STUDIO - SOUNDCLOUD-STYLE WAVEFORM SEEKBAR VISUALIZER
   ========================================================================== */

class SloFiWaveformVisualizer {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        
        this.peaks = []; // Sub-sampled float values (0 to 1) representing audio amplitude
        this.playbackProgressPct = 0; // Current playhead position (0 to 1)
        this.hoverPct = -1; // Current mouse hover position (0 to 1), -1 if not hovering
        this.scaledDuration = 0; // Scaled physical duration for the tooltip time

        // Trim boundaries properties
        this.isTrimEnabled = false;
        this.trimStartPct = 0;
        this.trimEndPct = 1;

        // High DPI Canvas Scaling
        this.resize();
        window.addEventListener('resize', () => {
            this.resize();
            this.draw();
        });

        // Track mouse states for hovering seek-previews
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseleave', () => this.handleMouseLeave());
    }

    resize() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);
        this.width = rect.width;
        this.height = rect.height;
    }

    setPeaks(peaks) {
        this.peaks = peaks;
        this.draw();
    }

    setDuration(duration) {
        this.scaledDuration = duration;
    }

    setProgress(pct) {
        this.playbackProgressPct = pct;
        this.draw();
    }

    setTrim(enabled, startPct, endPct) {
        this.isTrimEnabled = enabled;
        this.trimStartPct = startPct;
        this.trimEndPct = endPct;
        this.draw();
    }

    handleMouseMove(e) {
        if (this.peaks.length === 0) return;
        const rect = this.canvas.getBoundingClientRect();
        const xCoord = e.clientX - rect.left;
        const activeWidth = rect.width - 32;
        
        let pct = (xCoord - 16) / activeWidth;
        pct = Math.max(0, Math.min(1, pct));
        
        this.hoverPct = pct;
        this.draw();

        // Dispatch a custom event to notify app of mouse hover change
        const event = new CustomEvent('waveform-hover', { detail: { pct: this.hoverPct } });
        this.canvas.dispatchEvent(event);
    }

    handleMouseLeave() {
        this.hoverPct = -1;
        this.draw();

        const event = new CustomEvent('waveform-hover', { detail: { pct: -1 } });
        this.canvas.dispatchEvent(event);
    }

    // Double digit formatting helper
    formatTime(secs) {
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    draw() {
        // Clear canvas with elegant deep slate-gray
        this.ctx.fillStyle = '#121316';
        this.ctx.fillRect(0, 0, this.width, this.height);

        if (this.peaks.length === 0) {
            // Draw a subtle flat glowing baseline when empty
            this.ctx.strokeStyle = 'rgba(244, 240, 230, 0.05)';
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.moveTo(16, this.height / 2);
            this.ctx.lineTo(this.width - 16, this.height / 2);
            this.ctx.stroke();
            return;
        }

        const activeWidth = this.width - 32;
        if (activeWidth <= 0) return;

        // Calculate responsive gap and optimal number of bars to draw
        const gap = activeWidth < 500 ? 1.5 : 2.5;
        const minSpacing = gap + 1.5; // Minimum spacing per bar (gap + 1.5px bar width)
        const barCount = Math.min(220, Math.floor(activeWidth / minSpacing));
        if (barCount <= 0) return;

        const totalGapWidth = gap * (barCount - 1);
        const barWidth = (activeWidth - totalGapWidth) / barCount;
        const startX = 16;
        
        const centerY = this.height / 2;
        const maxBarHeight = this.height * 0.75;

        // Create gradients
        // Played (Elegant Warm Nordic Sand-to-Oak Gradient)
        const playedGlow = this.ctx.createLinearGradient(0, centerY - maxBarHeight/2, 0, centerY + maxBarHeight/2);
        playedGlow.addColorStop(0, '#dcd3c1'); // Warm Sand
        playedGlow.addColorStop(0.5, '#ffffff'); // Warm Paper White
        playedGlow.addColorStop(1, '#b58d6e'); // Warm Oak

        // Unplayed (Translucent Off-white Paper in active area)
        const unplayedStyle = 'rgba(244, 240, 230, 0.15)';
        
        // Muted style for outside the trim boundaries
        const trimMutedStyle = 'rgba(244, 240, 230, 0.02)';
        
        // Hover state color (Muted Organic Sage Green highlight)
        const hoverHighlightStyle = 'rgba(139, 153, 138, 0.35)';

        // Subsample peaks on the fly
        const step = this.peaks.length / barCount;

        for (let i = 0; i < barCount; i++) {
            const peakIndex = Math.floor(i * step);
            const peak = this.peaks[peakIndex];
            let barHeight = peak * maxBarHeight;
            if (barHeight < 3) barHeight = 3; // minimum visible tick

            const x = startX + i * (barWidth + gap);
            const y = centerY - barHeight / 2;

            const barPct = i / barCount;

            // Determine if the bar is inside the active trim region
            const isInsideTrim = !this.isTrimEnabled || (barPct >= this.trimStartPct && barPct <= this.trimEndPct);

            if (!isInsideTrim) {
                // Faded out-of-trim bars
                this.ctx.fillStyle = trimMutedStyle;
                this.ctx.shadowBlur = 0;
            } else if (barPct <= this.playbackProgressPct) {
                // Fully Played Segment
                this.ctx.fillStyle = playedGlow;
                this.ctx.shadowBlur = 10;
                this.ctx.shadowColor = 'rgba(220, 211, 193, 0.2)';
            } else if (this.hoverPct !== -1 && barPct <= this.hoverPct) {
                // Hover Seeker Highlight Segment
                this.ctx.fillStyle = hoverHighlightStyle;
                this.ctx.shadowBlur = 6;
                this.ctx.shadowColor = 'rgba(139, 153, 138, 0.15)';
            } else {
                // Unplayed Segment
                this.ctx.fillStyle = unplayedStyle;
                this.ctx.shadowBlur = 0;
            }

            // Draw symmetric rounded bar
            this.ctx.beginPath();
            this.ctx.roundRect(x, y, barWidth, barHeight, barWidth / 2);
            this.ctx.fill();
        }

        // Reset shadow
        this.ctx.shadowBlur = 0;

        // Draw vertical glowing playhead line
        const playheadX = startX + this.playbackProgressPct * (this.width - 32);
        
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.lineWidth = 2.5;
        this.ctx.shadowBlur = 12;
        this.ctx.shadowColor = '#dcd3c1';
        this.ctx.beginPath();
        this.ctx.moveTo(playheadX, 8);
        this.ctx.lineTo(playheadX, this.height - 8);
        this.ctx.stroke();
        this.ctx.shadowBlur = 0;

        // Draw vertical Trim Boundaries (Start & End)
        if (this.isTrimEnabled) {
            const trimStartX = startX + this.trimStartPct * (this.width - 32);
            const trimEndX = startX + this.trimEndPct * (this.width - 32);

            this.ctx.lineWidth = 2;
            this.ctx.shadowBlur = 8;
            this.ctx.shadowColor = '#b58d6e';
            this.ctx.strokeStyle = '#b58d6e'; // Warm Oak

            // Draw Start Boundary
            this.ctx.beginPath();
            this.ctx.moveTo(trimStartX, 4);
            this.ctx.lineTo(trimStartX, this.height - 4);
            this.ctx.stroke();

            // Draw End Boundary
            this.ctx.beginPath();
            this.ctx.moveTo(trimEndX, 4);
            this.ctx.lineTo(trimEndX, this.height - 4);
            this.ctx.stroke();

            this.ctx.shadowBlur = 0; // reset
        }

        // Draw hovering preview elements
        if (this.hoverPct !== -1) {
            const hoverX = startX + this.hoverPct * (this.width - 32);

            // Draw thin dashed vertical hover line (Warm Sand tone)
            this.ctx.strokeStyle = 'rgba(220, 211, 193, 0.4)';
            this.ctx.lineWidth = 1.5;
            this.ctx.setLineDash([5, 4]);
            this.ctx.beginPath();
            this.ctx.moveTo(hoverX, 8);
            this.ctx.lineTo(hoverX, this.height - 8);
            this.ctx.stroke();
            this.ctx.setLineDash([]); // reset

            // Draw premium glass hover-time tooltip (Nordic Dark Slate + Sand)
            const hoverTimeSecs = this.hoverPct * this.scaledDuration;
            const timeStr = this.formatTime(hoverTimeSecs);

            this.ctx.font = 'bold 11px monospace';
            const textWidth = this.ctx.measureText(timeStr).width;
            
            const tooltipW = textWidth + 16;
            const tooltipH = 22;
            const tooltipX = Math.max(8, Math.min(this.width - tooltipW - 8, hoverX - tooltipW / 2));
            const tooltipY = 12;

            // Tooltip rounded rectangle
            this.ctx.fillStyle = 'rgba(24, 26, 31, 0.95)';
            this.ctx.strokeStyle = 'rgba(220, 211, 193, 0.3)';
            this.ctx.lineWidth = 1;
            
            this.ctx.beginPath();
            this.ctx.roundRect(tooltipX, tooltipY, tooltipW, tooltipH, 4);
            this.ctx.fill();
            this.ctx.stroke();

            // Tooltip text
            this.ctx.fillStyle = '#dcd3c1';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(timeStr, tooltipX + tooltipW / 2, tooltipY + tooltipH / 2 + 0.5);
        }
    }
}
