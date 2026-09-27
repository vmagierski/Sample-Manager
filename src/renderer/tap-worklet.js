// Runs on the audio thread. Copies whatever reaches the player's bus (stereo)
// and posts it to the page in 2048-frame chunks for Rec / Recall. It only
// copies memory, so it can't disturb playback.

const CHUNK = 2048; // multiple of the 128-frame render quantum (~43ms at 48k)

class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fresh();
  }

  fresh() {
    this.l = new Float32Array(CHUNK);
    this.r = new Float32Array(CHUNK);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const frames = input && input.length ? input[0].length : 128;
    if (input && input.length) {
      this.l.set(input[0], this.n);
      this.r.set(input[1] || input[0], this.n);
    } // else: nothing connected/playing — leave zeros (literal silence)
    this.n += frames;
    if (this.n >= CHUNK) {
      this.port.postMessage([this.l, this.r], [this.l.buffer, this.r.buffer]);
      this.fresh();
    }
    return true;
  }
}

registerProcessor('sm-tap', Tap);
