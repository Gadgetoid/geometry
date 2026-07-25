// WebGL2 backend for the Renderer contract (see renderer.js).
//
// The scene is drawn in 3D: every vertex carries a z (layer depth) and the
// vertex shader does the perspective divide by hand (no depth buffer, painter
// order + blending decide compositing). Gameplay sits on the z=0 plane, which
// is framed to fill the viewport exactly, so gameplay matches the 2D backend;
// stars and planets sit at z>0 and therefore shift less under camera shake and
// sway, giving parallax depth.
//
// Passes render into an offscreen HDR-ish scene target. A bloom pass extracts
// and blurs the bright neon, then a final composite adds the bloom and applies
// an optional CRT effect (barrel curvature, chromatic aberration, scanlines,
// vignette) while blitting to the letterboxed on-screen rectangle.
//
// Primitives batch by pipeline: consecutive calls using the same program and
// blend mode accumulate into one buffer and flush on program change or at the
// end of a pass, so painter order is preserved.

import { Renderer } from "./renderer.js"
import { VIEW_W, VIEW_H } from "./config.js"

const SCENE_W = 2048 // fixed internal scene resolution (16:10, matches 1024x640)
const SCENE_H = 1280
const CAMERA_D = 900 // camera distance to the gameplay plane
const HALF_W = VIEW_W / 2
const HALF_H = VIEW_H / 2

// Map a background object's depth (1 = near, 0 = far) to a world z. Gameplay is
// at z=0; larger z is farther and parallaxes less.
const NEAR_Z = 220
const FAR_Z = 1500
const depthToZ = (depth) => FAR_Z + (NEAR_Z - FAR_Z) * depth

// ---- CSS colour parsing (cached via a scratch 2D context) -----------------
// Each miss costs a getImageData readback, so callers should pass a fixed
// colour plus an `alpha` option instead of interpolating a value into an
// rgba() string. The cap bounds the damage if one slips through.
const COLOUR_CACHE_MAX = 4096
const colourCache = new Map()
const colourCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
function parseColour(str) {
  if (str == null) {
    return [1, 1, 1, 1]
  }
  let hit = colourCache.get(str)
  if (hit) {
    return hit
  }
  if (colourCache.size >= COLOUR_CACHE_MAX) {
    colourCache.clear()
  }
  colourCtx.clearRect(0, 0, 1, 1)
  colourCtx.fillStyle = "#000"
  colourCtx.fillStyle = str
  colourCtx.fillRect(0, 0, 1, 1)
  const d = colourCtx.getImageData(0, 0, 1, 1).data
  hit = [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255]
  colourCache.set(str, hit)
  return hit
}

// ---- shader helpers -------------------------------------------------------
function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("shader compile: " + gl.getShaderInfoLog(sh) + "\n" + src)
  }
  return sh
}
function program(gl, vs, fs) {
  const p = gl.createProgram()
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("program link: " + gl.getProgramInfoLog(p))
  }
  return p
}

// Shared vertex prologue: the hand-rolled perspective projection.
const PROJECT = `
  uniform vec2 uEye;
  uniform float uD;
  uniform vec2 uHalf;
  vec4 project(vec3 p) {
    float dist = uD + p.z;
    float ndcX = (p.x - uEye.x) / dist * (uD / uHalf.x);
    float ndcY = -((p.y - uEye.y) / dist * (uD / uHalf.y));
    return vec4(ndcX, ndcY, 0.0, 1.0);
  }
`

// line / stroke quads: bright core plus soft transverse halo, additive.
const LINE_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec2 aLine;     // edge (transverse), long (along, 0..L core)
  layout(location=2) in vec3 aParams;   // halfCore, halfTotal, L
  layout(location=3) in vec4 aColor;
  out vec2 vLine;
  out vec3 vParams;
  out vec4 vColor;
  ${PROJECT}
  void main() {
    vLine = aLine; vParams = aParams; vColor = aColor;
    gl_Position = project(aPos);
  }`
// Capsule distance field: distance to the core segment (round caps), so
// segments sharing an endpoint overlap smoothly with no gap at the join.
const LINE_FS = `#version 300 es
  precision highp float;
  in vec2 vLine; in vec3 vParams; in vec4 vColor;
  out vec4 frag;
  void main() {
    float over = max(max(0.0, -vLine.y), vLine.y - vParams.z);
    float d = sqrt(over * over + vLine.x * vLine.x);
    float core = 1.0 - smoothstep(vParams.x - 1.0, vParams.x + 0.5, d);
    float halo = pow(clamp(1.0 - d / vParams.y, 0.0, 1.0), 2.2);
    float inten = max(core, halo * 0.7);
    frag = vec4(vColor.rgb * inten, inten * vColor.a);
  }`

// soft round sprites: stars, particles glow, disc fills, additive.
const SPRITE_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec2 aUV;
  layout(location=2) in float aExp;
  layout(location=3) in vec4 aColor;
  out vec2 vUV; out float vExp; out vec4 vColor;
  ${PROJECT}
  void main() { vUV = aUV; vExp = aExp; vColor = aColor; gl_Position = project(aPos); }`
