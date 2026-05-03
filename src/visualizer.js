
var vizCanvas = null;
var vizCtx = null;
var vizAnimFrame = null;
var vizType = 'bars';
var vizTime = 0;
var vizParticles = [];
var vizActive = false;

function initViz() {
    vizCanvas = document.getElementById('viz-canvas');
    if (!vizCanvas) return;
    vizCtx = vizCanvas.getContext('2d');
    vizParticles = [];
    for (var i = 0; i < 180; i++) {
        vizParticles.push(_newParticle(vizCanvas.width, vizCanvas.height));
    }
    document.querySelectorAll('.viz-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            vizType = this.dataset.viz;
            document.querySelectorAll('.viz-btn').forEach(function (b) { b.classList.remove('active'); });
            this.classList.add('active');
        });
    });
}

function _newParticle(w, h) {
    var angle = Math.random() * Math.PI * 2;
    var speed = 0.3 + Math.random() * 1.2;
    return {
        x: w / 2, y: h / 2,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: Math.random(),
        maxLife: 0.4 + Math.random() * 0.6,
        hue: Math.floor(Math.random() * 360),
        size: 1 + Math.random() * 2,
    };
}

function startViz() {
    if (vizActive) return;
    if (!vizCanvas) initViz();
    if (!vizCanvas) return;
    vizActive = true;
    _vizLoop();
}

function stopViz() {
    vizActive = false;
    if (vizAnimFrame) { cancelAnimationFrame(vizAnimFrame); vizAnimFrame = null; }
    if (vizCtx && vizCanvas) vizCtx.clearRect(0, 0, vizCanvas.width, vizCanvas.height);
}

function _vizLoop() {
    if (!vizActive) return;
    vizTime += 0.016;
    // Natural beat pulse: ~2 Hz sine gives a 120-BPM-equivalent pulsing feel
    var vizBeat = 0.5 + 0.5 * Math.sin(vizTime * 2.0 * Math.PI);
    var w = vizCanvas.width;
    var h = vizCanvas.height;

    if      (vizType === 'bars')      { _drawBars(w, h, vizBeat); }
    else if (vizType === 'wave')      { _drawWave(w, h, vizBeat); }
    else if (vizType === 'particles') { _drawParticles(w, h, vizBeat); }
    else if (vizType === 'rings')     { _drawRings(w, h, vizBeat); }
    else if (vizType === 'aurora')    { _drawAurora(w, h, vizBeat); }
    else if (vizType === 'helix')     { _drawHelix(w, h, vizBeat); }
    else if (vizType === 'lissajous') { _drawLissajous(w, h, vizBeat); }
    else if (vizType === 'tunnel')    { _drawTunnel(w, h, vizBeat); }

    vizAnimFrame = requestAnimationFrame(_vizLoop);
}

// VIZ 1 — Neon Spectrum Bars
function _drawBars(w, h, beat) {
    var ctx = vizCtx;
    // Fade trail
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, w, h);

    var numBars = 56;
    var gap = 2;
    var barW = (w - (numBars - 1) * gap) / numBars;
    var centerY = h / 2;

    for (var i = 0; i < numBars; i++) {
        var t = i / numBars;
        // Three overlapping sines per bar give a spectrum-like variation
        var v1 = Math.sin(vizTime * 1.7 + i * 0.45) * 0.5 + 0.5;
        var v2 = Math.sin(vizTime * 3.1 + i * 0.72) * 0.3;
        var v3 = Math.sin(vizTime * 0.9 + i * 1.1) * 0.2;
        var barH = Math.max(3, (v1 + v2 + v3) * centerY * 0.82 * (0.7 + beat * 0.6));

        var hue = 180 + t * 120; // cyan (180) → magenta (300)
        var x = i * (barW + gap);

        ctx.save();
        ctx.shadowBlur = 14;
        ctx.shadowColor = 'hsl(' + hue + ',100%,70%)';
        ctx.fillStyle = 'hsl(' + hue + ',100%,62%)';
        ctx.fillRect(x, centerY - barH, barW, barH);
        // Dimmer reflection below
        ctx.fillStyle = 'hsl(' + hue + ',100%,38%)';
        ctx.fillRect(x, centerY, barW, barH * 0.55);
        ctx.restore();
    }
}

