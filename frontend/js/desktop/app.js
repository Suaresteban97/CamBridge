/**
 * Controlador principal del escritorio:
 * - Pinta el QR y la URL que entrega Rust.
 * - Conecta el receptor WebRTC con los eventos de señalización de Tauri.
 * - Adapta el escenario a la orientación del video entrante.
 * - Controla la grabación a disco.
 */
import { WebRtcReceiver } from './webrtc-rx.js';
import { StreamRecorder } from './recorder.js';
import { StreamRotator } from './rotation.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const el = {
  shell: document.querySelector('.shell'),
  qr: $('qr'),
  url: $('url'),
  ifaceField: $('iface-field'),
  iface: $('iface'),
  conn: $('conn-state'),
  res: $('stat-res'),
  orient: $('stat-orient'),
  fps: $('stat-fps'),
  bitrate: $('stat-bitrate'),
  camera: $('stat-camera'),
  codec: $('stat-codec'),
  limit: $('stat-limit'),
  camfps: $('stat-camfps'),
  bw: $('stat-bw'),
  encoder: $('stat-encoder'),
  loss: $('stat-loss'),
  transport: $('stat-transport'),
  modeHint: $('mode-hint'),
  modeButtons: [...document.querySelectorAll('[data-mode]')],
  stage: $('stage'),
  video: $('video'),
  badgeOrient: $('badge-orient'),
  badgeRec: $('badge-rec'),
  recBtn: $('rec-btn'),
  recTime: $('rec-time'),
  recSize: $('rec-size'),
  recPath: $('rec-path'),
  btnAudio: $('btn-audio'),
  btnPanel: $('btn-panel'),
  btnFull: $('btn-full'),
  toast: $('toast'),
};

/** Stream tal como llega del celular. */
/** @type {MediaStream | null} */
let remoteStream = null;
/** Stream ya girado: es el que se muestra y se graba. */
/** @type {MediaStream | null} */
let currentStream = null;
let recStartedAt = 0;
let recTimer = 0;
/** Si la grabación se cortó porque cambió el stream, se reanuda en un archivo nuevo. */
let resumeRecording = false;

// ───────────────────────── Utilidades UI ─────────────────────────

let toastTimer = 0;
function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), isError ? 6000 : 3500);
}

const fmtKbps = (k) => (k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${Math.round(k)} kbps`);
const fmtBytes =(b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  return [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
};

const CONN_LABELS = {
  idle: 'Esperando celular',
  connecting: 'Conectando…',
  connected: 'En vivo',
  failed: 'Falló la conexión',
};

const LIMIT_LABELS = {
  none: 'Nada ✓',
  bandwidth: 'Red Wi-Fi',
  cpu: 'CPU del celular',
  other: 'Otro',
};

function setConnState(state) {
  el.conn.dataset.state = state;
  el.conn.textContent = CONN_LABELS[state] ?? state;
  if (state === 'idle' || state === 'failed') setLive(false);
}

function setLive(live) {
  el.stage.classList.toggle('live', live);
  el.recBtn.disabled = !live && !isRecordingAny();
  if (!live) {
    rotator.detach();
    el.video.srcObject = null;
    remoteStream = null;
    currentStream = null;
    el.badgeOrient.hidden = true;
    for (const k of ['res', 'orient', 'fps', 'bitrate', 'codec', 'limit', 'camfps', 'bw', 'encoder', 'loss', 'transport']) {
      el[k].textContent = '—';
    }
  }
}

// ───────────────────────── QR / servidor ─────────────────────────

function showEndpoint(ep) {
  el.qr.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ep.qrSvg)}`;
  el.url.textContent = ep.url;
}

