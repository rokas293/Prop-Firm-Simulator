// Regression guard for REDESIGN_APPROACH.md Part C1: "add a test that no
// component references a non-token color." Scans every source file for a
// raw hex/rgb(a) color literal or a non-token Tailwind color utility
// (Tailwind's stock palette -- neutral/slate/blue/amber/etc. -- none of
// which are wired to the theme) and fails with the exact file/line, so a
// future change can't silently reintroduce a hardcoded shell color the way
// the Part C1 audit found ~300 of them the first time.
//
// This is a plain Vitest test, not an ESLint rule, because the project has
// no ESLint setup at all (checked before choosing this route) -- a test
// that runs in the same `vitest run` already gating every change is zero
// new tooling, versus standing up ESLint solely for one rule.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname)

// Files that legitimately hold literal color values -- the token
// definitions themselves, not a component/chart config hardcoding one.
const ALLOWLIST = new Set([
  // The design-token system's own source of truth: preset seed colors and
  // the fixed CATEGORICAL palette (sessions/compare-B/indicator lines --
  // Part C1 audit risk #3, "which thing is this" identity colors that are
  // deliberately outside the tunable accent/positive/negative model).
  join(SRC_DIR, 'state', 'themeStore.ts'),
  // DEFAULT_SESSION_COLOR (unknown-session fallback) and FAIR_VALUE_COLOR
  // (a fixed reference-line tint) -- categorical/decorative chart
  // constants, same exemption as the session identity colors above, not
  // app-shell chrome.
  join(SRC_DIR, 'chart', 'kl', 'sessionOverlay.ts'),
])

// Tailwind's own stock palettes -- none are wired to the theme, so a class
// built from one of these is always a hardcoded, non-tunable color,
// regardless of which shade. `white`/`black` are a deliberate, narrow
// exception (see below), not listed here.
const RAW_PALETTES = [
  'neutral',
  'slate',
  'gray',
  'zinc',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
].join('|')

const COLOR_UTILITY_PREFIXES = 'bg|text|border|ring|from|to|via|fill|stroke|divide|outline|decoration|accent'

// text-white/bg-white/text-black are the one intentional exception: white
// text on an arbitrary-hued accent button needs to stay legible regardless
// of which accent color a preset picks, and Tailwind itself has no
// "contrast-safe foreground" token to reach for instead (see the Part C1
// implementation notes). Anything else raw is a violation.
const RAW_CLASS_RE = new RegExp(`\\b(${COLOR_UTILITY_PREFIXES})-(${RAW_PALETTES})-?[0-9]*\\b`)
const RAW_HEX_RE = /#[0-9a-fA-F]{3,8}\b/
const RAW_RGB_RE = /rgba?\(\s*[0-9]/

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(full)
    }
  }
  return out
}

interface Violation {
  file: string
  line: number
  text: string
}

function findViolations(): Violation[] {
  const violations: Violation[] = []
  for (const file of listSourceFiles(SRC_DIR)) {
    if (ALLOWLIST.has(file)) continue
    const lines = readFileSync(file, 'utf-8').split('\n')
    lines.forEach((line, i) => {
      if (RAW_CLASS_RE.test(line) || RAW_HEX_RE.test(line) || RAW_RGB_RE.test(line)) {
        violations.push({ file: relative(SRC_DIR, file), line: i + 1, text: line.trim() })
      }
    })
  }
  return violations
}

describe('design tokens', () => {
  it('no component or chart config hardcodes a raw hex/rgb color or a non-token Tailwind color class', () => {
    const violations = findViolations()
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join('\n')
      throw new Error(`Found ${violations.length} hardcoded color reference(s):\n${report}`)
    }
    expect(violations).toEqual([])
  })
})