// VIZ 2 — Plasma Sine Waves
function _drawWave(w, h, beat) {
    var ctx = vizCtx;
    ctx.clearRect(0, 0, w, h);
    var ampScale = h * 0.35 * (0.7 + beat * 0.6);
    var waves = [
        { amp: 0.9, freq: 2.1, speed: 0.9,  phase: 0,           hue: 190, alpha: 0.9, lw: 2.5 },
        { amp: 0.6, freq: 3.5, speed: 1.4,  phase: Math.PI / 3,  hue: 280, alpha: 0.7, lw: 1.8 },
        { amp: 0.7, freq: 1.8, speed: 0.6,  phase: Math.PI,      hue: 140, alpha: 0.65, lw: 2.0 },
    ];
    waves.forEach(function (wave) {
        ctx.save();
        ctx.beginPath();
        for (var x = 0; x <= w; x += 2) {
            var xn = x / w;
            var y = h / 2 + Math.sin(xn * wave.freq * Math.PI * 2 + vizTime * wave.speed + wave.phase) * ampScale * wave.amp;
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'hsla(' + wave.hue + ',100%,65%,' + wave.alpha + ')';
        ctx.lineWidth = wave.lw;
        ctx.shadowBlur = 18;
        ctx.shadowColor = 'hsl(' + wave.hue + ',100%,70%)';
        ctx.stroke();
        ctx.restore();
    });
}

// VIZ 3 — Starfield Particles
function _drawParticles(w, h, beat) {
    var ctx = vizCtx;
    // Dark fade trail
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, w, h);

    var speedMult = 1 + beat * 2.5;
    for (var i = 0; i < vizParticles.length; i++) {
        var p = vizParticles[i];
        p.x += p.vx * speedMult;
        p.y += p.vy * speedMult;
        p.life += 0.013;
        if (p.life > p.maxLife || p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
            vizParticles[i] = _newParticle(w, h);
            continue;
        }
        var alpha = Math.max(0, 1 - p.life / p.maxLife);
        ctx.save();
        ctx.shadowBlur = 8 + beat * 10;
        ctx.shadowColor = 'hsl(' + p.hue + ',100%,70%)';
        ctx.fillStyle = 'hsla(' + p.hue + ',100%,70%,' + alpha + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.8 + beat * 0.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

// VIZ 4 — Pulse Rings
function _drawRings(w, h, beat) {
    var ctx = vizCtx;
    ctx.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2;
    var maxR = Math.min(w, h) * 0.44;
    var numRings = 6;

    for (var i = 0; i < numRings; i++) {
        var t = ((vizTime * 0.12 + i / numRings) % 1);
        var r = t * maxR * (1 + beat * 0.35);
        var hue = (vizTime * 35 + i * 55) % 360;
        var alpha = (1 - t) * 0.92;
        var lw = 1.5 + (1 - t) * 4.5;

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
        ctx.strokeStyle = 'hsla(' + hue + ',100%,65%,' + alpha + ')';
        ctx.lineWidth = lw;
        ctx.shadowBlur = 22 + beat * 18;
        ctx.shadowColor = 'hsl(' + hue + ',100%,70%)';
        ctx.stroke();
        ctx.restore();
    }
    // Central glowing dot
    var innerR = 6 + beat * 18;
    var grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, innerR + 4);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.5, 'rgba(0,229,255,0.6)');
    grd.addColorStop(1, 'rgba(0,229,255,0)');
    ctx.save();
    ctx.shadowBlur = 30;
    ctx.shadowColor = '#00e5ff';
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.restore();
}

