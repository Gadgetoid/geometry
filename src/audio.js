// Tiny synthesised sound effects, created lazily on first user gesture.

export const Sound = {
  enabled: false,
  ctx: null,

  ensureContext() {
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)()
      } catch (e) {
        /* audio is best-effort */
      }
    }
  },

  beep(freq, duration, wave, volume, endFreq) {
    if (!this.enabled) {
      return
    }
    this.ensureContext()
    if (!this.ctx) {
      return
    }
    try {
      const osc = this.ctx.createOscillator()
      const gain = this.ctx.createGain()
      const now = this.ctx.currentTime
      osc.type = wave || "square"
      osc.frequency.setValueAtTime(freq, now)
      if (endFreq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), now + duration)
      }
      gain.gain.setValueAtTime(volume || 0.05, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
      osc.connect(gain).connect(this.ctx.destination)
      osc.start(now)
      osc.stop(now + duration)
    } catch (e) {
      /* ignore */
    }
  },

  fire() {
    this.beep(680, 0.22, "sawtooth", 0.06, 120)
  },
  slice() {
    this.beep(240, 0.12, "square", 0.05, 90)
  },
  explode() {
    this.beep(140, 0.4, "square", 0.07, 40)
    this.beep(90, 0.5, "sawtooth", 0.05, 30)
  },
  collect() {
    this.beep(880, 0.09, "sine", 0.05, 1320)
  },
  power() {
    this.beep(520, 0.1, "square", 0.05, 780)
    this.beep(780, 0.12, "square", 0.05, 1180)
  },
  hit() {
    this.beep(200, 0.25, "sawtooth", 0.07, 60)
  },
  shield() {
    this.beep(420, 0.08, "square", 0.04, 300)
  },
  turret() {
    this.beep(320, 0.09, "square", 0.03, 180)
  },
  level() {
    this.beep(523, 0.12, "sine", 0.05)
    this.beep(659, 0.12, "sine", 0.05)
    this.beep(784, 0.18, "sine", 0.05)
  },
}
