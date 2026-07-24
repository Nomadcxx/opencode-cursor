# Design — opencode-cursor documentation

A locked design system for the documentation app. Extend this file when the
system needs to grow; do not pick a new theme per page.

## Genre

Modern-minimal, in a technical documentation register.

## Macrostructure family

- Documentation home: Index-First. The page opens with a short identity block
  and makes the page groups the primary content.
- Application shell: Workbench-informed. Persistent navigation, search, page
  tools, and the table of contents behave like an instrument panel.
- Content pages: Long Document. One readable column, direct section heads,
  inline code, tables, and restrained page tools.

## Theme

- `--color-paper` `oklch(17.5% 0.025 279)`
- `--color-paper-2` `oklch(21.5% 0.03 279)`
- `--color-paper-3` `oklch(26.4% 0.0374 279.11)`
- `--color-ink` `oklch(97.4% 0.0158 196.9)`
- `--color-ink-2` `oklch(77.57% 0.0552 274.6)`
- `--color-rule` `oklch(34% 0.045 275)`
- `--color-accent` `oklch(85.61% 0.1934 156.24)`
- `--color-signal` `oklch(79.48% 0.1427 218.32)`
- `--color-focus` `oklch(87% 0.2 156.24)`

Green is the active and focus signal. Cyan is reserved for links and compact
identity geometry. Neither colour fills large surfaces.

## Typography

- Display: IBM Plex Sans Variable, weight 700, normal.
- Body: IBM Plex Sans Variable, weight 400.
- Mono: Fira Code, weights 400–600.
- Display tracking: `-0.025em`.
- Type scale anchor: `--text-display = clamp(2rem, 6vw, 4rem)`.

## Spacing

The 4-point named scale lives in `app/tokens.css`. Page and component rules use
named tokens rather than raw spacing values.

## Motion

- Easing: `--ease-out`, an exponential ease-out curve.
- Reveal pattern: none. Documentation is present immediately.
- Reduced motion: remove transforms and transitions.

## Microinteractions stance

- Focus appears instantly.
- Hover is a colour or surface shift, only on hover-capable pointers.
- Pressed controls move down by one pixel.
- Silent success. No decorative toasts or bounce.
- Every touch-reachable control has a 44 px hit area.

## CTA voice

- Primary action: typographic link with a short underline and one-line label.
- Secondary action: quiet bordered control with a 6 px radius.

## Per-page allowances

- The documentation home may use the compact geometry mark once.
- The app shell uses no decorative enrichment.
- Content pages use typography and semantic data structures only.

## What pages must share

- The compact OCC mark and plain-text `opencode-cursor` wordmark.
- The green and cyan signal roles.
- IBM Plex Sans and Fira Code.
- The same control geometry and focus treatment.
- Stacked section headings without slash ornaments, decorative eyebrows, or
  hanging chapter labels.

## What pages may differ on

- The home is an index; articles are long documents.
- Dense reference pages may replace wide tables with labelled mobile records.
- Architecture pages may use plain-text diagrams inside the normal prose
  measure.
