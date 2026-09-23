/**
 * The attempt ledger: what this session has already tried, folded from its log.
 *
 * # Why a ledger and not a tree
 *
 * `rsi-trace` records a discovery *tree* — attempts, branches and scores, which
 * answers "which direction was best". That is the right structure for the
 * offline dreaming loop, which replays an allocation strategy over it.
 *
 * It is the wrong structure for the online case this package addresses. A coding
 * agent inside one session does not choose between branches; it runs commands,
 * some of which fail, and the failure that costs the most is the one it repeats.
 * The tree has no node for "I already ran that and it did not work", so this
 * module folds a different projection: one row per distinct attempt, carrying
 * whether it worked and what it said when it did not.
 *
 * # What it deliberately does not do
 *
 * It does not judge, summarise, or rank. Summarising is where an advisory layer
 * starts inventing facts about a session it can only observe, and an invented
 * fact in a prompt is worse than no guidance. The ledger records literal
 * attempts, and {@link renderLedger} renders them literally.
 *
 * @module @unreal-harness/rsi-guided/types
 */

import type { SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'

/** How one attempt ended. */
export type AttemptOutcome = 'succeeded' | 'failed' | 'unknown'

/**
 * The exit marker `dsh-tool-bash` appends to a non-zero foreground run.
 *
 * This is the *only* signal for an ordinary command failure, and finding that out
 * cost a full benchmark run. dsh deliberately does not mark a non-zero exit as an
 * error: its renderer reports the status and leaves the model to react, so only
 * infrastructure failures (spawn errors, aborts) surface as `isError`. A ledger
 * that keyed off `isError` therefore recorded *nothing* for the failures it exists
 * to catch -- `pytest` returning 1, a missing module, a compile error -- and
 * shipped a guidance feature with nothing to say. The first A/B treatment arm
 * mounted it and measured an inert layer.
 *
 * Anchored at the end of the rendered output, mirroring the producer's own parse.
 */
export const EXIT_CODE_MARKER = /\n?\[exit code: (\d+)\]\s*$/
export const SIGNAL_MARKER = /\n?\[killed by signal: ([^\]\n]+)\]\s*$/

/** One attempt the session made, keyed by the tool call that made it. */
export interface AttemptRecord {
  /** The tool that ran, e.g. `bash` or `write`. */
  readonly tool: string
  /**
   * The attempt's subject: the command for a shell tool, the path for a file
   * tool. This is what makes two attempts "the same attempt".
   */
  readonly subject: string
  /** Full arguments, kept so the ledger can render a faithful line. */
  readonly detail: string
  readonly outcome: AttemptOutcome
  /** A short, literal excerpt of the failure, when there was one. */
  readonly error?: string
  /** The step this attempt belonged to, so the ledger can order and age it. */
  readonly step: number
  readonly turn: number
  /** Session log offset, for stable ordering when a step is ambiguous. */
  readonly seq: number
}

/** The folded ledger state. Serializable: dsh may persist and replay it. */
export interface AttemptLedgerState {
  readonly inheritedEventCount: SessionLogOffset
  /** Insertion order of {@link attempts} keys, oldest first. */
  readonly order: readonly string[]
  readonly attempts: Readonly<Record<string, AttemptRecord>>
  /** Calls seen but not yet resolved, keyed by call id. */
  readonly pending: Readonly<Record<string, { tool: string; detail: string; turn: number; step: number; seq: number }>>
}

/** An empty ledger. */
export function initAttemptLedger(inheritedEventCount: SessionLogOffset): AttemptLedgerState {
  return { inheritedEventCount, order: [], attempts: {}, pending: {} }
}

/** How much of a failure to keep. Long enough to be diagnostic, short enough to bound the prompt. */
export const ERROR_EXCERPT_LIMIT = 160

/**
 * Reduce an attempt to its identity.
 *
 * Two shell commands that differ only in whitespace are the same attempt, so the
 * subject is whitespace-normalised. Two writes to the same path are deliberately
 * *not* collapsed — writing a file twice with different content is progress, not
 * a repeat — so the subject for a write is the path plus a digest of the content,
 * which the caller supplies in `detail`.
 *
 * @param tool - the tool name.
 * @param argumentsJson - the raw arguments string from the `tool/call` event.
 * @returns the ledger key and the display subject.
 */
export function attemptIdentity(
  tool: string,
  argumentsJson: string,
): { key: string; subject: string } {
  const parsed = safeParse(argumentsJson)
  const command = typeof parsed?.['command'] === 'string' ? parsed['command'] : undefined
  const path = typeof parsed?.['file_path'] === 'string' ? parsed['file_path'] : undefined

  if (command !== undefined) {
    const subject = command.replace(/\s+/g, ' ').trim()
    return { key: `${tool}\u0000${subject}`, subject }
  }
  if (path !== undefined) {
    const content = typeof parsed?.['content'] === 'string' ? parsed['content'] : ''
    const digest = shortDigest(content)
    return { key: `${tool}\u0000${path}\u0000${digest}`, subject: path }
  }
  // Unknown tool shape: keep the arguments verbatim as the subject rather than
  // guessing which field identifies the attempt.
  const subject = argumentsJson.replace(/\s+/g, ' ').trim().slice(0, 200)
  return { key: `${tool}\u0000${subject}`, subject }
}

