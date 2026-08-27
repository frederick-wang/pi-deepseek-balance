# Session Lessons — pi-deepseek-balance overlay fix (2026-08-27)

Everything in this file is a hard-won lesson from one session: fixing the
`/deepseek-balance` TUI overlay that rendered as vertical character stacking,
then as a borderless blob merged with the chat transcript.

## 1. Contract violations show up as *weird visuals*, not errors

`ctx.ui.custom(factory, { overlay: true })`'s component contract is
`render(width: number): string[]`. Returning a newline-joined **string** is
not a type error anywhere (the factory's return is `unknown` at the call
site we typed) — pi's compositor iterates the result as an array of lines,
so `.length` is the character count and `[i]` is one character. Every
character becomes its own terminal row. The symptom in the screenshot was
vertical text + literal `[38;2;…m` fragments.

**Lesson**: when a UI framework accepts a loose `unknown` at an integration
boundary, type that boundary with the real contract's structural shape.
`string[]` vs `string` is a compile-time catchable bug; we shipped it
because the boundary was erased. Fix by typing the local interface
(`render(width): string[]`) and letting `tsc` enforce it.

## 2. The test seam was dormant — count-only mocks never exercise contracts

`tests/helpers.ts` mocked `ctx.ui.custom` as `customCalls += 1`. The factory
was never invoked, so `render`/`handleInput` never ran in tests for the
entire life of the project. The contract violation had zero test coverage.

**Lesson**: a mock that counts calls proves *the code called the mock*, not
that the code satisfies the interface. Tests must **drive the real
contract**: capture the factory, invoke it with fake args, and assert on the
returned component's behavior. The fixed seam invokes the factory with fake
`tui`/`theme`/`kb`/`done`, records the component + options, and then the
tests call `render(width)` / `handleInput(data)` on it.

## 3. Raw key-byte comparison breaks on modern terminals

The original `handleInput` compared `data === "\r" || data === "\n" ||
data === "\x1b"`. pi requests Kitty keyboard protocol flag 7 at startup —
`disambiguate escape codes`. Under Kitty/Ghostty/WezTerm/foot, Esc arrives
as `\x1b[27u`, Ctrl+C as `\x1b[99;5u`, Enter as `\x1b[13u`. The raw
comparison silently ignored all three, so the close hint ("Press Enter or
Esc to close") was a false promise on those terminals, and the overlay got
stuck (only legacy `\r` worked).

**Lesson**: never hand-roll key matching in a pi extension. The factory's
third argument **is** the `KeybindingsManager` — use
`kb.matches(data, "tui.select.confirm")` / `"tui.select.cancel")`. It
handles legacy + Kitty + modifyOtherKeys + user keybinding overrides. Type
it structurally (`{ matches(data, id): boolean }`) to keep zero runtime
deps.

## 4. Use the *real* keybinding IDs — bare names are not IDs

My first fix used `kb.matches(data, "home")` / `"end"` / `"pageUp"`. Those
are **key names**, not keybinding IDs. `KeybindingsManager.matches` looks
up `keysById.get(keybinding) ?? []` — an unknown ID returns `false`
silently, and the test stub mirrored my wrong IDs, so the tests passed
while the real feature was dead. The real IDs (from pi-tui
`dist/keybindings.js`):

- Scroll: `tui.select.up`, `tui.select.down`, `tui.select.pageUp`,
  `tui.select.pageDown`
- Home/End: `tui.altScreen.top`, `tui.altScreen.bottom`
- Close: `tui.select.confirm`, `tui.select.cancel`

**Lesson**: verify IDs against the installed framework's source, and never
let a test stub define the ground truth. When the stub and the real code
agree by construction, gaps are invisible.

## 5. Partial-fix drift: don't stop at the root cause of the visible bug

The visible bug was the string/array contract. Same-path defects (same
function, same command, same trigger) that were found in review:

- Esc/Ctrl+C dead on Kitty terminals (hint text was a lie)
- No `maxHeight` — tall `--json` payloads on short terminals lost their
  tail including the close hint (pi clips the head)
- Title rendered twice (`buildReportText` + `showOverlay`)
- `invalidate()` no-op with pre-baked themed lines (theme switch while
  open left stale colors)

One reviewer's framing: "items 2 and 3 sit in the same six lines, are
reachable by the same user in the same command, and one of them makes the
overlay's own instructions false. Splitting them means a second release for
a defect you already know about."

**Lesson**: fix the whole path, not the symptom. A second PR for a known
defect is worse than a slightly larger first PR — but only if the extra
scope is genuinely the same path. Don't invent features (scrollbars,
compositor reimplementation) — that's scope creep, not completeness.

## 6. Height budgets must be *closed* against the framework's own clip

I computed a budget (`maxRows`) and assumed pi would honor it. pi's
`maxHeight: "80%"` computes `floor(rows * 0.8)` **without margins** and
clips head-first (`overlayLines.slice(0, maxHeight)`). My `Math.max(10, …)`
floor exceeded pi's budget at rows ≤ 12 → pi clipped the footer, exactly
the failure the code claimed to prevent. Both reviewers independently
found this; my own tests baked the same wrong computation in, so they
could not fail.

