/**
 * Screencast Recorder — captures screenshots during test execution via CDP
 * and assembles them into a downloadable WebM video or animated sequence.
 *
 * Uses CDP Page.screencastFrame to capture frames at regular intervals.
 * The frames are stored as base64 PNG images and can be exported as:
 * - Individual frame gallery (screenshot sequence)
 * - Base64 frames array for playback in the UI
 */
import { createLogger } from '../../utils/logger';

const log = createLogger('screencast');

interface ScreencastFrame {
  data: string;         // base64 PNG
  timestamp: number;    // ms since recording start
  sessionId: number;    // CDP session frame ID
}

interface ScreencastSession {
  tabId: number;
  frames: ScreencastFrame[];
  startedAt: number;
  active: boolean;
}

const activeSessions = new Map<number, ScreencastSession>();

/**
 * Start capturing screencast frames for a tab via CDP.
 * Frames are captured at ~2fps to balance quality and memory usage.
 */
export async function startScreencast(tabId: number): Promise<void> {
  if (activeSessions.has(tabId)) {
    log.warn(`Screencast already active for tab ${tabId}`);
    return;
  }

  const session: ScreencastSession = {
    tabId,
    frames: [],
    startedAt: Date.now(),
    active: true,
  };
  activeSessions.set(tabId, session);

  try {
    // Ensure debugger is attached (cdp-client handles dedup)
    await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
      format: 'png',
      quality: 60,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 2, // Capture every 2nd frame (~2fps effective)
    });

    log.info(`Screencast started for tab ${tabId}`);
  } catch (err) {
    activeSessions.delete(tabId);
    log.warn('Failed to start screencast', err);
    throw err;
  }
}

/**
 * Stop capturing and return all captured frames.
 */
export async function stopScreencast(tabId: number): Promise<ScreencastFrame[]> {
  const session = activeSessions.get(tabId);
  if (!session) {
    return [];
  }

  session.active = false;
  activeSessions.delete(tabId);

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast');
  } catch {
    // Tab may be closed already
  }

  log.info(`Screencast stopped for tab ${tabId}: ${session.frames.length} frames captured`);
  return session.frames;
}

/**
 * Check if screencast is active for a tab.
 */
export function isScreencastActive(tabId: number): boolean {
  return activeSessions.has(tabId);
}

/**
 * Get current frame count for a tab.
 */
export function getFrameCount(tabId: number): number {
  return activeSessions.get(tabId)?.frames.length ?? 0;
}

// Handle incoming screencast frames from CDP
chrome.debugger.onEvent.addListener((source, method, params: Record<string, unknown>) => {
  if (method !== 'Page.screencastFrame') return;

  const tabId = source.tabId;
  if (tabId === undefined) return;

  const session = activeSessions.get(tabId);
  if (!session || !session.active) return;

  const data = params.data as string;
  const sessionId = params.sessionId as number;

  // ACK the frame so CDP continues sending
  chrome.debugger.sendCommand({ tabId }, 'Page.screencastFrameAck', { sessionId }).catch(() => {});

  session.frames.push({
    data,
    timestamp: Date.now() - session.startedAt,
    sessionId,
  });

  // Cap at 600 frames (~5 minutes at 2fps) to prevent memory bloat
  if (session.frames.length > 600) {
    session.frames.shift();
  }
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  activeSessions.delete(tabId);
});

/**
 * Generate an HTML page with a frame-by-frame playback viewer.
 * The viewer auto-advances through frames and shows a timeline scrubber.
 */