const SPRITE_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; in float vExp; in vec4 vColor;
  out vec4 frag;
  void main() {
    float r = length(vUV);
    float inten = pow(clamp(1.0 - r, 0.0, 1.0), vExp);
    frag = vec4(vColor.rgb * inten, inten * vColor.a);
  }`

// flat alpha triangles: fills, overlays, selection highlights.
const FLAT_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec4 aColor;
  out vec4 vColor;
  ${PROJECT}
  void main() { vColor = aColor; gl_Position = project(aPos); }`
const FLAT_FS = `#version 300 es
  precision highp float;
  in vec4 vColor; out vec4 frag;
  void main() { frag = vec4(vColor.rgb * vColor.a, vColor.a); }`

// text from the monospace atlas (coverage stored in the red channel).
const TEXT_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec2 aUV;
  layout(location=2) in vec4 aColor;
  out vec2 vUV; out vec4 vColor;
  ${PROJECT}
  void main() { vUV = aUV; vColor = aColor; gl_Position = project(aPos); }`
const TEXT_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uAtlas;
  in vec2 vUV; in vec4 vColor; out vec4 frag;
  void main() {
    float cov = texture(uAtlas, vUV).r;
    frag = vec4(vColor.rgb * cov * vColor.a, cov * vColor.a);
  }`

// procedural planet: a lit sphere with banded fbm surface and an atmosphere rim.
const PLANET_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec2 aUV;
  out vec2 vUV;
  ${PROJECT}
  void main() { vUV = aUV; gl_Position = project(aPos); }`
const PLANET_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; out vec4 frag;
  uniform vec3 uBase;    // muted base colour
  uniform vec3 uHi;      // lit / band highlight colour
  uniform vec3 uAtmo;    // atmosphere rim colour
  uniform vec3 uEmit;    // emissive colour (lava / city lights); black = none
  uniform vec2 uLight;   // 2D light direction on the disc
  uniform float uSeed;
  uniform float uTime;
  uniform int uType;     // 0 rocky, 1 volcanic, 2 inhabited, 3 gas, 4 ice
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    float a = hash(i), b = hash(i+vec2(1.0,0.0));
    float c = hash(i+vec2(0.0,1.0)), d = hash(i+vec2(1.0,1.0));
    return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
  }
  float fbm(vec2 p){
    float v = 0.0, amp = 0.5;
    for (int i = 0; i < 5; i++){ v += amp * noise(p); p *= 2.03; amp *= 0.5; }
    return v;
  }
  float ridged(vec2 p){ return 1.0 - abs(2.0 * fbm(p) - 1.0); }
  void main() {
    float r = length(vUV);
    if (r > 1.0) discard;
    vec3 n = vec3(vUV, sqrt(max(0.0, 1.0 - r*r)));
    vec2 sp = vUV / (0.35 + 0.65 * n.z); // spherical-ish surface coords
    float lambert = clamp(dot(normalize(vec3(uLight, 0.85)), n), 0.0, 1.0);
    vec3 albedo;
    vec3 emit = vec3(0.0);
    if (uType == 3) {                       // gas giant: latitude bands
      float bands = sin(sp.y * 6.0 + fbm(sp * 2.0 + uSeed) * 3.0) * 0.5 + 0.5;
      float swirl = fbm(vec2(sp.x * 0.7, sp.y * 3.2) + uSeed);
      albedo = mix(uBase, uHi, smoothstep(0.3, 0.75, mix(bands, swirl, 0.4)));
    } else if (uType == 4) {                // ice
      albedo = mix(uBase, uHi, smoothstep(0.4, 0.78, fbm(sp * 4.0 + uSeed)));
    } else if (uType == 1) {                // volcanic: glowing lava veins
      albedo = mix(uBase, uHi, fbm(sp * 4.0 + uSeed) * 0.5);
      float lava = smoothstep(0.80, 0.97, ridged(sp * 3.2 + uSeed * 2.0));
      emit += uEmit * lava * (2.0 + 0.6 * sin(uTime * 2.0 + uSeed));
    } else if (uType == 2) {                // inhabited: city lights on the night side
      float land = fbm(sp * 3.0 + uSeed);
      albedo = mix(uBase, uHi, smoothstep(0.45, 0.7, land));
      float night = 1.0 - smoothstep(0.02, 0.32, lambert);
      float cities = smoothstep(0.68, 0.9, fbm(sp * 15.0 + uSeed * 4.0));
      emit += uEmit * cities * night * step(0.48, land) * 1.8;
    } else {                                // rocky
      float bands = fbm(sp * 2.2 + uSeed);
      float mottle = fbm(sp * 6.0 + uSeed * 3.0);
      albedo = mix(uBase, uHi, smoothstep(0.35, 0.75, mix(bands, mottle, 0.35)));
    }
    float shade = 0.12 + 0.72 * lambert;
    vec3 col = albedo * shade;
    float rim = pow(1.0 - n.z, 2.5);
    float lit = clamp(dot(normalize(uLight), normalize(vUV + 1e-3)), 0.0, 1.0);
    col += uAtmo * rim * (0.28 + 0.5 * lit);
    col *= 0.6;    // dim the lit body so planets read as distant background
    col += emit;   // emissive stays bright so it glows through bloom
    float edge = smoothstep(1.0, 0.985, r);
    frag = vec4(col * edge, edge);
  }`