**Lesson**: (a) make the budget function *exactly* match the framework's
(no margins, no floor above the framework's); (b) if you can't, use the
framework's own math; (c) never copy the computation into tests — compute
it from the same source or assert against the framework's documented
formula independently.

## 7. Resize-awareness must be live, not captured

I captured `tui.terminal.rows` once at factory time. pi recomputes
`maxHeight: "80%"` on every resize. Shrink → our output exceeded the new
clip → head clipped (footer again on the floor). Also `scrollTop` was
clamped by `windowSlice` but not written back, so the first Up after a
shrink was swallowed.

**Lessons**: read the row source inside `render`/`handleInput` (a `rowGen`
closure), and write the clamped scroll position back to state so input math
agrees with render math. Shared layout math (one `layout()`/`scrollWindowAt`
function) prevents render/handleInput drift.

## 8. ANSI-aware everything — three separate bugs of one class

- **visualWidth**: ESC sequences are zero-width; CJK/emoji are 2 columns;
  surrogate pairs are one char. My first scan treated `[` as a final byte
  (valid CSI has intermediates before `m`), so `\x1b[38;2;…m` was measured
  wrong. OSC-8 hyperlinks (`ESC ]8;;url ESC \`) terminate on BEL or ST, not
  on `0x40–0x7E` — the naive scan stopped inside the URL.
- **wrapLines**: code-unit slicing splits surrogate pairs and ANSI runs.
  Tokenize: visible chars and escape sequences as separate tokens; keep
  escapes atomic; re-apply the leading style to continuation segments (pi
  resets styles per line); never emit a 2-col glyph into a 1-col line.
- **clampChrome**: truncating a styled line must not cut an escape in half.
  Tokenize first, then cut visible text only.

**Lesson**: write one `skipEscape` used everywhere (visualWidth, ansiTokens,
visibleCharCount) — I had three copies and fixed them one at a time, twice
missing the same bug because the copies diverged.

## 9. Padding/width invariants need tests, not eyeballing

The bordered box version had `width + 2` overhang for a full review cycle:
top border built `╭─` + pad + title + pad + `─╮` (two chars each side)
while content rows were `│…│` (one char each side). Every row was a
different visual width. Neither reviewer's static read nor my manual
prints caught it until one computed the arithmetic per-row.

**Lesson**: if a renderer promises "each row is exactly `width`", test it:
`for (const l of out) assert.equal(visualWidth(l), width)` across the
width matrix, and assert the set of widths has size 1. Assert the top
border starts with exactly `╭`, not `/^.*╭/`.

## 10. First fix of the box almost broke the height invariant — keep the math minimal and check it by enumeration

Bordered rendering adds 2 chrome rows (top/bottom border) vs the prior
layout. I iterated budget math several times (chrome = 4 → 5 → 4, status =
2 → 3 rows) and twice got it one row short. The invariant checker that
finally nailed it was a tiny script enumerating
`rows ∈ {5..40} × widths ∈ {3..80}` asserting `out.length ≤ floor(rows*0.8)`
— and a degraded borderless mode for when the box physically can't fit.

**Lesson**: for any budget logic, enumerate the input space in a script
and assert the invariant. Don't trust a single "budget = X" calculation.

## 11. Visual review by a second pair of eyes (Gemini) found what code review missed

After two AI code reviews passed the borderless version, the user said
"can't tell the overlay from the background". Feeding the actual screenshot
to a vision model produced: no frame, no background fill, text mixed with
chat lines, plus a **real text bug** (`3.6d 小时` — runway value with
duplicate units) that both code reviewers had missed.

**Lesson**: UI problems are visual problems. When the complaint is "looks
weird", get an independent reading of the actual pixels, not just the
code. AND: grep for string-concatenation unit duplication whenever you
format a number with its unit twice.

## 12. Release process lessons

- **OIDC trusted publishing**: workflow needs `id-token: write` +
  `setup-node` with `registry-url`; npm side needs the trusted publisher
  configured for the exact workflow filename (case-sensitive, with
  extension). npm ≥ 11.5.1, Node ≥ 22.14. Provenance attestations are
  automatic under trusted publishing.
- **Release workflow config**: `pnpm install --frozen-lockfile` +
  typecheck + test + pack-gate before publish. Changing `package.json`
  deps requires regenerating the lockfile in the same commit.
- **Tag → release**: `v*` tag push triggers the publish workflow; the
  tarball gate (`check-pack.mjs`) enforces the exact file list.

## 13. The "just ship the minimal patch" vs "fix the path" question

Question asked in planning: minimal patch (return `string[]`) vs 5-item
fix. The user chose the full path. Reviewers later confirmed: the minimal
patch would have shipped a known-broken close hint and a
short-terminal-tail-loss, then required a second release. Balance: full
path for the same command path, never for adjacent unrelated features.

## 14. Process discipline (what went wrong in my own workflow)

- I accidentally committed a t2 test change directly to `main` (forgot to
  switch branches after pull), then spent several steps untangling refs.
  Lesson: `git branch -vv` before committing; never commit on `main`
  directly in a ticket workflow.
- I replaced a test's header line with new content via a bad `edit`
  (oldText covered the next test's opening line), leaving a syntax error
  and a missing test — caught only by the next test run. Lesson: run the
  test file immediately after each test edit; a `SyntaxError` in a test
  file is a loud signal of a bad edit, not a flaky test.
- I made budget math edits in a loop without re-enumerating, each time
  "fixing" one case and breaking another. Lesson: for arithmetic-heavy
  code, write the property test *first* (red), then change until green.

## 15. The composite overlay is the wrong model for "distinct modal"

pi overlays composite the component's lines **over** existing screen
content — there is no automatic background dim/mask. If your overlay is
borderless plain text, it visually merges with whatever is behind it. This
is why every pi overlay example draws a box. If you want a "modal" feel,
draw the frame yourself (theme `border` color); pi will not give you one.
