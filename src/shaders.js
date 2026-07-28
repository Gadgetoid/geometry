// The GLSL the WebGL2 backend compiles. Nothing here touches the GL context or
// holds any state: it is source text, so glrenderer.js owns every program built
// from it and this file can be read by anything that wants to know what a pass
// actually does. sky.html and effects.html compile these same strings, so a
// preview is the shader the game runs and cannot drift from it.
//
// Naming: `_VS` is a vertex shader, `_FS` a fragment shader, and PROJECT and
// NOISE are prologues pasted into several of them.

// How many distortion sources the composite pass holds. The shader loops over
// fixed-size arrays, so one number bounds both the array and the loop, and
// glrenderer.js sizes its upload buffers from the same pair.
export const LENS_LIMIT = 8
export const TEAR_LIMIT = 6

// Shared vertex prologue: the hand-rolled perspective projection.
export const PROJECT = `
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
export const LINE_VS = `#version 300 es
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
export const LINE_FS = `#version 300 es
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
export const SPRITE_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec2 aUV;
  layout(location=2) in float aExp;
  layout(location=3) in vec4 aColor;
  out vec2 vUV; out float vExp; out vec4 vColor;
  ${PROJECT}
  void main() { vUV = aUV; vExp = aExp; vColor = aColor; gl_Position = project(aPos); }`
export const SPRITE_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; in float vExp; in vec4 vColor;
  out vec4 frag;
  void main() {
    float r = length(vUV);
    float inten = pow(clamp(1.0 - r, 0.0, 1.0), vExp);
    frag = vec4(vColor.rgb * inten, inten * vColor.a);
  }`

// flat alpha triangles: fills, overlays, selection highlights.
export const FLAT_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec4 aColor;
  out vec4 vColor;
  ${PROJECT}
  void main() { vColor = aColor; gl_Position = project(aPos); }`
export const FLAT_FS = `#version 300 es
  precision highp float;
  in vec4 vColor; out vec4 frag;
  void main() { frag = vec4(vColor.rgb * vColor.a, vColor.a); }`

// text from the monospace atlas (coverage stored in the red channel).
export const TEXT_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec2 aUV;
  layout(location=2) in vec4 aColor;
  out vec2 vUV; out vec4 vColor;
  ${PROJECT}
  void main() { vUV = aUV; vColor = aColor; gl_Position = project(aPos); }`
export const TEXT_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uAtlas;
  in vec2 vUV; in vec4 vColor; out vec4 frag;
  void main() {
    float cov = texture(uAtlas, vUV).r;
    frag = vec4(vColor.rgb * cov * vColor.a, cov * vColor.a);
  }`

// procedural planet: a lit sphere with banded fbm surface and an atmosphere rim.
export const PLANET_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec2 aUV;
  out vec2 vUV;
  ${PROJECT}
  void main() { vUV = aUV; gl_Position = project(aPos); }`
export const PLANET_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; out vec4 frag;
  uniform vec3 uBase;    // muted base colour
  uniform vec3 uHi;      // lit / band highlight colour
  uniform vec3 uAtmo;    // atmosphere rim colour
  uniform vec3 uEmit;    // emissive colour (lava / city lights); black = none
  uniform vec2 uLight;   // 2D light direction on the disc
  uniform float uSeed;
  uniform float uTime;
  uniform int uType;     // 0 rocky, 1 volcanic, 2 inhabited, 3 gas, 4 ice,
                         // 5 forge, 6 alien, 7 shattered
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
    } else if (uType == 5) {                // forge: soot bands over furnace light
      // Tighter bands than a gas giant, and the glow is banked in the low ones.
      // It burns on the day side too: industry does not stop for the terminator.
      float bands = sin(sp.y * 13.0 + fbm(sp * 3.0 + uSeed) * 2.2) * 0.5 + 0.5;
      float soot = fbm(sp * 5.0 + uSeed * 2.0);
      albedo = mix(uBase, uHi, smoothstep(0.45, 0.85, mix(bands, soot, 0.45)));
      float furnace = smoothstep(0.30, 0.0, bands) * smoothstep(0.30, 0.62, soot);
      emit += uEmit * furnace * (1.1 + 0.3 * sin(uTime * 1.3 + uSeed * 3.0));
    } else if (uType == 6) {                // alien: cells and bioluminescent veins
      // Big smooth cells with a lit web between them, pulsing slowly and out of
      // phase with every other world in the sector.
      float cells = fbm(sp * 1.7 + uSeed);
      albedo = mix(uBase, uHi, smoothstep(0.35, 0.8, cells));
      float veins = smoothstep(0.84, 0.99, ridged(sp * 2.4 + uSeed * 1.5));
      float pulse = 0.5 + 0.5 * sin(uTime * 0.9 + uSeed * 5.0 + cells * 4.0);
      emit += uEmit * veins * pulse * 1.25;
      // and the body between the veins glows faintly too, on a slower beat, so the
      // whole world breathes rather than a web being lit on a dark ball
      float breath = 0.09 + 0.05 * sin(uTime * 0.42 + uSeed * 3.0);
      emit += uEmit * breath * (0.3 + 0.7 * cells);
    } else if (uType == 7) {                // shattered: a split crust over a cooling core
      float crust = fbm(sp * 3.4 + uSeed);
      albedo = mix(uBase, uHi, smoothstep(0.4, 0.8, crust));
      // The fracture network, and a belt where the crust has come apart
      // altogether. Only the cracks glow; the rest is dead rock.
      float cracks = smoothstep(0.88, 1.0, ridged(sp * 2.8 + uSeed));
      float belt = smoothstep(0.30, 0.0, abs(sp.y + 0.12 * fbm(sp * 2.0 + uSeed)));
      float split = max(cracks, belt * smoothstep(0.55, 0.95, ridged(sp * 6.0 + uSeed)));
      albedo *= 1.0 - belt * 0.55;
      emit += uEmit * split * 0.5;
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
export const FSTRI_VS = `#version 300 es
  precision highp float;
  out vec2 vUV;
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUV = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`
export const BRIGHT_FS = `#version 300 es
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
export const BLUR_FS = `#version 300 es
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
export const NOISE = `
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
export const NEBULA_FS = `#version 300 es
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
export const BLIT_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; out vec4 frag;
  uniform sampler2D uTex;
  void main() { frag = vec4(texture(uTex, vUV).rgb, 1.0); }`