async function initServerInfo() {
  const info = await invoke('get_server_info');
  const eps = info.endpoints;
  showEndpoint(eps[0]);

  if (eps.length > 1) {
    el.ifaceField.hidden = false;
    el.iface.innerHTML = '';
    eps.forEach((ep, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${ep.ip} · ${ep.interface}`;
      el.iface.append(opt);
    });
    el.iface.onchange = () => showEndpoint(eps[Number(el.iface.value)]);
  }

  el.url.onclick = async () => {
    try {
      await navigator.clipboard.writeText(el.url.textContent);
      toast('URL copiada');
    } catch {
      /* portapapeles no disponible */
    }
  };
}

// ───────────────────────── Orientación ─────────────────────────

/** Se dispara cuando cambian las dimensiones intrínsecas del video (p. ej. al rotar el celular). */
function onVideoResize() {
  const { videoWidth: w, videoHeight: h } = el.video;
  if (!w || !h) return;

  const orientation = h > w ? 'portrait' : 'landscape';
  if (el.stage.dataset.orientation !== orientation) {
    el.stage.dataset.orientation = orientation;
    // Breve fundido para que el cambio 9:16 ⇄ 16:9 no sea brusco.
    el.stage.classList.add('reflow');
    setTimeout(() => el.stage.classList.remove('reflow'), 160);
  }

  const label = orientation === 'portrait' ? 'Vertical 9:16' : 'Horizontal 16:9';
  el.orient.textContent = label;
  el.res.textContent = `${w}×${h}`;
  el.badgeOrient.textContent = `${w}×${h}`;
  el.badgeOrient.hidden = false;
}

// ───────────────────────── WebRTC ─────────────────────────

const receiver = new WebRtcReceiver({
  sendSignal: (message) => invoke('send_signal', { message }),
  onState: setConnState,
  onRemoteStatus: (s) => {
    const cam = s.facing === 'user' ? 'Frontal' : 'Trasera';
    const rot = s.rotation ? ` · ${s.rotation}°` : '';
    el.camera.textContent = `${cam} · ${s.quality ?? ''}${rot}`;
    rotator.setRotation(s.rotation ?? 0);
  },
  onSenderStats: (s) => {
    // Diagnóstico: qué está codificando el celular y qué lo frena.
    const hw = /mediacodec|hardware|videotoolbox/i.test(s.encoder ?? '') ? ' (HW)' : '';
    el.codec.textContent = s.codec ? `${s.codec}${hw}` : '—';
    el.limit.textContent = LIMIT_LABELS[s.limit] ?? s.limit ?? '—';
    el.limit.style.color = s.limit && s.limit !== 'none' ? 'var(--warn)' : '';
    el.camfps.textContent = s.cameraFps != null ? Math.round(s.cameraFps).toString() : '—';
    el.bw.textContent = s.availableKbps != null ? fmtKbps(s.availableKbps) : '—';
    el.encoder.textContent = s.encoder || '—';
    el.encoder.title = s.encoder || '';
    const loss = s.lossPct != null ? `${s.lossPct.toFixed(1)}%` : '—';
    const rtt = s.rttMs != null ? `${Math.round(s.rttMs)} ms` : '—';
    el.loss.textContent = `${loss} · ${rtt}`;
    el.transport.textContent = s.transport || '—';
  },
  onHq: (s) => {
    // Estado que informa el celular: lo que falta por subir y errores.
    hqPendingBytes = s.pendingBytes ?? 0;
    if (s.state === 'error' && s.message) toast(`Grabación HQ: ${s.message}`, true);
    if (s.state === 'finishing') {
      el.recBtn.querySelector('.rec-label').textContent = `Subiendo ${fmtBytes(hqPendingBytes)}…`;
    }
    renderHqSize();
  },
  onStream: (stream) => {
    if (remoteStream === stream) return;
    const wasRecording = recorder.isRecording;
    remoteStream = stream;
    showStream(rotator.attach(stream));
    setLive(true);

    // Si el celular se reconectó durante una grabación, se continúa en un archivo nuevo.
    if (wasRecording || resumeRecording) {
      resumeRecording = false;
      restartRecording();
    }
  },
});

/** Muestra el stream (ya girado) en el escenario. */
function showStream(stream) {
  currentStream = stream;
  el.video.srcObject = stream;
  el.video.play().catch(() => {});
}

/**
 * Giro del video según lo que informa el celular. En Windows el stream de salida
 * es siempre el mismo (la grabación no se interrumpe al girar). En macOS/Linux
 * puede cambiar: si se estaba grabando, se continúa en un archivo nuevo.
 */
const rotator = new StreamRotator((stream) => {
  showStream(stream);
  if (recorder.isRecording) restartRecording();
});

/** Muestreo periódico de estadísticas. */
setInterval(async () => {
  const s = await receiver.getStats().catch(() => null);
  if (!s) return;
  if (s.fps != null) el.fps.textContent = Math.round(s.fps).toString();
  if (s.kbps != null) {
    el.bitrate.textContent = fmtKbps(s.kbps);
  }
}, 1000);

// ───────────────────────── Grabación ─────────────────────────

const recorder = new StreamRecorder({
  invoke,
  onProgress: (bytes) => {
    el.recSize.textContent = fmtBytes(bytes);
  },
  onStopped: (info) => {
    setRecordingUi(false);
    if (info) {
      el.recPath.textContent = `Guardado: ${info.path}`;
      toast(`Grabación guardada (${fmtBytes(info.bytes)})`);
    }
    // Si el stream se cortó (no fue el usuario), intentar reanudar al volver.
    if (!userStopped) resumeRecording = true;
  },
  onError: (err) => {
    console.error('[recorder]', err);
    toast(`Error de grabación: ${err?.message ?? err}`, true);
  },
});
let userStopped = false;

function setRecordingUi(on) {
  el.recBtn.classList.toggle('recording', on);
  el.recBtn.querySelector('.rec-label').textContent = on ? 'Detener' : 'Grabar';
  el.badgeRec.hidden = !on;
  el.modeButtons.forEach((b) => (b.disabled = on));
  clearInterval(recTimer);
  if (on) {
    recStartedAt = Date.now();
    el.recTime.textContent = '00:00:00';
    el.recSize.textContent = '0 MB';
    recTimer = setInterval(() => (el.recTime.textContent = fmtTime(Date.now() - recStartedAt)), 500);
  }
  el.recBtn.disabled = !on && !currentStream;
}

async function startRecording() {
  if (!currentStream) return;
  userStopped = false;
  try {
    const info = await recorder.start(currentStream);
    el.recPath.textContent = `Grabando en: ${info.path}`;
    setRecordingUi(true);
  } catch (err) {
    toast(`No se pudo iniciar la grabación: ${err?.message ?? err}`, true);
  }
}

async function stopRecording() {
  userStopped = true;
  resumeRecording = false;
  el.recBtn.disabled = true;
  try {
    await recorder.stop();
  } catch (err) {
    toast(`Error al detener: ${err?.message ?? err}`, true);
  } finally {
    setRecordingUi(false);
  }
}

async function restartRecording() {
  if (recorder.isRecording) {
    userStopped = false;
    await recorder.stop().catch(() => {});
  }
  await startRecording();
}

// ───────────────────────── Modo de grabación ─────────────────────────

/**
 * - "hq": el celular graba con su codificador por hardware y sube el archivo
 *   por HTTPS (calidad independiente de la red). Recomendado para YouTube.
 * - "stream": la PC graba lo que llega por WebRTC (calidad = la de la vista en vivo).
 */
const MODE_HINTS = {
  hq: 'El celular graba en 1080p (~20 Mbps) y envía el archivo a la PC. La vista en vivo es solo para encuadrar.',
  stream: 'La PC graba la vista en vivo. Su calidad depende de la red.',
};
let mode = 'hq';
try {
  mode = localStorage.getItem('cambridge.mode') === 'stream' ? 'stream' : 'hq';
} catch {
  /* sin almacenamiento: se usa el modo por defecto */
}

function setMode(next) {
  mode = next;
  el.modeButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  el.modeHint.textContent = MODE_HINTS[mode];
  try {
    localStorage.setItem('cambridge.mode', mode);
  } catch {
    /* ignorar */
  }
}
el.modeButtons.forEach((b) => (b.onclick = () => !isRecordingAny() && setMode(b.dataset.mode)));
setMode(mode);

// ───────────────────────── Grabación HQ ─────────────────────────

let hqActive = false;
let hqBytes = 0;
let hqPendingBytes = 0;
let hqStartTimeout = 0;

function isRecordingAny() {
  return recorder.isRecording || hqActive;
}

function renderHqSize() {
  if (!hqActive) return;
  const pending = hqPendingBytes > 4e6 ? ` (+${fmtBytes(hqPendingBytes)} por subir)` : '';
  el.recSize.textContent = `${fmtBytes(hqBytes)}${pending}`;
}

async function hqStart() {
  el.recBtn.disabled = true;
  el.recBtn.querySelector('.rec-label').textContent = 'Iniciando…';
  try {
    await invoke('send_signal', { message: { type: 'hq-start' } });
  } catch {
    toast('El celular no está conectado.', true);
    setRecordingUi(false);
    return;
  }
  // Si el celular no confirma (evento "started" de Rust) en 10 s, se avisa.
  hqStartTimeout = setTimeout(() => {
    if (!hqActive) {
      toast('El celular no inició la grabación HQ.', true);
      setRecordingUi(false);
    }
  }, 10_000);
}

async function hqStop() {
  el.recBtn.disabled = true;
  el.recBtn.querySelector('.rec-label').textContent = 'Finalizando…';
  try {
    await invoke('send_signal', { message: { type: 'hq-stop' } });
  } catch {
    el.recBtn.disabled = false;
    el.recBtn.querySelector('.rec-label').textContent = 'Detener';
    toast('El celular no está conectado: la grabación sigue en el celular. Detenla desde allí.', true);
  }
}

/** Eventos de Rust: lo que realmente se ha escrito en disco. */
function onHqEvent({ payload: e }) {
  switch (e.state) {
    case 'started':
      clearTimeout(hqStartTimeout);
      hqActive = true;
      hqBytes = 0;
      hqPendingBytes = 0;
      setMode('hq'); // también si se inició desde el botón del celular
      setRecordingUi(true);
      el.recPath.textContent = `Grabando en: ${e.path}`;
      break;
    case 'progress':
      hqBytes = e.bytes;
      renderHqSize();
      break;
    case 'stopped':
      hqActive = false;
      setRecordingUi(false);
      el.recSize.textContent = fmtBytes(e.bytes);
      el.recPath.textContent = `Guardado: ${e.path}`;
      toast(`Grabación HQ guardada (${fmtBytes(e.bytes)})`);
      break;
  }
}

el.recBtn.onclick = () => {
  if (hqActive) return hqStop();
  if (recorder.isRecording) return stopRecording();
  return mode === 'hq' ? hqStart() : startRecording();
};

// ───────────────────────── Barra de herramientas ─────────────────────────

el.btnAudio.onclick = () => {
  el.video.muted = !el.video.muted;
  el.btnAudio.textContent = el.video.muted ? '🔇' : '🔊';
};

el.btnPanel.onclick = () => {
  const hidden = el.shell.classList.toggle('panel-hidden');
  el.btnPanel.textContent = hidden ? '⇥' : '⇤';
};

el.btnFull.onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.stage.requestFullscreen().catch(() => {});
};
el.stage.ondblclick = el.btnFull.onclick;

el.video.addEventListener('resize', onVideoResize);
el.video.addEventListener('loadedmetadata', onVideoResize);

// ───────────────────────── Arranque ─────────────────────────

async function main() {
  if (!StreamRecorder.isSupported()) {
    el.recPath.textContent = 'Este WebView no soporta MediaRecorder: la grabación no está disponible.';
  }
  if (typeof RTCPeerConnection === 'undefined') {
    toast('Este WebView no soporta WebRTC. En Linux necesitas WebKitGTK con WebRTC habilitado.', true);
  }

  try {
    await initServerInfo();
  } catch (err) {
    toast(`No se pudo obtener la información del servidor: ${err}`, true);
  }

  await listen('hq', onHqEvent);
  await listen('signal', (event) => {
    receiver.handleSignal(event.payload).catch((err) => {
      console.error('[signal]', err);
      setConnState('failed');
    });
  });

  // Si la ventana se recargó con un celular ya conectado, pedimos una oferta nueva.
  if (await invoke('mobile_connected')) await receiver.requestOffer();
}

main();