export function generateScreencastPlayer(frames: ScreencastFrame[], testTitle: string): string {
  if (frames.length === 0) {
    return '<html><body><p>No frames captured.</p></body></html>';
  }

  const totalDuration = frames[frames.length - 1].timestamp;

  // Encode frames as a JSON array of { data, timestamp }
  const framesJson = JSON.stringify(
    frames.map((f) => ({ d: f.data, t: f.timestamp }))
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>pathfinder Recording: ${escapeHtml(testTitle)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f1117;color:#e5e7eb;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;padding:20px}
    h1{font-size:18px;margin-bottom:12px;font-weight:600}
    .meta{font-size:12px;color:#9ca3af;margin-bottom:16px}
    .player{position:relative;max-width:1280px;width:100%}
    .player img{width:100%;border-radius:8px;border:1px solid #2d3148;display:block}
    .controls{display:flex;align-items:center;gap:12px;margin-top:12px;width:100%;max-width:1280px}
    button{background:#2d3148;color:#e5e7eb;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px}
    button:hover{background:#3d4158}
    .timeline{flex:1;height:6px;background:#2d3148;border-radius:3px;cursor:pointer;position:relative}
    .timeline .progress{height:100%;background:#818cf8;border-radius:3px;transition:width 0.1s}
    .time{font-size:12px;color:#9ca3af;min-width:80px;text-align:right}
    .frame-info{font-size:11px;color:#6b7280;margin-top:8px;text-align:center}
  </style>
</head>
<body>
  <h1>pathfinder Recording: ${escapeHtml(testTitle)}</h1>
  <div class="meta">${frames.length} frames | ${(totalDuration / 1000).toFixed(1)}s duration</div>
  <div class="player">
    <img id="frame" src="" alt="Test recording frame">
  </div>
  <div class="controls">
    <button id="playBtn">Play</button>
    <button id="prevBtn">&lt;</button>
    <button id="nextBtn">&gt;</button>
    <div class="timeline" id="timeline">
      <div class="progress" id="progress"></div>
    </div>
    <span class="time" id="time">0:00 / 0:00</span>
  </div>
  <div class="frame-info" id="frameInfo">Frame 1 / ${frames.length}</div>
  <script>
    const frames = ${framesJson};
    let idx = 0, playing = false, timer = null;
    const img = document.getElementById('frame');
    const playBtn = document.getElementById('playBtn');
    const progress = document.getElementById('progress');
    const timeEl = document.getElementById('time');
    const infoEl = document.getElementById('frameInfo');
    const total = frames.length > 0 ? frames[frames.length-1].t : 0;

    function show(i) {
      idx = Math.max(0, Math.min(i, frames.length-1));
      img.src = 'data:image/png;base64,' + frames[idx].d;
      const pct = total > 0 ? (frames[idx].t / total * 100) : 0;
      progress.style.width = pct + '%';
      const cur = (frames[idx].t/1000).toFixed(1);
      const tot = (total/1000).toFixed(1);
      timeEl.textContent = cur + 's / ' + tot + 's';
      infoEl.textContent = 'Frame ' + (idx+1) + ' / ' + frames.length;
    }

    function play() {
      if (playing) { stop(); return; }
      playing = true; playBtn.textContent = 'Pause';
      if (idx >= frames.length-1) idx = 0;
      const startTime = performance.now() - frames[idx].t;
      function tick() {
        if (!playing) return;
        const elapsed = performance.now() - startTime;
        while (idx < frames.length-1 && frames[idx+1].t <= elapsed) idx++;
        show(idx);
        if (idx >= frames.length-1) { stop(); return; }
        timer = requestAnimationFrame(tick);
      }
      tick();
    }

    function stop() { playing = false; playBtn.textContent = 'Play'; if (timer) cancelAnimationFrame(timer); }

    playBtn.onclick = play;
    document.getElementById('prevBtn').onclick = () => { stop(); show(idx-1); };
    document.getElementById('nextBtn').onclick = () => { stop(); show(idx+1); };
    document.getElementById('timeline').onclick = (e) => {
      stop();
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const targetTime = pct * total;
      let closest = 0;
      for (let i = 0; i < frames.length; i++) {
        if (Math.abs(frames[i].t - targetTime) < Math.abs(frames[closest].t - targetTime)) closest = i;
      }
      show(closest);
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === ' ') { e.preventDefault(); play(); }
      if (e.key === 'ArrowLeft') { stop(); show(idx-1); }
      if (e.key === 'ArrowRight') { stop(); show(idx+1); }
    });
    show(0);
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
