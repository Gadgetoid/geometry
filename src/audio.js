// Tiny synthesised sound effects, created lazily on first user gesture.

export const Sound = {
  enabled: false,
  ctx: null,

  unlocked: false,

  ensureContext() {
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)()
      } catch (e) {
        /* audio is best-effort */
      }
    }
    if (!this.ctx) {
      return
    }
    // Safari (and Chrome's autoplay policy) hold the context in a non-running
    // state ("suspended" / "interrupted") until it is resumed from a user
    // gesture. Resume whenever it isn't running, and play a one-shot silent
    // buffer, which Safari needs to fully unlock output.
    if (this.ctx.state !== "running" && this.ctx.resume) {
      this.ctx.resume().catch(() => {})
    }
    if (!this.unlocked) {
      try {
        const src = this.ctx.createBufferSource()
        src.buffer = this.ctx.createBuffer(1, 1, 22050)
        src.connect(this.ctx.destination)
        src.start(0)
        this.unlocked = true
      } catch (e) {
        /* ignore */
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

  // Short filtered-noise burst, for crunchy / percussive effects.
  noise(duration, volume, freq, q) {
    if (!this.enabled) {
      return
    }
    this.ensureContext()
    if (!this.ctx) {
      return
    }
    try {
      const now = this.ctx.currentTime
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * duration))
      const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < len; i++) {
        data[i] = Math.random() * 2 - 1
      }
      const src = this.ctx.createBufferSource()
      src.buffer = buffer
      const filter = this.ctx.createBiquadFilter()
      filter.type = "bandpass"
      filter.frequency.value = freq || 600
      filter.Q.value = q || 1
      const gain = this.ctx.createGain()
      gain.gain.setValueAtTime(volume || 0.04, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
      src.connect(filter).connect(gain).connect(this.ctx.destination)
      src.start(now)
      src.stop(now + duration)
    } catch (e) {
      /* ignore */
    }
  },

  // Continuous thruster: a subtle band-passed white-noise bed whose level eases
  // toward on/off. Started lazily once the context exists.
  thruster: null,
  setThruster(active) {
    // Runs every frame from the game loop, so it must never throw: a stray
    // exception here would stall the loop.
    try {
      if (!this.enabled) {
        if (this.thruster && this.ctx) {
          this.thruster.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
        }
        return
      }
      this.ensureContext()
      if (!this.ctx) {
        return
      }
      if (!this.thruster) {
        const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate)
        const data = buffer.getChannelData(0)
        for (let i = 0; i < data.length; i++) {
          data[i] = Math.random() * 2 - 1
        }
        const src = this.ctx.createBufferSource()
        src.buffer = buffer
        src.loop = true
        const filter = this.ctx.createBiquadFilter()
        filter.type = "bandpass"
        filter.frequency.value = 360
        filter.Q.value = 0.7
        const gain = this.ctx.createGain()
        gain.gain.value = 0
        src.connect(filter).connect(gain).connect(this.ctx.destination)
        src.start()
        this.thruster = { gain }
      }
      this.thruster.gain.gain.setTargetAtTime(active ? 0.03 : 0, this.ctx.currentTime, 0.08)
    } catch (e) {
      /* audio is best-effort */
    }
  },

  fire() {
    this.beep(680, 0.22, "sawtooth", 0.06, 120)
  },
  // Frigate main gun: a big, low "pew" with a sub layer and a breath of noise.
  bigLaser() {
    this.beep(520, 0.5, "sawtooth", 0.08, 60)
    this.beep(150, 0.55, "square", 0.05, 40)
    this.noise(0.4, 0.03, 480, 0.6)
  },
  // Ship glancing off a rock: a soft low thud.
  thud() {
    this.beep(78, 0.18, "sine", 0.05, 40)
    this.noise(0.16, 0.035, 240, 0.9)
  },
  // A rock breaking apart into ore: a short soft crunch.
  shatter() {
    this.noise(0.16, 0.035, 1300, 0.6)
    this.beep(220, 0.1, "square", 0.03, 90)
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
