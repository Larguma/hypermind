const countEl = document.getElementById('count');
const directEl = document.getElementById('direct');
const canvas = document.getElementById('network');
const ctx = canvas.getContext('2d');
let particles = [];

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

window.addEventListener('resize', resize);
resize();

class Particle {
    constructor() {
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.vx = (Math.random() - 0.5) * 1;
        this.vy = (Math.random() - 0.5) * 1;
        this.size = 3;
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;

        if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
        if (this.y < 0 || this.y > canvas.height) this.vy *= -1;
    }

    draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fillStyle = '#4ade80';
        ctx.fill();
    }
}

const updateParticles = (count) => {
    const VISUAL_LIMIT = 500;
    const visualCount = Math.min(count, VISUAL_LIMIT);

    const currentCount = particles.length;
    if (visualCount > currentCount) {
        for (let i = 0; i < visualCount - currentCount; i++) {
            particles.push(new Particle());
        }
    } else if (visualCount < currentCount) {
        particles.splice(visualCount, currentCount - visualCount);
    }
}

const animate = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(74, 222, 128, 0.15)';
    ctx.lineWidth = 1;
    for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
            const dx = particles[i].x - particles[j].x;
            const dy = particles[i].y - particles[j].y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < 150) {
                ctx.beginPath();
                ctx.moveTo(particles[i].x, particles[i].y);
                ctx.lineTo(particles[j].x, particles[j].y);
                ctx.stroke();
            }
        }
    }

    particles.forEach(p => {
        p.update();
        p.draw();
    });

    requestAnimationFrame(animate);
}

const openDiagnostics = () => {
    document.getElementById('diagnosticsModal').classList.add('active');
}

const closeDiagnostics = () => {
    document.getElementById('diagnosticsModal').classList.remove('active');
}

document.getElementById('diagnosticsModal').addEventListener('click', (e) => {
    if (e.target.id === 'diagnosticsModal') {
        closeDiagnostics();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeDiagnostics();
    }
});

const formatBandwidth = (bytes, short = false) => {
    const kb = bytes / 1024;
    const mb = kb / 1024;
    const gb = mb / 1024;
    const space = short ? '' : ' ';

    if (gb >= 1) {
        return gb.toFixed(short ? 1 : 2) + space + 'GB';
    } else if (mb >= 1) {
        return mb.toFixed(short ? 1 : 2) + space + 'MB';
    } else {
        return kb.toFixed(short ? 0 : 1) + space + 'KB';
    }
};

const evtSource = new EventSource("/events");

evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    updateParticles(data.count);

    if (countEl.innerText != data.count) {
        countEl.innerText = data.count;
        countEl.classList.remove('pulse');
        void countEl.offsetWidth;
        countEl.classList.add('pulse');
    }

    directEl.innerText = data.direct;

    if (data.diagnostics) {
        const d = data.diagnostics;

        document.getElementById('diag-heartbeats-rx').innerText = d.heartbeatsReceived.toLocaleString();
        document.getElementById('diag-heartbeats-tx').innerText = d.heartbeatsRelayed.toLocaleString();
        document.getElementById('diag-new-peers').innerText = d.newPeersAdded.toLocaleString();
        document.getElementById('diag-dup-seq').innerText = d.duplicateSeq.toLocaleString();
        document.getElementById('diag-invalid-pow').innerText = d.invalidPoW.toLocaleString();
        document.getElementById('diag-invalid-sig').innerText = d.invalidSig.toLocaleString();
        document.getElementById('diag-bandwidth-in').innerText = formatBandwidth(d.bytesReceived);
        document.getElementById('diag-bandwidth-out').innerText = formatBandwidth(d.bytesRelayed);
        document.getElementById('diag-leave').innerText = d.leaveMessages.toLocaleString();

        addBandwidthData(d.bytesReceived, d.bytesRelayed);
        drawBandwidthGraph();

        document.getElementById('current-in').innerText = formatBandwidth(d.bytesReceived);
        document.getElementById('current-out').innerText = formatBandwidth(d.bytesRelayed);
    }
};

evtSource.onerror = (err) => {
    // Removing console error here as it's extremely spammy in the browser console and it will reconnct automatically anyway, so pretty redundant.
};

