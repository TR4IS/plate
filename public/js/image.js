// Turning a camera frame or a picked file into the two JPEGs the app uses:
// a detailed one for the AI and a small one to keep with the meal.

const ANALYSIS_EDGE = 1568; // plenty for recognising food; larger only costs more
const KEEP_EDGE = 720;

function encode(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the photo'))), 'image/jpeg', quality);
  });
}

function draw(source, crop, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(crop.w, crop.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(crop.w * scale));
  canvas.height = Math.max(1, Math.round(crop.h * scale));
  canvas.getContext('2d').drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function render(source, crop) {
  const analysisCanvas = draw(source, crop, ANALYSIS_EDGE);
  const analysis = await encode(analysisCanvas, 0.86);
  const keepCanvas = draw(analysisCanvas, { x: 0, y: 0, w: analysisCanvas.width, h: analysisCanvas.height }, KEEP_EDGE);
  const keep = await encode(keepCanvas, 0.8);
  return { analysis, keep, url: URL.createObjectURL(keep) };
}

/** Capture exactly what the live preview shows (the preview crops the sensor image to fill its box). */
export function photoFromVideo(video) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return Promise.reject(new Error('The camera is not ready'));
  const box = video.getBoundingClientRect();
  const viewRatio = box.width / box.height || vw / vh;
  let w = vw;
  let h = vh;
  if (vw / vh > viewRatio) w = vh * viewRatio;
  else h = vw / viewRatio;
  return render(video, { x: (vw - w) / 2, y: (vh - h) / 2, w, h });
}

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function photoFromFile(file) {
  const bitmap = await decode(file);
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const result = await render(bitmap, { x: 0, y: 0, w, h });
  bitmap.close?.();
  return result;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
