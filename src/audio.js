// Tiny synthesised sound effects, created lazily on first user gesture.

import { randRange } from "./math.js"
import { CONFIG } from "./config.js"

const COLLECT_DETUNE = 0.06 // ore pickup pitch spread, about a semitone either way

export const Sound = {
  enabled: false,
  ctx: null,

  unlocked: false,

  ensureContext() {
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)()
      } catch {
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
      } catch {
        /* ignore */
      }
    }
  },

  // Where every voice plays: one gain for the level of the whole mix, then a
  // limiter so a pile-up of explosions is squashed rather than clipped. Each
  // effect's own level only decides where it sits against the others.
  //
  // The silent buffer that unlocks the context in ensureContext goes straight to
  // the destination instead: it exists to be played, not heard.
  chain: null,
  // 0..1, on top of MASTER_VOLUME. The pause menu sets it; the chain is updated in
  // place so a change is heard immediately rather than at the next sound.
  volume: 1,
  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value))
    if (this.chain) {
      this.chain.gain.gain.value = CONFIG.MASTER_VOLUME * this.volume
    }
  },
  output() {
    if (!this.ctx) {
      return null
    }
    if (!this.chain || this.chain.ctx !== this.ctx) {
      const gain = this.ctx.createGain()
      gain.gain.value = CONFIG.MASTER_VOLUME * this.volume
      gain.connect(this.softClip()).connect(this.ctx.destination)
      this.chain = { ctx: this.ctx, gain }
      this.thruster = null // its nodes belonged to the previous chain
    }
    return this.chain.gain
  },

  // A shaper that is exactly linear below AUDIO_SOFT_CLIP and bends smoothly toward
  // full scale above it, so it can never put out more than full scale and never
  // colours anything quieter than the threshold.
  //
  // A compressor node would be the obvious choice and is the wrong one: Chrome's
  // took about 11 dB off a signal sitting at its own knee, so what came out had
  // little to do with the level asked for. This curve is arithmetic, and measurable.
  softClip() {
    const shaper = this.ctx.createWaveShaper()
    const threshold = CONFIG.AUDIO_SOFT_CLIP
    const points = 2048
    const curve = new Float32Array(points)
    for (let i = 0; i < points; i++) {
      const x = (i / (points - 1)) * 2 - 1
      const size = Math.abs(x)
      const shaped =
        size <= threshold
          ? size
          : threshold + (1 - threshold) * Math.tanh((size - threshold) / (1 - threshold))
      curve[i] = Math.sign(x) * shaped
    }
    shaper.curve = curve
    // Deliberately not oversampled. Oversampling would keep the harmonics the bend
    // makes from aliasing, but its interpolation overshoots the curve, and a pile-up
    // of effects measured 1.16 out of a curve that tops out at 0.93 - which the
    // device then clips hard. Aliasing only happens while the mix is saturating,
    // where it is buried; going over full scale is audible as a crack.
    shaper.oversample = "none"
    return shaper
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
      osc.connect(gain).connect(this.output())
      osc.start(now)
      osc.stop(now + duration)
    } catch {
      /* ignore */
    }
  },

  // Short filtered-noise burst, for crunchy / percussive effects. `type` picks
  // the filter: "bandpass" (default) for crisp cracks, "lowpass" for low booms.
  noise(duration, volume, freq, q, type) {
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
      filter.type = type || "bandpass"
      filter.frequency.value = freq || 600
      filter.Q.value = q || 1
      const gain = this.ctx.createGain()
      gain.gain.setValueAtTime(volume || 0.04, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
      src.connect(filter).connect(gain).connect(this.output())
      src.start(now)
      src.stop(now + duration)
    } catch {
      /* ignore */
    }
  },

  // Continuous thruster: a subtle band-passed white-noise bed whose level eases
  // toward on/off. Started lazily once the context exists.
  thruster: null,
  thrusterActive: false,
  setThruster(active) {
    // Runs every frame from the game loop, so it must never throw: a stray
    // exception here would stall the loop. Only a change of state schedules a
    // gain ramp, so the parameter isn't re-automated sixty times a second.
    if (active === this.thrusterActive && this.thruster) {
      return
    }
    this.thrusterActive = active
    try {
      // Never create the context here (this runs in the game loop, not a user
      // gesture): only use one that a gesture has already unlocked, or Safari
      // brings it up muted and silences everything.
      if (!this.ctx || !this.enabled) {
        if (this.thruster && this.ctx) {
          this.thruster.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
        }
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
        src.connect(filter).connect(gain).connect(this.output())
        src.start()
        this.thruster = { gain }
      }
      this.thruster.gain.gain.setTargetAtTime(active ? 0.03 : 0, this.ctx.currentTime, 0.08)
    } catch {
      /* audio is best-effort */
    }
  },

  fire(pitch = 1) {
    this.beep(680 * pitch, 0.22, "sawtooth", 0.06, 120 * pitch)
  },
  // Rising whine as the frigate cannon charges up.
  charge() {
    this.beep(180, 0.85, "sawtooth", 0.035, 720)
  },
  // Frigate main gun: a big, low "pew" with a sub layer and a breath of noise.
  bigLaser() {
    this.beep(520, 0.5, "sawtooth", 0.08, 60)
    this.beep(150, 0.55, "square", 0.05, 40)
    this.noise(0.4, 0.03, 480, 0.6)
  },
  // Knock on contact with a rock or the arena wall: a short menu-style blip.
  bump() {
    this.beep(440, 0.09, "square", 0.04, 300)
  },
  // A rock breaking apart into ore: a short soft crunch with a touch of low
  // rumble underneath for a little weight.
  shatter() {
    this.noise(0.16, 0.035, 1300, 0.6)
    this.noise(0.28, 0.045, 260, 0.7, "lowpass")
    this.beep(220, 0.1, "square", 0.03, 90)
  },
  slice() {
    this.beep(240, 0.12, "square", 0.05, 90)
  },
  explode() {
    this.beep(140, 0.42, "square", 0.05, 40)
    this.beep(90, 0.55, "sawtooth", 0.04, 30)
    this.noise(0.6, 0.11, 340, 0.7, "lowpass") // full low rumble that decays: the boom
    this.noise(0.14, 0.05, 1100, 0.9) // initial crack
  },
  // Ore pickup, detuned a little on each one so a stream of chunks shimmers
  // instead of repeating the same note.
  collect() {
    const pitch = randRange(1 - COLLECT_DETUNE, 1 + COLLECT_DETUNE)
    this.beep(880 * pitch, 0.09, "sine", 0.05, 1320 * pitch)
  },
  // Warp in: a swell rising into place. Warp out: the same, falling away.
  warpIn() {
    this.beep(90, 0.7, "sine", 0.05, 620)
    this.beep(140, 0.55, "triangle", 0.035, 900)
    this.noise(0.5, 0.025, 900, 0.5)
  },
  warpOut() {
    this.beep(620, 0.7, "sine", 0.05, 80)
    this.beep(900, 0.55, "triangle", 0.035, 120)
    this.noise(0.5, 0.025, 900, 0.5)
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
