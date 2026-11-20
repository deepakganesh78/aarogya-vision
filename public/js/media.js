// Photo: downscale and re-encode as JPEG. Re-encoding also drops EXIF metadata such as GPS location.
export async function preparePhoto(file, { maxDim = 1280, quality = 0.82 } = {}) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not encode photo'))), 'image/jpeg', quality)
  );
}

// Voice note: MediaRecorder output (WebM/Opus on Android Chrome, MP4/AAC on iOS) is accepted by Gemini directly.
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export function isRecordingSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

export async function startRecording({ maxMs = 120_000, onTick } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mimeType = AUDIO_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
  const chunks = [];
  const startedAt = Date.now();
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const finished = new Promise((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0];
      resolve({ blob: new Blob(chunks, { type }), durationSec: Math.round((Date.now() - startedAt) / 1000) });
    };
  });

  const ticker = setInterval(() => onTick?.(Math.round((Date.now() - startedAt) / 1000)), 500);
  const limit = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), maxMs);
  recorder.start(1000);

  return {
    // The live microphone stream, so live speech-to-text can listen to the same audio.
    stream,
    stop() {
      clearInterval(ticker);
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
      return finished;
    },
    finished: finished.finally(() => {
      clearInterval(ticker);
      clearTimeout(limit);
    })
  };
}
