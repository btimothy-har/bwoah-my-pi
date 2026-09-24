---
name: frontend-design
description: "Frontend design guidance for building distinctive, usable interfaces as runnable HTML, CSS, JavaScript, or project-native component code. Relevant work includes pages, components, applications, dashboards, landing pages, interactive prototypes and mockups, screenshot-to-code, responsive redesigns, and visual polish."
---

# Frontend Design

Build the interface, not a picture of it.

For frontend mockups and prototypes, runnable source code and its live browser rendering are the deliverable. Screenshots are references or verification evidence, never a substitute for implementation. Image generation is opt-in asset work only when the user explicitly requests it.

Scale the process to the task. A new surface or substantial redesign needs a clear direction; a contained visual fix should preserve the established direction and proceed without ceremony.

## Establish the Brief

Before choosing a direction, identify:

- the subject or product
- the audience and usage context
- the interface's primary job
- the real content and data it presents
- technical, brand, accessibility, and responsive constraints
- whether it is a product or marketing surface

Investigate before asking. Read project guidance, representative source, package scripts, components, tokens, styles, assets, and tests. Ask the user only for decisions that cannot be recovered from the project or supplied references. For a substantial implementation, form a concise approach before building and proceed with it; ask the user only when material unresolved tradeoffs require a choice. Do not create a parallel interview, approval flow, or design-plan file.

Product interfaces prioritize task completion, clear state, and appropriate information density. Marketing surfaces prioritize identity, narrative, and a clear conversion path. Do not apply campaign furniture to operational UI or turn a marketing page into an application dashboard.

## Respect the Existing System

In an existing frontend:

- Use its framework, source structure, components, tokens, typography, icon set, assets, and conventions.
- Improve the existing visual language before inventing a replacement.
- Work in the real source and normal development pipeline, not generated output.
- Do not scaffold a parallel app for convenience.
- Do not introduce a second framework, styling system, component library, or icon library merely to express the design.
- Surface any necessary design-system expansion before making it.

Project constraints beat personal aesthetic preference.

## Choose a Specific Direction

For new or substantially changed work, form a compact direction before coding:

- **Thesis** — one sentence describing the intended character and why it fits the subject.
- **Color** — semantic roles and relationships, grounded in existing tokens when present.
- **Typography** — roles, hierarchy, measure, and voice.
- **Layout** — topology, rhythm, density, and information hierarchy.
- **Signature** — one memorable element or interaction specific to the brief.

Use this genericity test:

> If an unrelated product could replace the name and content without changing the design, the direction is not specific enough.

Distinctiveness comes from the subject, not from randomly selecting a fashionable style. Do not replace judgment with permanent bans on particular fonts, colors, gradients, cards, or visual genres. Familiar choices are valid when the brief supports them; unexplained defaults are not.

Spend boldness deliberately. One strong signature usually works better than unrelated decoration throughout the interface. Cards, dividers, labels, numbering, icons, and other structural devices must communicate something real.

## Choose the Implementation Path

### Existing Frontend

Edit the intended source files and preview through the project's existing development command and build pipeline. Preserve current behavior unless the brief changes it. Do not write into generated directories such as `dist`, `build`, or framework caches.

### Standalone Prototype

For deliberate framework-free exploration, create one focused, self-contained HTML file:

- Inline its CSS and JavaScript.
- Require no build step or external dependency.
- Use semantic HTML and real interactive controls.
- Include a useful default state.
- Make the composition responsive.
- Use CSS custom properties for its visual system.
- Keep the file small enough to remain understandable as one artifact.

Preview it in a real browser using whatever browser capability the environment provides — open the file directly or serve it with a simple static server. If the artifact is becoming an application rather than a focused prototype, stop and move into an appropriate project structure instead of growing the single file indefinitely.

### Multiple Directions

Create multiple coded directions only when the user asks to compare options.

- Preserve an existing implementation as the baseline when applicable.
- Vary hierarchy, topology, density, or interaction—not just color.
- Compare the running variants in the browser with the same representative content.
- Remove rejected variants and temporary switching scaffolds after selection.

Do not generate image comps as an intermediate frontend specification.

## Build the Whole Interface

Implement the direction with:

- specific, domain-appropriate content rather than filler
- representative data that is clearly sample data when it is not real
- semantic landmarks, headings, controls, links, labels, and form associations
- clear default, hover, focus-visible, active, disabled, loading, empty, error, success, and overflow states where applicable
- responsive composition rather than simple shrinking
- readable contrast and visible keyboard focus
- keyboard-operable primary flows
- touch targets appropriate to the interaction
- reduced-motion behavior for nonessential animation
- stable layouts without avoidable overflow or layout shift
- reusable patterns that follow the project's component boundaries

A visible control should work, lead somewhere meaningful, or be presented honestly as unavailable. Do not ship lorem ipsum, arbitrary metrics presented as fact, dead controls, rasterized interface text, or screenshots standing in for UI.

Use supplied and project-owned assets first. If required imagery is unavailable, ask for it or use an explicitly identified temporary placeholder. Do not silently generate imagery or disguise missing content with decorative interface blocks.

## Use Motion Deliberately

Motion should clarify cause and effect, provide feedback, establish continuity, or support the chosen atmosphere. Prefer CSS for simple transitions and compositor-friendly properties when possible. Avoid mechanically applying the same entrance effect to every section. Respect `prefers-reduced-motion`.

No motion is better than motion without a purpose.

## Inspect the Live Result

When browser access is available, use whatever browser capability the environment provides (an automation driver, a controlled browser tab, or the user's own browser) to inspect the actual rendered result:

1. Open the actual implementation, using its existing server or the standalone HTML preview workflow.
2. Inspect the accessibility snapshot.
3. Capture and read screenshots when visual judgment matters.
4. Check mobile and desktop widths; add intermediate widths when the layout changes materially.
5. Exercise the primary flow and important interaction states.
6. Check keyboard focus and navigation.
7. Inspect console errors and failed network requests.
8. Compare the result with the brief and chosen direction.
9. Fix material defects, then inspect again.

A screenshot that was captured but not read does not count as visual verification. Automated checks reveal defects; they do not prove that a design is good. Do not invent changes merely to demonstrate iteration.

If browser access is unavailable, complete the code work that can be verified locally and state clearly that rendered inspection remains outstanding.

## Present the Result

Report:

- the source files or live URL
- the direction and key decisions
- the viewports, states, and interactions inspected
- material defects corrected after browser inspection
- unresolved asset, content, accessibility, or browser risks

Ask what is working and what is not. Continue iterating in code.