// VIZ 5 — Aurora Borealis
function _drawAurora(w, h, beat) {
    var ctx = vizCtx;
    ctx.clearRect(0, 0, w, h);
    var bands = [
        { yBase: 0.20, amp: 0.07, speed: 0.40, phase: 0.0, hue: 150 },
        { yBase: 0.36, amp: 0.08, speed: 0.28, phase: 1.2, hue: 185 },
        { yBase: 0.52, amp: 0.09, speed: 0.50, phase: 2.4, hue: 270 },
        { yBase: 0.68, amp: 0.07, speed: 0.34, phase: 0.8, hue: 310 },
        { yBase: 0.84, amp: 0.06, speed: 0.44, phase: 1.8, hue: 200 },
    ];
    bands.forEach(function (band) {
        var bandH = h * 0.20 * (1 + beat * 0.3);
        ctx.save();
        ctx.beginPath();
        for (var x = 0; x <= w; x += 3) {
            var yTop = h * band.yBase + Math.sin(x * 0.010 + vizTime * band.speed + band.phase) * h * band.amp * (0.8 + beat * 0.4) - bandH * 0.5;
            if (x === 0) ctx.moveTo(x, yTop); else ctx.lineTo(x, yTop);
        }
        for (var x2 = w; x2 >= 0; x2 -= 3) {
            var yBot = h * band.yBase + Math.sin(x2 * 0.010 + vizTime * band.speed + band.phase) * h * band.amp * (0.8 + beat * 0.4) + bandH * 0.5;
            ctx.lineTo(x2, yBot);
        }
        ctx.closePath();
        var midY = h * band.yBase;
        var grad = ctx.createLinearGradient(0, midY - bandH * 0.5, 0, midY + bandH * 0.5);
        grad.addColorStop(0,   'hsla(' + band.hue + ',100%,65%,0)');
        grad.addColorStop(0.4, 'hsla(' + band.hue + ',100%,65%,0.72)');
        grad.addColorStop(0.6, 'hsla(' + band.hue + ',100%,65%,0.72)');
        grad.addColorStop(1,   'hsla(' + band.hue + ',100%,65%,0)');
        ctx.fillStyle = grad;
        ctx.shadowBlur = 14 + beat * 14;
        ctx.shadowColor = 'hsl(' + band.hue + ',100%,70%)';
        ctx.fill();
        ctx.restore();
    });
}