// full-screen passes (bloom + composite) share a fullscreen-triangle VS.
const FSTRI_VS = `#version 300 es
  precision highp float;
  out vec2 vUV;
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUV = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`
const BRIGHT_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; out vec4 frag;
  uniform sampler2D uTex;
  uniform float uThreshold;
  void main() {
    vec3 c = texture(uTex, vUV).rgb;
    float l = max(max(c.r, c.g), c.b);
    float k = max(0.0, l - uThreshold) / max(l, 1e-4);
    frag = vec4(c * k, 1.0);
  }`
const BLUR_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; out vec4 frag;
  uniform sampler2D uTex;
  uniform vec2 uDir;   // texel step along one axis
  void main() {
    vec3 sum = texture(uTex, vUV).rgb * 0.227027;
    sum += texture(uTex, vUV + uDir * 1.3846).rgb * 0.316216;
    sum += texture(uTex, vUV - uDir * 1.3846).rgb * 0.316216;
    sum += texture(uTex, vUV + uDir * 3.2308).rgb * 0.070270;
    sum += texture(uTex, vUV - uDir * 3.2308).rgb * 0.070270;
    frag = vec4(sum, 1.0);
  }`
// value-noise fbm, shared by the nebula
const NOISE = `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    float a = hash(i), b = hash(i+vec2(1.0,0.0));
    float c = hash(i+vec2(0.0,1.0)), d = hash(i+vec2(1.0,1.0));
    return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
  }
  float fbm(vec2 p){
    float v = 0.0, amp = 0.5;
    for (int i = 0; i < 5; i++){ v += amp * noise(p); p *= 2.03; amp *= 0.5; }
    return v;
  }
`
// faint muted nebula clouds + fine dust, drawn as the deep-space base layer.
const NEBULA_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; out vec4 frag;
  uniform float uTime; uniform vec2 uScroll;
  uniform vec3 uColA; uniform vec3 uColB; uniform float uSeed;
  ${NOISE}
  void main() {
    vec2 p = vUV * vec2(1.6, 1.0) * 2.4 + uScroll * 0.0004 + uSeed;
    float n1 = fbm(p * 1.3 + vec2(uTime * 0.004, 0.0));
    float n2 = fbm(p * 2.7 - vec2(0.0, uTime * 0.003) + 5.0);
    float clouds = smoothstep(0.42, 0.95, n1 * 0.65 + n2 * 0.45);
    vec3 col = mix(uColA, uColB, n2) * clouds * 0.9;
    float dust = smoothstep(0.72, 0.97, fbm(p * 20.0 + uScroll * 0.001)) * 0.10;
    vec3 base = vec3(0.008, 0.016, 0.04);
    frag = vec4(base + col + dust, 1.0);
  }`
// straight texture copy (used to blit the blurred background into the scene).
const BLIT_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; out vec4 frag;
  uniform sampler2D uTex;
  void main() { frag = vec4(texture(uTex, vUV).rgb, 1.0); }`

