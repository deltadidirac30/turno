// Gestione fotocamera: una sola sorgente attiva, sempre rilasciata quando si esce dallo scanner.
let stream = null;
let videoEl = null;

export class CameraError extends Error {
  constructor(code, cause) { super(code); this.code = code; this.cause = cause; }
}

export function isActive() { return !!stream; }

export async function start(video, { hires = false } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new CameraError('unsupported');
  if (stream && videoEl === video) return stream;
  stop();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // Per la foto del tavolo serve più dettaglio: i codici sono piccoli.
      video: { facingMode: { ideal: 'environment' }, width: { ideal: hires ? 3840 : 1920 }, height: { ideal: hires ? 2160 : 1080 } },
    });
  } catch (e) {
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError('denied', e);
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CameraError('nocamera', e);
    throw new CameraError('error', e);
  }
  videoEl = video;
  video.setAttribute('playsinline', '');
  video.setAttribute('autoplay', '');
  video.muted = true;
  video.srcObject = stream;
  try { await video.play(); } catch { /* alcuni browser richiedono un gesto: il frame arriva comunque */ }
  await waitForFrame(video);
  const track = stream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
  return stream;
}

function waitForFrame(video) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { video.removeEventListener('loadedmetadata', done); res(); };
    video.addEventListener('loadedmetadata', done);
    setTimeout(done, 3000);
  });
}

export function stop() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (videoEl) { try { videoEl.pause(); } catch {} videoEl.srcObject = null; }
  videoEl = null;
}

export function torchSupported() {
  const track = stream && stream.getVideoTracks()[0];
  try { return !!(track && track.getCapabilities && track.getCapabilities().torch); } catch { return false; }
}
let torchOn = false;
export async function toggleTorch() {
  const track = stream && stream.getVideoTracks()[0];
  if (!track) return false;
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
  return torchOn;
}

// Ritaglia dal video la zona corrispondente a un elemento sovrapposto (la cornice),
// tenendo conto di object-fit: cover. Ritorna un canvas alla risoluzione del sensore.
export function grabRegion(video, frameEl, maxWidth = 1600) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (frameEl) {
    const vr = video.getBoundingClientRect();
    const fr = frameEl.getBoundingClientRect();
    const scale = Math.max(vr.width / vw, vr.height / vh); // cover
    const dispW = vw * scale, dispH = vh * scale;
    const offX = (dispW - vr.width) / 2, offY = (dispH - vr.height) / 2;
    sx = (fr.left - vr.left + offX) / scale;
    sy = (fr.top - vr.top + offY) / scale;
    sw = fr.width / scale; sh = fr.height / scale;
    // Un po' di margine: la stampa spesso sborda dalla cornice.
    const mx = sw * 0.08, my = sh * 0.15;
    sx = Math.max(0, sx - mx); sy = Math.max(0, sy - my);
    sw = Math.min(vw - sx, sw + 2 * mx); sh = Math.min(vh - sy, sh + 2 * my);
  }
  const k = Math.min(1, maxWidth / sw);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  c.getContext('2d', { willReadFrequently: true }).drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

export function grabFull(video) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0);
  return c;
}