const initialCount = parseInt(countEl.dataset.initialCount) || 0;
countEl.innerText = initialCount;
countEl.classList.add('loaded');
updateParticles(initialCount);
animate();

const bandwidthHistory = { timestamps: [], bytesIn: [], bytesOut: [] };
let selectedTimeRange = 300;
const bandwidthCanvas = document.getElementById('bandwidthGraph');
const bandwidthCtx = bandwidthCanvas.getContext('2d');
const bandwidthOverlay = document.getElementById('bandwidthOverlay');

function resizeBandwidthCanvas() {
    const rect = bandwidthCanvas.getBoundingClientRect();
    bandwidthCanvas.width = rect.width;
    bandwidthCanvas.height = rect.height;
    drawBandwidthGraph();
}

window.addEventListener('resize', resizeBandwidthCanvas);
setTimeout(resizeBandwidthCanvas, 100);

const toggleBandwidthGraph = () => {
    bandwidthOverlay.classList.toggle('collapsed');
    document.querySelector('.bandwidth-overlay .close-btn').textContent =
        bandwidthOverlay.classList.contains('collapsed') ? '+' : '−';
};

const timePills = document.querySelectorAll('.time-pill');
timePills.forEach(pill => {
    pill.addEventListener('click', (e) => {
        e.stopPropagation();
        timePills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const value = pill.dataset.value;
        selectedTimeRange = value === 'all' ? 'all' : parseInt(value);
        drawBandwidthGraph();
    });
});

timePills[0].classList.add('active');

const addBandwidthData = (bytesIn, bytesOut) => {
    bandwidthHistory.timestamps.push(Date.now());
    bandwidthHistory.bytesIn.push(bytesIn);
    bandwidthHistory.bytesOut.push(bytesOut);

    if (bandwidthHistory.timestamps.length > 360) {
        bandwidthHistory.timestamps.shift();
        bandwidthHistory.bytesIn.shift();
        bandwidthHistory.bytesOut.shift();
    }
};

const getFilteredData = () => {
    if (selectedTimeRange === 'all') return bandwidthHistory;

    const cutoff = Date.now() - (selectedTimeRange * 1000);
    const startIndex = bandwidthHistory.timestamps.findIndex(t => t >= cutoff);

    if (startIndex === -1) return bandwidthHistory;

    return {
        timestamps: bandwidthHistory.timestamps.slice(startIndex),
        bytesIn: bandwidthHistory.bytesIn.slice(startIndex),
        bytesOut: bandwidthHistory.bytesOut.slice(startIndex)
    };
};

const drawBandwidthGraph = () => {
    const w = bandwidthCanvas.width;
    const h = bandwidthCanvas.height;

    if (w === 0 || h === 0) return;

    const pad = { t: 10, r: 10, b: 20, l: 50 };

    bandwidthCtx.clearRect(0, 0, w, h);

    const data = getFilteredData();
    if (data.timestamps.length < 2) return;

    const max = Math.max(...data.bytesIn, ...data.bytesOut);
    if (max === 0) return;

    bandwidthCtx.fillStyle = '#9ca3af';
    bandwidthCtx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto';
    bandwidthCtx.textAlign = 'right';
    [max, max / 2, 0].forEach((val, i) => {
        bandwidthCtx.fillText(formatBandwidth(val, true), pad.l - 5, pad.t + ((h - pad.t - pad.b) / 2) * i + 4);
    });

    const drawLine = (points, color) => {
        bandwidthCtx.strokeStyle = color;
        bandwidthCtx.lineWidth = 2;
        bandwidthCtx.beginPath();
        points.forEach((val, i) => {
            const x = pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r);
            const y = pad.t + (h - pad.t - pad.b) - (val / max) * (h - pad.t - pad.b);
            i === 0 ? bandwidthCtx.moveTo(x, y) : bandwidthCtx.lineTo(x, y);
        });
        bandwidthCtx.stroke();

        bandwidthCtx.lineTo(pad.l + (w - pad.l - pad.r), pad.t + (h - pad.t - pad.b));
        bandwidthCtx.lineTo(pad.l, pad.t + (h - pad.t - pad.b));
        bandwidthCtx.closePath();
        bandwidthCtx.fillStyle = color + '33';
        bandwidthCtx.fill();
    };

    drawLine(data.bytesIn, '#60a5fa');
    drawLine(data.bytesOut, '#f97316');
};