function safeParse(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * A short, stable digest of a string.
 *
 * FNV-1a, chosen because it is a few lines with no dependency and this is an
 * identity helper, not a security primitive. Collisions would merge two writes
 * into one ledger row, which at worst hides a repeat.
 *
 * @param value - the string to digest.
 * @returns eight lowercase hex characters.
 */
export function shortDigest(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Extract a short excerpt from a tool result message's text, if it has one.
 *
 * Recursive, because the text is not where it first appears to be: a result
 * message carries a `tool-result` block whose *own* `content` array holds the
 * text blocks. A non-recursive scan of the outer array finds no `text` field at
 * all and silently yields nothing — which is how an earlier version of this
 * package shipped with a ledger that recorded failures but never their reasons,
 * making the rendered guidance far less useful than it looked.
 *
 * @param message - the `tool/result` event's message, of unknown runtime shape.
 * @returns one whitespace-collapsed line, or `undefined` when there is no text.
 */
export function excerptFromMessage(message: unknown): string | undefined {
  const texts: string[] = []
  collectText(message, texts, 0)
  const joined = texts.join('\n').trim()
  if (joined === '') return undefined
  // One line, so the rendered ledger stays a list of attempts rather than
  // becoming a second copy of the transcript.
  const oneLine = joined.replace(/\s+/g, ' ')
  return oneLine.length <= ERROR_EXCERPT_LIMIT
    ? oneLine
    : `${oneLine.slice(0, ERROR_EXCERPT_LIMIT - 1)}…`
}

/** Depth-bounded walk, so a malformed cyclic message cannot hang a projection. */
function collectText(value: unknown, into: string[], depth: number): void {
  if (depth > 6 || typeof value !== 'object' || value === null) return
  if (Array.isArray(value)) {
    for (const entry of value) collectText(entry, into, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  if (typeof record['text'] === 'string' && record['text'] !== '') {
    into.push(record['text'])
  }
  if (Array.isArray(record['content'])) collectText(record['content'], into, depth + 1)
}


/**
 * Classify one tool result as a worked or failed attempt.
 *
 * @param data - the `tool/result` event data.
 * @param text - the concatenated text of the result message, if any.
 * @returns the outcome, plus the failure text when there is one.
 */
export function classifyResult(
  data: unknown,
  text: string | undefined,
): { outcome: AttemptOutcome; failureText?: string } {
  const record =
    typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}

  // An explicit error field is an infrastructure failure: spawn error, abort.
  if (record['error'] !== undefined) return { outcome: 'failed', ...withText(text) }

  const message = record['message']
  const blocks =
    typeof message === 'object' && message !== null
      ? (message as { content?: { isError?: boolean }[] }).content
      : undefined
  if (Array.isArray(blocks) && blocks.some(block => block?.isError === true)) {
    return { outcome: 'failed', ...withText(text) }
  }

  const rendered = text ?? ''
  const exit = EXIT_CODE_MARKER.exec(rendered)
  if (exit !== null && exit[1] !== undefined && Number(exit[1]) !== 0) {
    // The marker is stripped from the excerpt: it says "this failed", which the
    // rendered line already says, and it would otherwise be the visible end of
    // every excerpt.
    return { outcome: 'failed', ...withText(rendered.replace(EXIT_CODE_MARKER, '')) }
  }
  if (SIGNAL_MARKER.test(rendered)) {
    return { outcome: 'failed', ...withText(rendered.replace(SIGNAL_MARKER, '')) }
  }
  // A timeout or a sandbox denial is also the attempt not working.
  if (/\[timed out after \d+ms\]/.test(rendered) || rendered.includes('[sandbox: ')) {
    return { outcome: 'failed', ...withText(rendered) }
  }
  return { outcome: 'succeeded' }
}

function withText(text: string | undefined): { failureText?: string } {
  return text === undefined ? {} : { failureText: text }
}

/**
 * Fold one committed event into the ledger.
 *
 * Pure and total: an event this module does not understand returns the state it
 * was given, because a projection runs over every log event, including ones other
 * plugins appended.
 *
 * @param state - the ledger before this event.
 * @param event - one committed session event.
 * @returns the ledger after it.
 */
export function foldAttemptLedger(
  state: AttemptLedgerState,
  event: SessionEvent,
): AttemptLedgerState {
  if (event.type === 'tool/call') {
    const { key, subject } = attemptIdentity(event.data.name, event.data.arguments)
    const pending = {
      ...state.pending,
      [event.data.callId]: {
        tool: event.data.name,
        // Store both the identity key and the display subject under one entry.
        detail: event.data.arguments,
        turn: event.data.turn,
        step: event.data.step,
        seq: event.seq,
      },
    }
    // The key is recomputed at result time; keeping it here avoids recomputation
    // and, more importantly, keeps the call and the result addressed identically.
    void key
    void subject
    return { ...state, pending }
  }

  if (event.type === 'tool/result') {
    const callId = callIdOf(event.data)
    const call = callId === undefined ? undefined : state.pending[callId]
    if (call === undefined) {
      // A result with no matching call: possible when the projection is rebuilt
      // from a truncated log prefix. Recording it would invent an attempt, so it
      // is dropped. The ledger under-reports rather than fabricates.
      return state
    }
    const { key, subject } = attemptIdentity(call.tool, call.detail)
    const message = (event.data as { message?: unknown }).message
    const text = excerptFromMessage(message)
    const { outcome, failureText } = classifyResult(event.data, text)

    const record: AttemptRecord = {
      tool: call.tool,
      subject,
      detail: call.detail,
      outcome,
      ...(failureText === undefined ? {} : { error: failureText }),
      step: call.step,
      turn: call.turn,
      seq: call.seq,
    }

    const pending = { ...state.pending }
    delete pending[callId!]

    const existing = state.attempts[key]
    const attempts = { ...state.attempts, [key]: record }
    // Order is first-seen: the ledger answers "has this been tried", and the
    // first time it was tried is the stable position for that answer.
    const order = existing === undefined ? [...state.order, key] : state.order
    return { ...state, attempts, order, pending }
  }

  return state
}

/**
 * The call a `tool/result` event answers.
 *
 * Tried in the order the payload is actually shaped, which was established by
 * inspecting a live session rather than by reading the type: the event carries
 * `{ turn, step, message }`, and the call id lives on the *message's* `source`,
 * not on the event. An earlier version looked on the event and fell back to the
 * message's first content block, matched nothing, dropped every result, and left
 * the ledger permanently showing one pending call. The failure was invisible from
 * the outside — the plugin loaded, the fold ran, the prompt contribution was
 * assembled — which is why the shapes are all attempted here and pinned by test.
 *
 * @param data - the `tool/result` event data.
 * @returns the call id, or `undefined` when none of the known shapes carry one.
 */
export function callIdOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as {
    callId?: unknown
    source?: { callId?: unknown }
    message?: { source?: { callId?: unknown }; content?: { toolCallId?: unknown }[] }
  }

  // The production shape: the call id rides the result message's source.
  if (typeof record.message?.source?.callId === 'string') return record.message.source.callId
  // Tolerated extras: a flattened event, and the block-level id.
  if (typeof record.callId === 'string') return record.callId
  if (typeof record.source?.callId === 'string') return record.source.callId
  const block = record.message?.content?.[0]
  return typeof block?.toolCallId === 'string' ? block.toolCallId : undefined
}

/** How many attempts {@link renderLedger} will show by default. */
export const DEFAULT_LEDGER_LIMIT = 24

/**
 * Render the ledger as a short, literal block.
 *
 * Only attempts that carry information are shown: a successful attempt is
 * presumed known to the agent that just made it, so the *failures* are what save
 * a repeat. Successful attempts are summarised as a count, because "you have
 * already run eleven commands" is useful context and eleven lines of them is not.
 *
 * @param state - the folded ledger.
 * @param options - how many failures to show, newest last.
 * @returns prompt text, or an empty string when there is nothing worth saying.
 */
export function renderLedger(
  state: AttemptLedgerState,
  options: { readonly limit?: number } = {},
): string {
  const limit = options.limit ?? DEFAULT_LEDGER_LIMIT
  const records = state.order
    .map(key => state.attempts[key])
    .filter((record): record is AttemptRecord => record !== undefined)

  const failures = records.filter(record => record.outcome === 'failed')
  const successes = records.filter(record => record.outcome === 'succeeded')

  if (failures.length === 0 && successes.length === 0) return ''

  const shown = failures.slice(Math.max(0, failures.length - limit))
  const omitted = failures.length - shown.length

  const lines: string[] = []
  lines.push(
    `This session has made ${records.length} recorded attempt(s): ` +
      `${successes.length} that worked and ${failures.length} that failed.`,
  )
  if (shown.length > 0) {
    lines.push(
      'Failed attempts, oldest first. Do not repeat one unless you are changing ' +
        'something about it — the failure text says what went wrong:',
    )
    for (const failure of shown) {
      const excerpt = failure.error === undefined ? '' : ` — ${failure.error}`
      lines.push(`- ${failure.tool}: ${truncate(failure.subject, 160)}${excerpt}`)
    }
    if (omitted > 0) {
      lines.push(`- …and ${omitted} earlier failure(s) not shown.`)
    }
  }
  return lines.join('\n')
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}