export const COMPOSITE_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; out vec4 frag;
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform float uBloom0;      // bloom intensity
  // How much of the filter to lay over the frame: 0 is flat, 1 is the full tube. Every part
  // of it is scaled by this rather than switched by it, so a half strength is a gentler
  // curve, a narrower aberration, shallower scanlines and a lighter vignette all at once.
  uniform float uCrt;
  uniform float uTime;
  uniform vec3 uWarp;         // xy = ripple centre in uv, z = strength (0 = off)
  uniform float uAspect;
  // Space bent around a thing, and space torn where one has been hit. Lists, because a
  // sector holds more than one alien: xy is the centre in uv, z the strength, w the
  // radius in uv. A count of zero costs one comparison.
  const int LENSES = ${LENS_LIMIT};
  const int TEARS = ${TEAR_LIMIT};
  uniform vec4 uLens[LENSES];
  // The far end of each source. A hull bends space round a point, so its end is its
  // centre; a beam bends it along a line, so the region is a capsule about that line and
  // the same falloff serves both.
  uniform vec2 uLensEnd[LENSES];
  // How much each source ripples as well as pulls: 0 is a smooth bend, above that puts
  // standing waves through the region, which is what a singularity does to the space it
  // is sitting in.
  uniform float uLensWave[LENSES];
  // Where across the region the bend is heaviest. 0 puts it just inside the middle, which swells
  // what is behind a body; 1 puts it out at the rim, so a body's whole outline ripples and its
  // centre stays still. The peak is the same size either way, only somewhere else.
  uniform float uLensHollow[LENSES];
  uniform int uLensCount;
  uniform vec4 uTear[TEARS];
  uniform int uTearCount;
  vec3 sceneSample(vec2 uv) {
    vec3 s = texture(uScene, uv).rgb;
    vec3 b = texture(uBloom, uv).rgb;
    return s + b * uBloom0;
  }
  // No trig. A sine of a large argument is where a hash like this comes apart, and the
  // argument here carried uTime, which is the run's own clock and grows all session: half an
  // hour in it is past five million, where a 24-bit mantissa has no fraction left to take a
  // sine of. Measured under swiftshader the tear lost a quarter of its reach by then, and
  // what happens past that is the driver's business - which is the shape of an effect that
  // shows on one machine and not on another.
  //
  // Nothing in this file may contain a backtick or a dollar: it is a template literal, and
  // one of either ends the shader early. This comment cost a page that would not boot.
  float hash(float n) {
    n = fract(n * 0.1031);
    n *= n + 33.33;
    n *= n + n;
    return fract(n);
  }
  // What an alien does to the space it occupies: samples are drawn inward toward the
  // centre, hardest in the middle and nothing at the edge, so what is behind it swells
  // and slides as it passes. Aspect-corrected, so the region stays round.
  vec2 lens(vec2 uv) {
    for (int i = 0; i < LENSES; i++) {
      if (i >= uLensCount) { break; }
      vec4 l = uLens[i];
      vec2 pa = uv - l.xy;
      vec2 ba = uLensEnd[i] - l.xy;
      pa.x *= uAspect;
      ba.x *= uAspect;
      float span = dot(ba, ba);
      float along = span > 1e-9 ? clamp(dot(pa, ba) / span, 0.0, 1.0) : 0.0;
      vec2 d = pa - ba * along;
      float dist = length(d);
      if (dist >= l.w) { continue; }
      float fall = 1.0 - dist / l.w;
      float across = dist / l.w;
      // How much of the bend lands here. Both profiles are zero at the centre and at the rim and
      // peak the same amount in between; the hollow moves where that peak sits, from a third of
      // the way out to two thirds. The wave rides the same weight, so what warps is what ripples.
      float weight = mix(fall * fall, across * fall, uLensHollow[i]);
      vec2 dir = d / max(dist, 1e-5);
      d.x /= uAspect;
      dir.x /= uAspect;
      uv -= d * (l.z * weight);
      float wave = uLensWave[i];
      if (wave > 0.0) {
        uv += dir * sin(dist * 90.0 - uTime * 7.0) * wave * weight * 0.05;
      }
    }
    return uv;
  }
  // How badly the picture is failing here, over every tear on screen.
  float tearAt(vec2 uv) {
    float worst = 0.0;
    for (int i = 0; i < TEARS; i++) {
      if (i >= uTearCount) { break; }
      vec4 t = uTear[i];
      vec2 d = uv - t.xy;
      d.x *= uAspect;
      float dist = length(d);
      if (dist >= t.w) { continue; }
      worst = max(worst, t.z * (1.0 - dist / t.w));
    }
    return worst;
  }
  // How far one scanline of one colour channel is thrown. Most lines sit still and a few
  // go a long way, which is what tearing looks like: displacing all of them evenly reads
  // as motion blur. The seed is the channel, so the three come apart independently.
  float lineOffset(float line, float seed, float strength) {
    // The clock, wrapped. What this wants of time is that it changes from frame to frame,
    // not what it counts from, so it is held small rather than handed the whole session.
    float tick = mod(floor(uTime * 34.0), 512.0);
    float roll = hash(line * 1.7 + seed + tick * 3.1);
    float thrown = step(1.0 - strength * 0.7, roll);
    float amount = (hash(line * 3.3 + seed + 11.0) - 0.5) * 2.0;
    return thrown * amount * strength * 0.085;
  }
  // The picture coming apart: fine horizontal lines, each thrown by its own amount, each
  // channel thrown separately, and quantised along the line so what has moved reads as
  // data rather than as a smear.
  vec3 torn(vec2 uv, float strength) {
    float line = floor(uv.y * 190.0);
    float blocky = floor(uv.x * 260.0) / 260.0;
    float x = mix(uv.x, blocky, strength);
    return vec3(
      sceneSample(vec2(x + lineOffset(line, 0.0, strength), uv.y)).r,
      sceneSample(vec2(x + lineOffset(line, 7.0, strength), uv.y)).g,
      sceneSample(vec2(x + lineOffset(line, 19.0, strength), uv.y)).b
    );
  }
  // Concentric waves running out from the warp point, strongest at its centre
  // and dying away with distance: the surface of the sector rippling like water.
  vec2 ripple(vec2 uv) {
    if (uWarp.z <= 0.001) { return uv; }
    vec2 d = uv - uWarp.xy;
    d.x *= uAspect;
    float dist = length(d);
    float wave = sin(dist * 52.0 - uTime * 11.0);
    float falloff = exp(-dist * 5.5);
    vec2 dir = d / max(dist, 1e-5);
    dir.x /= uAspect;
    return uv + dir * wave * falloff * uWarp.z * 0.05;
  }
  void main() {
    vec2 uv = vUV;
    if (uCrt > 0.001) {
      // The curve gets its own, slower ramp. It is a geometric change where the rest of the
      // filter is shading, so it reads far stronger than its share: scaled with everything
      // else, a middle setting was all curve and no tube. Squared, so it is gentler through
      // the middle of the range and exactly itself at full strength.
      float bend = uCrt * uCrt;
      // gentle barrel curvature about the centre
      vec2 c = uv * 2.0 - 1.0;
      float r2 = dot(c, c);
      c *= 1.0 + r2 * vec2(0.022, 0.030) * bend;
      uv = c * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        frag = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      uv = lens(ripple(uv));
      float rip = tearAt(uv);
      vec3 col;
      if (rip > 0.001) {
        col = torn(uv, rip);
      } else {
        // chromatic aberration grows toward the edges
        float ca = (0.0006 + 0.0020 * r2) * uCrt;
        vec2 off = normalize(c + 1e-5) * ca;
        col.r = sceneSample(uv + off).r;
        col.g = sceneSample(uv).g;
        col.b = sceneSample(uv - off).b;
      }
      // scanlines + gentle vignette (keeps the curved screen edges visible)
      float scan = 1.0 - (0.07 - 0.07 * sin(uv.y * 1400.0)) * uCrt;
      float vig = mix(1.0, smoothstep(2.7, 0.7, r2), 0.45 * uCrt);
      frag = vec4(col * scan * vig, 1.0);
    } else {
      uv = lens(ripple(uv));
      float rip = tearAt(uv);
      frag = vec4(rip > 0.001 ? torn(uv, rip) : sceneSample(uv), 1.0);
    }
  }`
