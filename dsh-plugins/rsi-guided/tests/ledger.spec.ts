/**
 * The attempt ledger's pure logic.
 *
 * The fold is the only place this package decides what counts as "the same
 * attempt", so the tests are written against the cases that decide it: whitespace
 * in a command, a rewritten file, a truncated log whose result has no matching
 * call, and an event belonging to another plugin.
 *
 * @module
 */

import { expect, it } from 'vitest'
import type { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  attemptIdentity,
  excerptFromMessage,
  foldAttemptLedger,
  initAttemptLedger,
  renderLedger,
  shortDigest,
} from '../src/types.ts'

/** A `tool/call` event with the envelope fields the fold reads. */
function call(seq: number, callId: string, name: string, args: object): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: 0,
    data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
  } as unknown as SessionEvent
}

/** A `tool/result` event, failed or not. */
function result(seq: number, callId: string, failed: boolean, text = 'boom'): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      source: { kind: 'tool', callId },
      ...(failed ? { error: { name: 'ToolError', code: 'FAILED' } } : {}),
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      },
    },
  } as unknown as SessionEvent
}

// SessionLogOffset is a branded type, not a constructor.
const empty = () => initAttemptLedger(0 as SessionLogOffset)

it('treats whitespace-only differences as the same attempt', () => {
  const a = attemptIdentity('bash', JSON.stringify({ command: 'ls  -la   /tmp' }))
  const b = attemptIdentity('bash', JSON.stringify({ command: 'ls -la /tmp' }))
  expect(a.key).toBe(b.key)
})

it('treats two different shell commands as different attempts', () => {
  const a = attemptIdentity('bash', JSON.stringify({ command: 'ls /tmp' }))
  const b = attemptIdentity('bash', JSON.stringify({ command: 'ls /var' }))
  expect(a.key).not.toBe(b.key)
})

it('treats a rewritten file as a new attempt and an identical write as a repeat', () => {
  const first = attemptIdentity('write', JSON.stringify({ file_path: '/a.txt', content: 'one' }))
  const same = attemptIdentity('write', JSON.stringify({ file_path: '/a.txt', content: 'one' }))
  const changed = attemptIdentity('write', JSON.stringify({ file_path: '/a.txt', content: 'two' }))
  // Writing the same bytes twice is a repeat; writing different bytes is
  // progress, so the content is part of the identity rather than ignored.
  expect(first.key).toBe(same.key)
  expect(first.key).not.toBe(changed.key)
  expect(first.subject).toBe('/a.txt')
})

it('falls back to the raw arguments for a tool whose shape it does not know', () => {
  const identity = attemptIdentity('mystery', JSON.stringify({ alpha: 1 }))
  expect(identity.subject).toContain('alpha')
})

it('records a failed attempt and keeps the error text', () => {
  let state = empty()
  state = foldAttemptLedger(state, call(1, 'c1', 'bash', { command: 'cat /missing' }))
  state = foldAttemptLedger(state, result(2, 'c1', true, 'No such file or directory'))

  const attempts = state.order.map(key => state.attempts[key]!)
  expect(attempts).toHaveLength(1)
  expect(attempts[0]!.outcome).toBe('failed')
  expect(attempts[0]!.error).toContain('No such file')
})

it('records a successful attempt without error text', () => {
  let state = empty()
  state = foldAttemptLedger(state, call(1, 'c1', 'bash', { command: 'ls' }))
  state = foldAttemptLedger(state, result(2, 'c1', false, 'a.txt'))
  const attempt = state.attempts[state.order[0]!]!
  expect(attempt.outcome).toBe('succeeded')
  expect(attempt.error).toBeUndefined()
})

it('collapses a repeated attempt into one row and lets the newest outcome win', () => {
  let state = empty()
  state = foldAttemptLedger(state, call(1, 'c1', 'bash', { command: 'ls' }))
  state = foldAttemptLedger(state, result(2, 'c1', true))
  state = foldAttemptLedger(state, call(3, 'c2', 'bash', { command: 'ls' }))
  state = foldAttemptLedger(state, result(4, 'c2', false))

  // One row: the ledger answers "has this been tried", not "how many times".
  expect(state.order).toHaveLength(1)
  expect(state.attempts[state.order[0]!]!.outcome).toBe('succeeded')
})