// VIZ 6 — DNA Helix
function _drawHelix(w, h, beat) {
    var ctx = vizCtx;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, 0, w, h);
    var cy = h / 2;
    var amp = h * 0.33 * (1 + beat * 0.18);
    var freq = 3.5;
    var rot = vizTime * 0.8;
    var numRungs = 22;
    // Rungs (drawn first, behind strands)
    for (var i = 0; i <= numRungs; i++) {
        var t = i / numRungs;
        var x = t * w;
        var phase = t * freq * Math.PI * 2 + rot;
        var y1 = cy + Math.sin(phase) * amp;
        var y2 = cy + Math.sin(phase + Math.PI) * amp;
        var z = Math.sin(phase);
        var rungAlpha = 0.18 + 0.45 * (z * 0.5 + 0.5);
        var rungHue = (vizTime * 40 + i * 16) % 360;
        ctx.save();
        ctx.strokeStyle = 'hsla(' + rungHue + ',100%,70%,' + rungAlpha + ')';
        ctx.lineWidth = 1.5;
        ctx.shadowBlur = 6;
        ctx.shadowColor = 'hsl(' + rungHue + ',100%,70%)';
        ctx.beginPath();
        ctx.moveTo(x, y1);
        ctx.lineTo(x, y2);
        ctx.stroke();
        ctx.restore();
    }
    // Strand 1 — cyan
    ctx.save();
    ctx.beginPath();
    for (var x = 0; x <= w; x += 2) {
        var y = cy + Math.sin((x / w) * freq * Math.PI * 2 + rot) * amp;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'hsla(190,100%,65%,0.92)';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 16;
    ctx.shadowColor = '#00e5ff';
    ctx.stroke();
    ctx.restore();
    // Strand 2 — magenta
    ctx.save();
    ctx.beginPath();
    for (var x = 0; x <= w; x += 2) {
        var y = cy + Math.sin((x / w) * freq * Math.PI * 2 + rot + Math.PI) * amp;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'hsla(310,100%,65%,0.92)';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 16;
    ctx.shadowColor = '#ff00cc';
    ctx.stroke();
    ctx.restore();
    // Glowing nodes on each strand
    for (var i = 0; i <= 28; i++) {
        var t = i / 28;
        var x = t * w;
        var phase = t * freq * Math.PI * 2 + rot;
        var z = Math.sin(phase);
        var dotR = 1.5 + Math.max(0, z) * 3;
        if (dotR < 0.5) continue;
        ctx.save();
        ctx.shadowBlur = 10; ctx.shadowColor = '#00e5ff';
        ctx.fillStyle = 'rgba(0,229,255,0.9)';
        ctx.beginPath(); ctx.arc(x, cy + Math.sin(phase) * amp, dotR, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.shadowBlur = 10; ctx.shadowColor = '#ff00cc';
        ctx.fillStyle = 'rgba(255,0,204,0.9)';
        ctx.beginPath(); ctx.arc(x, cy + Math.sin(phase + Math.PI) * amp, dotR, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }
}

// VIZ 7 — Lissajous Curves
function _drawLissajous(w, h, beat) {
    var ctx = vizCtx;
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.fillRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2;
    var rx = w * 0.44;
    var ry = h * 0.42;
    var a = 3;
    var b = 2 + Math.sin(vizTime * 0.07) * 0.9;
    var delta = vizTime * 0.22;
    var hueBase = (vizTime * 18) % 360;
    var numPts = 700;
    // Primary curve
    ctx.save();
    ctx.beginPath();
    for (var i = 0; i <= numPts; i++) {
        var t = (i / numPts) * Math.PI * 2;
        var x = cx + rx * Math.sin(a * t + delta);
        var y = cy + ry * Math.sin(b * t);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'hsla(' + hueBase + ',100%,65%,0.75)';
    ctx.lineWidth = 1.8;
    ctx.shadowBlur = 12 + beat * 16;
    ctx.shadowColor = 'hsl(' + hueBase + ',100%,70%)';
    ctx.stroke();
    ctx.restore();
    // Inner complementary curve
    ctx.save();
    ctx.beginPath();
    var hue2 = (hueBase + 160) % 360;
    for (var i = 0; i <= numPts; i++) {
        var t = (i / numPts) * Math.PI * 2;
        var x = cx + rx * 0.55 * Math.sin(a * 2 * t + delta * 1.4);
        var y = cy + ry * 0.55 * Math.sin(b * 1.5 * t);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'hsla(' + hue2 + ',100%,65%,0.5)';
    ctx.lineWidth = 1.2;
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'hsl(' + hue2 + ',100%,70%)';
    ctx.stroke();
    ctx.restore();
}

// VIZ 8 — Neon Tunnel
function _drawTunnel(w, h, beat) {
    var ctx = vizCtx;
    ctx.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2;
    var numRings = 14;
    var tOffset = (vizTime * (0.09 + beat * 0.04)) % (1 / numRings);
    for (var i = numRings; i >= 0; i--) {
        var t = ((i / numRings) + tOffset) % 1;
        var rw = t * w * 0.52;
        var rh = t * h * 0.52;
        if (rw < 1 || rh < 1) continue;
        var hue = (vizTime * 55 + i * 26) % 360;
        var alpha = (1 - t) * 0.88 + 0.04;
        var lw = 0.8 + (1 - t) * 3.2;
        var angle = t * Math.PI * 0.25 + vizTime * 0.18;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.rect(-rw, -rh, rw * 2, rh * 2);
        ctx.strokeStyle = 'hsla(' + hue + ',100%,65%,' + alpha + ')';
        ctx.lineWidth = lw;
        ctx.shadowBlur = 14 + beat * 22;
        ctx.shadowColor = 'hsl(' + hue + ',100%,70%)';
        ctx.stroke();
        ctx.restore();
    }
    // Crosshair at vanishing point
    ctx.save();
    ctx.strokeStyle = 'hsla(190,100%,82%,0.85)';
    ctx.lineWidth = 1;
    ctx.shadowBlur = 12;
    ctx.shadowColor = '#00e5ff';
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
    ctx.stroke();
    ctx.restore();
}
