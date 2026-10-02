// Fixture tasks for the provider-neutral coding evaluation. Each task is a tiny repository, a request, and an
// objective check (never "the model said it was done"). `reference` is a scripted answer used only to verify the
// harness itself offline; live runs never see it.
import { BUG_PROJECT } from '../validation/testing/fixtures.js'

const json = (o) => `${JSON.stringify(o, null, 2)}\n`
const pkg = (scripts) => json({ name: 'fixture', version: '1.0.0', type: 'module', scripts })
const call = (id, name, input) => ({ id, name, input })

const passes = async (ws, command = 'npm test') => (await ws.runCommand(command)).exitCode === 0

export const TASKS = Object.freeze([
  {
    id: 'fix-bug', title: 'Fix a failing test',
    files: { ...BUG_PROJECT },
    prompt: 'The add() function in src/math.js returns the wrong result and `npm test` fails. Fix it, then run the tests to confirm.',
    expectedFiles: ['src/math.js'],
    check: (ws) => passes(ws),
    reference: () => [
      { calls: [call('r1', 'read_file', { path: 'src/math.js' })] },
      { calls: [call('r2', 'apply_patch', { patch: '--- a/src/math.js\n+++ b/src/math.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b\n+  return a + b\n }\n' })] },
      { text: 'Fixed add().' }, { text: 'add() now adds; tests pass.' },
    ],
  },
  {
    id: 'add-test', title: 'Add a missing test',
    files: {
      'package.json': pkg({ test: 'node --test tests/*.test.js' }),
      'src/strings.js': "export function slugify(s) {\n  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')\n}\n",
    },
    prompt: 'slugify() in src/strings.js has no test. Add tests/strings.test.js (node:test) covering at least two cases, and make sure `npm test` passes.',
    expectedFiles: ['tests/strings.test.js'],
    check: async (ws) => (await ws.exists('tests/strings.test.js')) && (await ws.readFile('tests/strings.test.js')).content.includes('slugify') && passes(ws),
    reference: () => [
      { calls: [call('r1', 'read_file', { path: 'src/strings.js' })] },
      { calls: [call('r2', 'write_file', { path: 'tests/strings.test.js', content: "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { slugify } from '../src/strings.js'\n\ntest('slugify lowercases and joins words', () => { assert.equal(slugify('Hello World'), 'hello-world') })\ntest('slugify trims separators', () => { assert.equal(slugify('  A  b  '), 'a-b') })\n" })] },
      { text: 'Added tests.' }, { text: 'Added two slugify tests; they pass.' },
    ],
  },
  {
    id: 'small-refactor', title: 'Rename a function across files',
    files: {
      'package.json': pkg({ test: 'node --test tests/*.test.js' }),
      'src/cart.js': 'export function calc(items) {\n  return items.reduce((n, i) => n + i.price, 0)\n}\n',
      'src/index.js': "import { calc } from './cart.js'\n\nexport const total = calc([{ price: 2 }, { price: 3 }])\n",
      'tests/cart.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { calculateTotal } from '../src/cart.js'\n\ntest('total', () => { assert.equal(calculateTotal([{ price: 2 }, { price: 3 }]), 5) })\n",
    },
    prompt: 'Rename calc() to calculateTotal() everywhere it is used (the tests already expect the new name) and keep `npm test` passing.',
    expectedFiles: ['src/cart.js', 'src/index.js'],
    check: async (ws) => !(await ws.grep('\\bcalc\\b', { regex: true })).matches.length && passes(ws),
    reference: () => [
      { calls: [call('r1', 'grep', { pattern: 'calc', path: 'src' })] },
      { calls: [
        call('r2', 'apply_patch', { patch: '--- a/src/cart.js\n+++ b/src/cart.js\n@@ -1,3 +1,3 @@\n-export function calc(items) {\n+export function calculateTotal(items) {\n   return items.reduce((n, i) => n + i.price, 0)\n }\n' }),
        call('r3', 'apply_patch', { patch: `--- a/src/index.js\n+++ b/src/index.js\n@@ -1,3 +1,3 @@\n-import { calc } from './cart.js'\n+import { calculateTotal } from './cart.js'\n \n-export const total = calc([{ price: 2 }, { price: 3 }])\n+export const total = calculateTotal([{ price: 2 }, { price: 3 }])\n` }),
      ] },
      { text: 'Renamed.' }, { text: 'calc is now calculateTotal everywhere; tests pass.' },
    ],
  },
  {
    id: 'multi-file-change', title: 'Add a function and use it',
    files: {
      'package.json': pkg({ test: 'node --test tests/*.test.js' }),
      'src/math.js': 'export const add = (a, b) => a + b\n',
      'src/report.js': "import { add } from './math.js'\n\nexport const report = () => `sum=${add(2, 3)}`\n",
      'tests/report.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { report } from '../src/report.js'\n\ntest('report shows sum and difference', () => { assert.equal(report(), 'sum=5 diff=-1') })\n",
    },
    prompt: 'Add a subtract(a, b) export to src/math.js and make report() in src/report.js return "sum=5 diff=-1" using it. `npm test` must pass.',
    expectedFiles: ['src/math.js', 'src/report.js'],
    check: (ws) => passes(ws),
    reference: () => [
      { calls: [call('r1', 'read_many_files', { paths: ['src/math.js', 'src/report.js'] })] },
      { calls: [
        call('r2', 'write_file', { path: 'src/math.js', content: 'export const add = (a, b) => a + b\nexport const subtract = (a, b) => a - b\n' }),
        call('r3', 'write_file', { path: 'src/report.js', content: "import { add, subtract } from './math.js'\n\nexport const report = () => `sum=${add(2, 3)} diff=${subtract(2, 3)}`\n" }),
      ] },
      { text: 'Done.' }, { text: 'subtract added and used by report().' },
    ],
  },
  {
    id: 'recover-failing-test', title: 'Recover after a first attempt fails',
    files: { ...BUG_PROJECT },
    prompt: 'add() in src/math.js is broken; `npm test` fails. Fix it. If your first attempt does not make the tests pass, look at the failure and correct it.',
    expectedFiles: ['src/math.js'],
    check: (ws) => passes(ws),
    reference: () => [
      { calls: [call('r1', 'read_file', { path: 'src/math.js' })] },
      { calls: [call('r2', 'apply_patch', { patch: '--- a/src/math.js\n+++ b/src/math.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b\n+  return a * b\n }\n' })] },
      { text: 'Changed the operator.' }, // validation fails here
      { calls: [call('r3', 'apply_patch', { patch: '--- a/src/math.js\n+++ b/src/math.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a * b\n+  return a + b\n }\n' })] },
      { text: 'Corrected the operator.' }, { text: 'add() now adds; tests pass.' },
    ],
  },
])

export const taskById = (id) => TASKS.find(t => t.id === id) ?? null