it('ignores a result whose call is absent from the retained prefix', () => {
  // A projection rebuilt from a truncated log can legitimately see a result with
  // no matching call. Inventing an attempt from it would put a fabricated row in
  // the prompt, so it is dropped: the ledger under-reports rather than lies.
  const state = foldAttemptLedger(empty(), result(1, 'orphan', true))
  expect(state.order).toHaveLength(0)
})

it('returns the same state reference for events it does not handle', () => {
  const state = empty()
  const other = { type: 'step/end', seq: 1, time: 0, data: { turn: 1, step: 1 } } as unknown as SessionEvent
  // Identity, not equality: the projection drive uses Object.is to skip
  // downstream work, so a fold that returned a copy would defeat it.
  expect(foldAttemptLedger(state, other)).toBe(state)
})

it('clears the pending entry once a result arrives', () => {
  let state = empty()
  state = foldAttemptLedger(state, call(1, 'c1', 'bash', { command: 'ls' }))
  expect(Object.keys(state.pending)).toEqual(['c1'])
  state = foldAttemptLedger(state, result(2, 'c1', false))
  expect(Object.keys(state.pending)).toEqual([])
})

it('renders nothing for an empty ledger', () => {
  expect(renderLedger(empty())).toBe('')
})

it('renders a count and the failures, and hides successes beyond the count', () => {
  let state = empty()
  state = foldAttemptLedger(state, call(1, 'c1', 'bash', { command: 'ls' }))
  state = foldAttemptLedger(state, result(2, 'c1', false))
  state = foldAttemptLedger(state, call(3, 'c2', 'bash', { command: 'cat /missing' }))
  state = foldAttemptLedger(state, result(4, 'c2', true, 'No such file'))

  const text = renderLedger(state)
  expect(text).toContain('2 recorded attempt(s)')
  expect(text).toContain('cat /missing')
  expect(text).toContain('No such file')
  // The successful `ls` is counted, not listed: a line per success would turn
  // the guidance into a second copy of the transcript.
  expect(text).not.toContain('- bash: ls')
})

it('bounds how many failures it lists', () => {
  let state = empty()
  for (let index = 0; index < 40; index += 1) {
    state = foldAttemptLedger(state, call(index * 2, `c${index}`, 'bash', { command: `cmd-${index}` }))
    state = foldAttemptLedger(state, result(index * 2 + 1, `c${index}`, true, `fail-${index}`))
  }
  const text = renderLedger(state, { limit: 5 })
  // The header states the true total; the list is capped and says how much it
  // withheld, so a reader is never misled into thinking the ledger is complete.
  expect(text).toContain('40 recorded attempt(s)')
  expect(text).toContain('35 earlier failure(s) not shown')
  expect(text).toContain('cmd-39')
  expect(text).not.toContain('cmd-0 —')
})

it('excerpts one line from a tool result and truncates it', () => {
  const long = 'x'.repeat(400)
  const excerpt = excerptFromMessage({ content: [{ type: 'text', text: `line one\n\n  line two ${long}` }] })
  expect(excerpt).toBeDefined()
  expect(excerpt).toBeDefined()
  expect(excerpt!.includes('\n')).toBe(false)
  expect(excerpt!.length).toBeLessThanOrEqual(160)
  expect(excerpt!.endsWith('…')).toBe(true)
})

it('finds text nested inside a tool-result block, which is where it actually lives', () => {
  // The real shape: a `tool-result` block whose own `content` carries the text.
  // A non-recursive scan finds nothing here, which is the bug this test pins.
  const excerpt = excerptFromMessage({
    role: 'user',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'cat: /missing: No such file or directory' }],
      },
    ],
  })
  expect(excerpt).toBe('cat: /missing: No such file or directory')
})

it('excerpts nothing from a message with no text', () => {
  expect(excerptFromMessage({ content: [{ type: 'image' }] })).toBeUndefined()
  expect(excerptFromMessage(undefined)).toBeUndefined()
})

it('digests stably and differently for different content', () => {
  expect(shortDigest('abc')).toBe(shortDigest('abc'))
  expect(shortDigest('abc')).not.toBe(shortDigest('abd'))
  expect(shortDigest('abc')).toHaveLength(8)
})