const COMPOSITE_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; out vec4 frag;
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform float uBloom0;      // bloom intensity
  uniform float uCrt;         // 0 = flat, 1 = full CRT
  uniform float uTime;
  vec3 sceneSample(vec2 uv) {
    vec3 s = texture(uScene, uv).rgb;
    vec3 b = texture(uBloom, uv).rgb;
    return s + b * uBloom0;
  }
  void main() {
    vec2 uv = vUV;
    if (uCrt > 0.5) {
      // gentle barrel curvature about the centre
      vec2 c = uv * 2.0 - 1.0;
      float r2 = dot(c, c);
      c *= 1.0 + r2 * vec2(0.022, 0.030);
      uv = c * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        frag = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      // chromatic aberration grows toward the edges
      float ca = 0.0006 + 0.0020 * r2;
      vec2 off = normalize(c + 1e-5) * ca;
      vec3 col;
      col.r = sceneSample(uv + off).r;
      col.g = sceneSample(uv).g;
      col.b = sceneSample(uv - off).b;
      // scanlines + gentle vignette (keeps the curved screen edges visible)
      float scan = 0.93 + 0.07 * sin(uv.y * 1400.0);
      float vig = mix(1.0, smoothstep(2.7, 0.7, r2), 0.45);
      frag = vec4(col * scan * vig, 1.0);
    } else {
      frag = vec4(sceneSample(uv), 1.0);
    }
  }`

// ---- monospace font atlas -------------------------------------------------
const ATLAS_FONT = 44
const FIRST_CODE = 32
const LAST_CODE = 126
function buildAtlas() {
  const measure = document.createElement("canvas").getContext("2d")
  measure.font = `${ATLAS_FONT}px ui-monospace, Menlo, monospace`
  const adv = Math.ceil(measure.measureText("M").width)
  const cellW = adv + 6
  const cellH = ATLAS_FONT + 18
  const baseline = ATLAS_FONT + 4 // baseline offset from the cell top
  const count = LAST_CODE - FIRST_CODE + 1
  const cols = 16
  const rowsPerWeight = Math.ceil(count / cols)
  const rows = rowsPerWeight * 2 // regular then bold
  const canvas = document.createElement("canvas")
  canvas.width = cols * cellW
  canvas.height = rows * cellH
  const ctx = canvas.getContext("2d")
  ctx.textBaseline = "alphabetic"
  ctx.textAlign = "left"
  ctx.fillStyle = "#fff"
  for (let weight = 0; weight < 2; weight++) {
    ctx.font = `${weight ? "bold " : ""}${ATLAS_FONT}px ui-monospace, Menlo, monospace`
    for (let i = 0; i < count; i++) {
      const col = i % cols
      const row = Math.floor(i / cols) + weight * rowsPerWeight
      const ch = String.fromCharCode(FIRST_CODE + i)
      ctx.fillText(ch, col * cellW + 3, row * cellH + baseline)
    }
  }
  return { canvas, cellW, cellH, adv, baseline, cols, rowsPerWeight }
}

// ---------------------------------------------------------------------------
export class WebGLRenderer extends Renderer {
  // Returns null when this backend is unavailable, so the caller can fall back
  // to Canvas 2D. Shader compilation and framebuffer setup are the likely
  // failure points on unusual drivers, so both are caught here.
  static create(canvas) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
    })
    if (!gl) {
      return null
    }
    try {
      return new WebGLRenderer(canvas, gl)
    } catch (error) {
      console.warn("WebGL backend unavailable, falling back to Canvas 2D:", error)
      return null
    }
  }

  constructor(canvas, gl) {
    super()
    this.canvas = canvas
    this.gl = gl
    this.crtEnabled = true
    this.time = 0
    this.eye = [HALF_W, HALF_H]
    this.passZ = 0

    this.batch = { prog: null, verts: [], floats: 0 }

    this.#initPrograms()
    this.#initBuffers()
    this.#initTargets()
    this.#initAtlas()

    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
  }

  #initPrograms() {
    const gl = this.gl
    this.progs = {
      line: program(gl, LINE_VS, LINE_FS),
      sprite: program(gl, SPRITE_VS, SPRITE_FS),
      flat: program(gl, FLAT_VS, FLAT_FS),
      text: program(gl, TEXT_VS, TEXT_FS),
      planet: program(gl, PLANET_VS, PLANET_FS),
      bright: program(gl, FSTRI_VS, BRIGHT_FS),
      blur: program(gl, FSTRI_VS, BLUR_FS),
      nebula: program(gl, FSTRI_VS, NEBULA_FS),
      blit: program(gl, FSTRI_VS, BLIT_FS),
      composite: program(gl, FSTRI_VS, COMPOSITE_FS),
    }
    // Polygon strokes reuse the line shader but composite with MAX blending, so
    // overlapping round caps at shared vertices take the brightest value rather
    // than summing into dots. Works for concave outlines (no miter maths).
    this.progs.poly = this.progs.line
    // per-pipeline vertex layout: [location, size] entries, and blend mode.
    const LINE_ATTRS = [[0, 3], [1, 2], [2, 3], [3, 4]]
    this.layouts = {
      line: { stride: 12, attrs: LINE_ATTRS, blend: "add" },
      poly: { stride: 12, attrs: LINE_ATTRS, blend: "max" },
      sprite: { stride: 10, attrs: [[0, 3], [1, 2], [2, 1], [3, 4]], blend: "add" },
      flat: { stride: 7, attrs: [[0, 3], [1, 4]], blend: "alpha" },
      text: { stride: 9, attrs: [[0, 3], [1, 2], [2, 4]], blend: "alpha" },
    }
  }

  #initBuffers() {
    const gl = this.gl
    this.vao = gl.createVertexArray()
    this.vbo = gl.createBuffer()
    this.quadVao = gl.createVertexArray() // for planet quads (pos + uv)
    this.quadVbo = gl.createBuffer()
    this.emptyVao = gl.createVertexArray() // for fullscreen-triangle passes
  }

  #makeTarget(w, h) {
    const gl = this.gl
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (this.floatTargets) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`incomplete framebuffer at ${w}x${h}`)
    }
    return { tex, fbo, w, h }
  }

  #initTargets() {
    const gl = this.gl
    // RGBA16F lets neon glow accumulate past 1.0 for a real bloom threshold.
    // Without it the targets clamp at 1.0 and bloom picks up only the brightest
    // cores, which still reads correctly.
    this.floatTargets = !!gl.getExtension("EXT_color_buffer_float")
    this.scene = this.#makeTarget(SCENE_W, SCENE_H)
    // background renders half-res then upscales, giving a cheap depth-of-field
    this.bg = this.#makeTarget(SCENE_W >> 1, SCENE_H >> 1)
    this.bloomA = this.#makeTarget(SCENE_W >> 1, SCENE_H >> 1)
    this.bloomB = this.#makeTarget(SCENE_W >> 1, SCENE_H >> 1)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  #initAtlas() {
    const gl = this.gl
    const a = buildAtlas()
    this.atlas = a
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    // glyph coverage in a single R8 channel (canvas alpha is the coverage)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      a.canvas.width,
      a.canvas.height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      this.#atlasCoverage(a.canvas),
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.atlasTex = tex
  }

  #atlasCoverage(canvas) {
    const ctx = canvas.getContext("2d")
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const cov = new Uint8Array(canvas.width * canvas.height)
    for (let i = 0; i < cov.length; i++) {
      cov[i] = img.data[i * 4 + 3] // alpha channel is the glyph coverage
    }
    return cov
  }

  // ---- frame lifecycle ----------------------------------------------------
  // Background (nebula, planets, stars) renders into the half-res bg target,
  // then compositeBackground() blurs and upscales it into the full-res scene,
  // giving depth of field. World and HUD passes then draw sharp over the top.
  beginFrame(time) {
    this.time = time
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bg.fbo)
    gl.viewport(0, 0, this.bg.w, this.bg.h)
  }

  clearFrame(color) {
    const gl = this.gl
    const c = parseColour(color)
    gl.clearColor(c[0], c[1], c[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  nebula(scrollX = 0, scrollY = 0, colorA = "#0f1226", colorB = "#1a0f22", seed = 0) {
    const gl = this.gl
    const prog = this.progs.nebula
    const a = parseColour(colorA),
      b = parseColour(colorB)
    gl.disable(gl.BLEND)
    gl.useProgram(prog)
    gl.uniform1f(gl.getUniformLocation(prog, "uTime"), this.time)
    gl.uniform2f(gl.getUniformLocation(prog, "uScroll"), scrollX, scrollY)
    gl.uniform3f(gl.getUniformLocation(prog, "uColA"), a[0], a[1], a[2])
    gl.uniform3f(gl.getUniformLocation(prog, "uColB"), b[0], b[1], b[2])
    gl.uniform1f(gl.getUniformLocation(prog, "uSeed"), seed)
    gl.bindVertexArray(this.emptyVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.enable(gl.BLEND)
  }

  compositeBackground() {
    this.#flush()
    const gl = this.gl
    gl.disable(gl.BLEND)
    // soften the background for depth of field
    this.#blurPass(this.bg, this.bloomA, [1.2 / this.bg.w, 0])
    this.#blurPass(this.bloomA, this.bg, [0, 1.2 / this.bg.h])
    // upscale the blurred background into the full-res scene target
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo)
    gl.viewport(0, 0, SCENE_W, SCENE_H)
    this.#blit(this.bg.tex)
    gl.enable(gl.BLEND)
  }

  #blit(tex) {
    const gl = this.gl
    gl.useProgram(this.progs.blit)
    this.#bindTex(this.progs.blit, "uTex", tex, 0)
    gl.bindVertexArray(this.emptyVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  pushView(camera) {
    // The eye is the world point shown at the screen centre (camera follow),
    // plus shake and sway. HUD / background passes omit centerX, so the eye
    // stays at the screen centre and the projection is a straight 2D mapping.
    const cx = camera.centerX ?? HALF_W
    const cy = camera.centerY ?? HALF_H
    const sx = camera.shakeX || 0,
      sy = camera.shakeY || 0
    const px = camera.panX || 0,
      py = camera.panY || 0
    this.eye = [cx + sx + px, cy + sy + py]
    this.passZ = camera.z || 0
  }

  popView() {
    this.#flush()
  }

  endFrame() {
    this.#flush()
    this.#bloom()
    this.#composite()
  }

  // ---- batching -----------------------------------------------------------
  #use(progName) {
    if (this.batch.prog && this.batch.prog !== progName) {
      this.#flush()
    }
    this.batch.prog = progName
  }
  #push(...values) {
    const v = this.batch.verts
    for (let i = 0; i < values.length; i++) {
      v.push(values[i])
    }
  }

  #flush() {
    const b = this.batch
    if (!b.prog || b.verts.length === 0) {
      b.verts.length = 0
      return
    }
    const gl = this.gl
    const layout = this.layouts[b.prog]
    const prog = this.progs[b.prog]
    gl.useProgram(prog)
    gl.uniform2f(gl.getUniformLocation(prog, "uEye"), this.eye[0], this.eye[1])
    gl.uniform1f(gl.getUniformLocation(prog, "uD"), CAMERA_D)
    gl.uniform2f(gl.getUniformLocation(prog, "uHalf"), HALF_W, HALF_H)
    if (b.prog === "text") {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex)
      gl.uniform1i(gl.getUniformLocation(prog, "uAtlas"), 0)
    }
    if (layout.blend === "max") {
      gl.blendEquation(gl.MAX)
      gl.blendFunc(gl.ONE, gl.ONE) // factors ignored for MAX
    } else {
      gl.blendEquation(gl.FUNC_ADD)
      gl.blendFunc(gl.SRC_ALPHA, layout.blend === "alpha" ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE)
    }

    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.verts), gl.STREAM_DRAW)
    const stride = layout.stride * 4
    let offset = 0
    for (const [loc, size] of layout.attrs) {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset)
      offset += size * 4
    }
    gl.drawArrays(gl.TRIANGLES, 0, b.verts.length / layout.stride)
    gl.bindVertexArray(null)
    gl.blendEquation(gl.FUNC_ADD) // restore for other passes (MAX is per-batch)

    b.verts.length = 0
    b.prog = null
  }

  // ---- geometry builders --------------------------------------------------
  // Capsule quad. capScale extends the ends for round caps (1 = fully round,
  // 0 = butt). Round caps let polygon-stroke segments overlap at shared vertices
  // to close corners; under the MAX "poly" pipeline the overlap doesn't brighten.
  #lineQuad(ax, ay, bx, by, z, core, total, col, capScale = 0) {
    let dx = bx - ax,
      dy = by - ay
    const len = Math.hypot(dx, dy) || 1
    dx /= len
    dy /= len
    const px = -dy,
      py = dx
    const cap = total * capScale
    const axe = ax - dx * cap,
      aye = ay - dy * cap // extended A end (long = -cap)
    const bxe = bx + dx * cap,
      bye = by + dy * cap // extended B end (long = len + cap)
    const [r, g, bl, a] = col
    // vertex: pos, edge (transverse), long (along), halfCore, halfTotal, len, rgba
    const corner = (x, y, edge, long) =>
      this.#push(x + px * edge, y + py * edge, z, edge, long, core, total, len, r, g, bl, a)
    corner(axe, aye, -total, -cap)
    corner(bxe, bye, -total, len + cap)
    corner(bxe, bye, total, len + cap)
    corner(axe, aye, -total, -cap)
    corner(bxe, bye, total, len + cap)
    corner(axe, aye, total, -cap)
  }

  #spriteQuad(x, y, z, radius, exp, col) {
    const [r, g, b, a] = col
    const v = (dx, dy) => this.#push(x + dx * radius, y + dy * radius, z, dx, dy, exp, r, g, b, a)
    v(-1, -1)
    v(1, -1)
    v(1, 1)
    v(-1, -1)
    v(1, 1)
    v(-1, 1)
  }

  #flatTri(pts, col) {
    const [r, g, b, a] = col
    for (const p of pts) {
      this.#push(p.x, p.y, this.passZ, r, g, b, a)
    }
  }

  // ---- Renderer contract --------------------------------------------------
  // Polygon / polyline stroke: each edge is a round-capped capsule drawn with
  // MAX blending (the "poly" pipeline). Round caps close the corners on any
  // shape (convex or concave, no miter maths), and MAX means the overlapping
  // caps at a shared vertex take the brightest value instead of summing, so
  // there are no gaps and no over-bright dots.
  strokePoly(points, opts = {}) {
    const c = this.#col(opts)
    // MAX blending ignores per-vertex alpha, so bake alpha into the colour to
    // preserve fades (shield energy/pulse, radar distance, etc.)
    const col = [c[0] * c[3], c[1] * c[3], c[2] * c[3], 1]
    const core = (opts.width ?? 1.6) / 2
    const total = core + (opts.glow || 0) * 0.5 + 1.2
    const closed = opts.closed !== false
    const n = points.length
    if (n < 2) {
      return
    }
    this.#use("poly")
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = points[i],
        b = points[(i + 1) % n]
      this.#lineQuad(a.x, a.y, b.x, b.y, this.passZ, core, total, col, 1)
    }
  }

  fillPoly(points, opts = {}) {
    const col = this.#col(opts)
    this.#use("flat")
    for (let i = 1; i < points.length - 1; i++) {
      this.#flatTri([points[0], points[i], points[i + 1]], col)
    }
  }

  line(ax, ay, bx, by, opts = {}) {
    const col = this.#col(opts)
    const core = (opts.width ?? 1.6) / 2
    const total = core + (opts.glow || 0) * 0.5 + 1.2
    this.#use("line")
    this.#lineQuad(ax, ay, bx, by, this.passZ, core, total, col, 1)
  }

  circle(x, y, r, opts = {}) {
    if (opts.fill) {
      const col = this.#col({ color: opts.fill, alpha: opts.alpha })
      this.#use("sprite")
      this.#spriteQuad(x, y, this.passZ, r * 1.35, 1.4, col)
    }
    if (opts.stroke) {
      const pts = []
      const seg = 40
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2
        pts.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r })
      }
      this.strokePoly(pts, { color: opts.stroke, width: opts.width, glow: opts.glow, alpha: opts.alpha })
    }
  }

  rect(x, y, w, h, opts = {}) {
    if (opts.fill) {
      const col = this.#col({ color: opts.fill, alpha: opts.alpha })
      this.#use("flat")
      this.#flatTri(
        [
          { x, y },
          { x: x + w, y },
          { x: x + w, y: y + h },
        ],
        col,
      )
      this.#flatTri(
        [
          { x, y },
          { x: x + w, y: y + h },
          { x, y: y + h },
        ],
        col,
      )
    }
    if (opts.stroke) {
      this.strokePoly(
        [
          { x, y },
          { x: x + w, y },
          { x: x + w, y: y + h },
          { x, y: y + h },
        ],
        { color: opts.stroke, width: opts.width ?? 1, glow: opts.glow, alpha: opts.alpha, closed: true },
      )
    }
  }

  point(x, y, size, opts = {}) {
    const col = this.#col(opts)
    const z = opts.depth != null ? depthToZ(opts.depth) : this.passZ
    this.#use("sprite")
    this.#spriteQuad(x, y, z, Math.max(size, 1) * 1.7, 1.5, col)
  }

  text(str, x, y, opts = {}) {
    const size = opts.size || 12
    const col = this.#col(opts)
    const a = this.atlas
    const scale = size / ATLAS_FONT
    const adv = a.adv * scale
    const total = str.length * adv
    let penX = opts.align === "right" ? x - total : opts.align === "center" ? x - total / 2 : x
    // alphabetic baseline at y; middle baseline nudges the run down toward centre
    const baselineY = opts.baseline === "middle" ? y + size * 0.36 : y
    const top = baselineY - a.baseline * scale
    const cw = a.cellW * scale
    const ch = a.cellH * scale
    const du = a.cellW / a.canvas.width
    const dv = a.cellH / a.canvas.height
    const [r, g, b, al] = col
    const bold = opts.bold ? 1 : 0
    this.#use("text")
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i)
      penX += adv
      if (code < FIRST_CODE || code > LAST_CODE || code === 32) {
        continue
      }
      const idx = code - FIRST_CODE
      const col0 = idx % a.cols
      const row0 = Math.floor(idx / a.cols) + bold * a.rowsPerWeight
      const u0 = col0 * du,
        v0 = row0 * dv
      const x0 = penX - adv,
        y0 = top
      const quad = (dx, dy) =>
        this.#push(x0 + dx * cw, y0 + dy * ch, this.passZ, u0 + dx * du, v0 + dy * dv, r, g, b, al)
      quad(0, 0)
      quad(1, 0)
      quad(1, 1)
      quad(0, 0)
      quad(1, 1)
      quad(0, 1)
    }
  }

  planet(x, y, r, opts = {}) {
    this.#flush()
    const gl = this.gl
    const prog = this.progs.planet
    const z = opts.depth != null ? depthToZ(opts.depth) : this.passZ
    gl.useProgram(prog)
    gl.uniform2f(gl.getUniformLocation(prog, "uEye"), this.eye[0], this.eye[1])
    gl.uniform1f(gl.getUniformLocation(prog, "uD"), CAMERA_D)
    gl.uniform2f(gl.getUniformLocation(prog, "uHalf"), HALF_W, HALF_H)
    const base = parseColour(opts.base || "#3a4a63")
    const hi = parseColour(opts.hi || "#7f93a8")
    const atmo = parseColour(opts.atmo || "#8fb7d6")
    const emit = parseColour(opts.emit || "#000000")
    gl.uniform3f(gl.getUniformLocation(prog, "uBase"), base[0], base[1], base[2])
    gl.uniform3f(gl.getUniformLocation(prog, "uHi"), hi[0], hi[1], hi[2])
    gl.uniform3f(gl.getUniformLocation(prog, "uAtmo"), atmo[0], atmo[1], atmo[2])
    gl.uniform3f(gl.getUniformLocation(prog, "uEmit"), emit[0], emit[1], emit[2])
    gl.uniform1i(gl.getUniformLocation(prog, "uType"), opts.type || 0)
    const la = opts.light != null ? opts.light : -0.7
    gl.uniform2f(gl.getUniformLocation(prog, "uLight"), Math.cos(la), Math.sin(la))
    gl.uniform1f(gl.getUniformLocation(prog, "uSeed"), opts.seed || 1.0)
    gl.uniform1f(gl.getUniformLocation(prog, "uTime"), this.time)

    const verts = new Float32Array([
      x - r, y - r, z, -1, -1,
      x + r, y - r, z, 1, -1,
      x + r, y + r, z, 1, 1,
      x - r, y - r, z, -1, -1,
      x + r, y + r, z, 1, 1,
      x - r, y + r, z, -1, 1,
    ])
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.quadVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STREAM_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
  }

  #col(opts) {
    const c = parseColour(opts.color)
    const a = (opts.alpha ?? 1) * (c[3] ?? 1)
    return [c[0], c[1], c[2], a]
  }

  // ---- post processing ----------------------------------------------------
  #bloom() {
    const gl = this.gl
    const bw = SCENE_W >> 1,
      bh = SCENE_H >> 1
    gl.blendFunc(gl.ONE, gl.ZERO)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.emptyVao)

    // bright pass: scene -> bloomA
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo)
    gl.viewport(0, 0, bw, bh)
    gl.useProgram(this.progs.bright)
    this.#bindTex(this.progs.bright, "uTex", this.scene.tex, 0)
    gl.uniform1f(gl.getUniformLocation(this.progs.bright, "uThreshold"), 0.55)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // separable blur, two iterations for a wide, soft glow
    for (let i = 0; i < 2; i++) {
      this.#blurPass(this.bloomA, this.bloomB, [1.5 / bw, 0])
      this.#blurPass(this.bloomB, this.bloomA, [0, 1.5 / bh])
    }
    gl.enable(gl.BLEND)
  }

  #blurPass(src, dst, dir) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
    gl.viewport(0, 0, dst.w, dst.h)
    gl.useProgram(this.progs.blur)
    this.#bindTex(this.progs.blur, "uTex", src.tex, 0)
    gl.uniform2f(gl.getUniformLocation(this.progs.blur, "uDir"), dir[0], dir[1])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  #composite() {
    const gl = this.gl
    gl.disable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    // letterbox: clear the whole canvas, then draw into the content rectangle
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0.008, 0.016, 0.04, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const rect = this.contentRect || { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height }
    gl.viewport(rect.x, rect.y, rect.w, rect.h)
    const prog = this.progs.composite
    gl.useProgram(prog)
    this.#bindTex(prog, "uScene", this.scene.tex, 0)
    this.#bindTex(prog, "uBloom", this.bloomA.tex, 1)
    gl.uniform1f(gl.getUniformLocation(prog, "uBloom0"), 1.25)
    gl.uniform1f(gl.getUniformLocation(prog, "uCrt"), this.crtEnabled ? 1 : 0)
    gl.uniform1f(gl.getUniformLocation(prog, "uTime"), this.time)
    gl.bindVertexArray(this.emptyVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.enable(gl.BLEND)
  }

  #bindTex(prog, name, tex, unit) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(gl.getUniformLocation(prog, name), unit)
  }

  // Called by the view on resize with the letterboxed content rectangle in
  // device pixels (origin bottom-left for gl.viewport).
  setContentRect(xCss, yCss, wCss, hCss, dpr) {
    const w = Math.round(wCss * dpr),
      h = Math.round(hCss * dpr)
    const x = Math.round(xCss * dpr)
    // gl viewport origin is bottom-left; flip y from the top-left CSS rect
    const y = this.canvas.height - Math.round(yCss * dpr) - h
    this.contentRect = { x, y, w, h }
  }
}
