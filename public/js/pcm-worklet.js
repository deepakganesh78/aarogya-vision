// AudioWorklet: turns the microphone (usually 44.1 or 48 kHz float) into 16 kHz, 16-bit mono PCM
// in 100 ms frames, which is what the live speech-to-text service expects.
const TARGET_RATE = 16000;
const FRAME = 1600; // samples = 100 ms

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE; // input samples per output sample
    this.pos = 0; // fractional read position into the incoming stream
    this.prev = 0;
    this.out = new Int16Array(FRAME);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    // Linear interpolation resampler over a continuous stream (previous block's last sample kept in `prev`).
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : ch[i - 1];
      const b = ch[i];
      const v = Math.max(-1, Math.min(1, a + (b - a) * frac));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === FRAME) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(FRAME);
        this.n = 0;
      }
      this.pos += this.step;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
