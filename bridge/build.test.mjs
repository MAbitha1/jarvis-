import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { inside, PROJECTS_DIR } from './build.mjs'

const dir = join(PROJECTS_DIR, 'diwali-sweets')

test('the builder may use paths inside its own project folder', () => {
  assert.equal(inside(dir, join(dir, 'index.html')), true)
  assert.equal(inside(dir, join(dir, 'css', 'style.css')), true)
  assert.equal(inside(dir, 'js/app.js'), true)
  assert.equal(inside(dir, undefined), true) // a tool's default is its cwd
})

test('the builder may not reach outside its project folder', () => {
  assert.equal(inside(dir, join(dir, '..', 'other', 'index.html')), false)
  assert.equal(inside(dir, '../../.ssh/id_rsa'), false)
  assert.equal(inside(dir, 'C:\\Windows\\System32\\drivers\\etc\\hosts'), false)
  assert.equal(inside(dir, `${dir}-2\\index.html`), false) // a sibling with the same prefix
})
