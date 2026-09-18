/**
 * The map's categorical colours, checked against colour blindness.
 *
 * The dots are the only thing that distinguishes one kind of farm from another
 * at a glance, so the palette is a functional decision rather than a
 * decorative one. It was red, amber and green until this test existed, which
 * put the two most important categories — "you can pick here" and "we do not
 * know" — on the classic confusion pair.
 *
 * Simulation uses the Viénot–Brettel–Mollon method: linearise sRGB, project
 * onto the LMS plane the missing cone leaves behind, convert back. Distance is
 * CIE76 ΔE in Lab, which is crude but ample for deciding whether two dots read
 * as different colours.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** The palette, read out of the module the map and legend both use. */
const source = readFileSync(new URL('../src/lib/kinds.ts', import.meta.url), 'utf8')
const PALETTE = [...source.matchAll(/kind: '(\w+)',[\s\S]*?colour: '(#[0-9A-Fa-f]{6})'/g)]
  .map((m) => ({ kind: m[1], hex: m[2] }))

// --- colour maths ------------------------------------------------------------

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)

const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const gamma = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

const mul = (m, v) => m.map((row) => row.reduce((s, x, i) => s + x * v[i], 0))

const RGB_TO_LMS = [
  [0.31399022, 0.63951294, 0.04649755],
  [0.15537241, 0.75789446, 0.08670142],
  [0.01775239, 0.10944209, 0.87256922],
]
const LMS_TO_RGB = [
  [5.47221206, -4.6419601, 0.16963708],
  [-1.1252419, 2.29317094, -0.1678952],
  [0.02980165, -0.19318073, 1.16364789],
]

/** Dichromacy projections (Viénot et al., 1999). */
const SIMULATE = {
  protanopia: [[0, 1.05118294, -0.05116099], [0, 1, 0], [0, 0, 1]],
  deuteranopia: [[1, 0, 0], [0.9513092, 0, 0.04866992], [0, 0, 1]],
  tritanopia: [[1, 0, 0], [0, 1, 0], [-0.86744736, 1.86727089, 0]],
}

function simulate(hex, kind) {
  const lms = mul(RGB_TO_LMS, hexToRgb(hex).map(linear))
  const hit = mul(SIMULATE[kind], lms)
  return mul(LMS_TO_RGB, hit).map((c) => gamma(Math.min(1, Math.max(0, c))))
}

/** Linear-RGB → XYZ → Lab, D65. */
function toLab(rgb) {
  const [r, g, b] = rgb.map(linear)
  const xyz = [
    (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047,
    0.2126 * r + 0.7152 * g + 0.0722 * b,
    (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883,
  ]
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const [fx, fy, fz] = xyz.map(f)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const deltaE = (a, b) => Math.hypot(...toLab(a).map((v, i) => v - toLab(b)[i]))

// --- the tests ---------------------------------------------------------------

/*
 * 20 is comfortably above "just noticeable" (~2.3) and below what the current
 * palette achieves, so it has room to catch a regression without failing on a
 * harmless tweak. The old red/green pair scored about 13 under deuteranopia.
 */
const MIN_SEPARATION = 20

test('the palette has three categories with distinct colours', () => {
  assert.equal(PALETTE.length, 3, `parsed ${PALETTE.length} colours from kinds.ts`)
  assert.equal(new Set(PALETTE.map((p) => p.hex)).size, 3, 'two categories share a colour')
})

test('every pair stays distinguishable with normal colour vision', () => {
  for (let i = 0; i < PALETTE.length; i++) {
    for (let j = i + 1; j < PALETTE.length; j++) {
      const d = deltaE(hexToRgb(PALETTE[i].hex), hexToRgb(PALETTE[j].hex))
      assert.ok(d >= MIN_SEPARATION,
        `${PALETTE[i].kind} vs ${PALETTE[j].kind}: ΔE ${d.toFixed(1)}`)
    }
  }
})

for (const kind of Object.keys(SIMULATE)) {
  test(`every pair stays distinguishable under ${kind}`, () => {
    for (let i = 0; i < PALETTE.length; i++) {
      for (let j = i + 1; j < PALETTE.length; j++) {
        const a = simulate(PALETTE[i].hex, kind)
        const b = simulate(PALETTE[j].hex, kind)
        const d = deltaE(a, b)
        assert.ok(d >= MIN_SEPARATION,
          `${PALETTE[i].kind} (${PALETTE[i].hex}) vs ${PALETTE[j].kind} ` +
          `(${PALETTE[j].hex}) under ${kind}: ΔE ${d.toFixed(1)}, need ${MIN_SEPARATION}`)
      }
    }
  })
}

test('the check is not vacuous — it rejects the palette this replaced', () => {
  // Red against the green that used to mean "not known yet". If this ever
  // passes, the simulation has stopped doing anything and the tests above are
  // decoration.
  const worst = Math.min(
    ...Object.keys(SIMULATE).map((k) =>
      deltaE(simulate('#C2384A', k), simulate('#4A7C4E', k))),
  )
  assert.ok(worst < MIN_SEPARATION,
    `red vs the old green scored ΔE ${worst.toFixed(1)} — expected it to fail`)
})
