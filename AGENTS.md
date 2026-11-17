# Repository Development Rules

All source code, technical documentation, UI copy, logs, and configuration examples are written in EN-US.

## Canonical Web UI and Form Layout Rules

These requirements apply to all existing and future screens in this repository, including dynamically created DOM controls:

1. Define and reuse design tokens for surface, text, border, focus, and vertical spacing. Do not rely on browser defaults for any form control.
2. Style all of: `input` (including `type=file`), `select`, `option`, `textarea`, `button`, and their disabled, hover, focus-visible, and validation states. Keep foreground/background contrast appropriate for dark mode.
3. Form controls use `box-sizing:border-box`, consistent font, border, radius, min-height, width, padding, line-height, and dark-theme appearance. File-picker buttons must be explicitly styled.
4. Enforce vertical rhythm: labels have bottom spacing; controls have bottom spacing; groups/sections/cards have separation. Controls must never visually touch adjacent text or controls.
5. Avoid generic rules that accidentally override a compact component (e.g. selects): prefer shared foundational rules plus explicit variants.
6. Generated DOM elements must receive the same styling as static markup. Build views using reusable field/group helpers or semantic wrappers where reasonable.
7. On narrow viewports, controls must fit their container without overflow or overlap. Action rows should wrap with gaps.
8. Focus indicators must be visible and keyboard navigation must work. Labels should be associated with inputs via `for`/`id`, or explicit semantic wrapping; add unique IDs for dynamic form controls.
9. Every UI change must include a visual QA pass at desktop and mobile widths, with a checklist for dropdowns, text inputs, textareas, file inputs, messages, cards, and vertical margins.
10. Do not introduce new inline spacing hacks where a token or reusable CSS utility will work. Update the shared rules instead.

For the current single-file Client Admin, the canonical CSS and tokens live in `public/admin.html` inside `<style>`. If the UI expands into multiple screens, extract these rules into a shared stylesheet and update the Content Security Policy accordingly.

This rule is repository-scoped. Other projects must adopt an equivalent policy explicitly.
