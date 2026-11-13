/**
 * Controles táctiles del celular: inicio, cambio de cámara, resolución y
 * micrófono. También mantiene la pantalla encendida (Wake Lock).
 */
import { CameraSender } from './sender.js';

const $ = (id) => document.getElementById(id);
const ui = {
  preview: $('preview'),
  intro: $('intro'),
  introError: $('intro-error'),
  btnStart: $('btn-start'),
  topbar: $('topbar'),
  status: $('status'),
  resChip: $('res-chip'),
  controls: $('controls'),
  btnFlip: $('btn-flip'),
  btnMic: $('btn-mic'),
  micIcon: $('mic-icon'),
  qualityButtons: [...document.querySelectorAll('[data-quality]')],
};

const sender = new CameraSender({
  preview: ui.preview,
  onStatus: (state, text) => {
    ui.status.dataset.state = state;
    ui.status.textContent = text;
  },
  onResolution: (w, h) => {
    ui.resChip.textContent = `${w}×${h}`;
  },
});

// ───────────────────────── Wake Lock ─────────────────────────

let wakeLock = null;
async function keepScreenOn() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* no soportado o denegado: no es crítico */
  }
}
// El wake lock se libera al pasar a segundo plano; se pide de nuevo al volver.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock?.released !== false) keepScreenOn();
});

// ───────────────────────── Acciones ─────────────────────────

/** Desactiva controles mientras una operación de cámara está en curso. */
async function busy(fn) {
  const all = [ui.btnFlip, ui.btnMic, ...ui.qualityButtons];
  all.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (err) {
    ui.status.dataset.state = 'error';
    ui.status.textContent = err?.message ?? String(err);
  } finally {
    all.forEach((b) => (b.disabled = false));
    ui.btnMic.disabled = !sender.hasAudio;
  }
}

ui.btnStart.onclick = async () => {
  ui.btnStart.disabled = true;
  ui.introError.hidden = true;
  try {
    await sender.start();
    ui.intro.hidden = true;
    ui.topbar.hidden = false;
    ui.controls.hidden = false;
    ui.btnMic.disabled = !sender.hasAudio;
    if (!sender.hasAudio) ui.btnMic.classList.add('off');
    keepScreenOn();
  } catch (err) {
    ui.introError.textContent = describeError(err);
    ui.introError.hidden = false;
    ui.btnStart.disabled = false;
  }
};

ui.btnFlip.onclick = () => busy(() => sender.toggleFacing());

ui.btnMic.onclick = () => {
  const on = !sender.micEnabled;
  sender.setMic(on);
  ui.btnMic.classList.toggle('off', !on);
  ui.micIcon.textContent = on ? '🎙️' : '🔇';
};

for (const btn of ui.qualityButtons) {
  btn.onclick = () =>
    busy(async () => {
      await sender.setQuality(btn.dataset.quality);
      ui.qualityButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.quality === sender.quality)));
    });
}

function describeError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Permiso de cámara denegado. Habilítalo en los ajustes del navegador y recarga.';
    case 'NotFoundError':
      return 'No se encontró ninguna cámara.';
    case 'NotReadableError':
      return 'La cámara está en uso por otra aplicación.';
    default:
      return err?.message ?? String(err);
  }
}
