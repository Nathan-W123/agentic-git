# Relay JARVIS Dashboard Design QA

## Comparison Target

- Source visual truth: user-supplied 1920 x 1080 JARVIS desktop HUD reference in the conversation.
- Build plate: `apps/web/public/hud-interface-bg.png`, 1680 x 945, generated from the supplied reference with franchise marks, characters, labels, and fake data intentionally removed.
- Implementation: authenticated Relay Home at `http://127.0.0.1:4317/#overview`.
- Latest implementation screenshot: `docs/qa/relay-hud-final.png`, 1536 x 864.
- Latest source/implementation comparison: `docs/qa/relay-rotor-source-vs-final.png`, 1536 x 1728.
- Short desktop frames: `docs/qa/relay-hud-short-a.png` and `docs/qa/relay-hud-short-b.png`, 1365 x 768.
- Interactive console: `docs/qa/relay-hud-terminal.png`, 1365 x 768.
- Extended telemetry hover: `docs/qa/relay-hud-hover.png`, 1365 x 768.
- Latest touch fallback: `docs/qa/relay-hud-mobile.png`, 390 x 844.
- Machine-readable final checks: `docs/qa/relay-hud-final-results.json`.
- Full comparison: `docs/qa/source-vs-implementation.png`, 1920 x 2160.
- Review-size full comparison: `docs/qa/source-vs-implementation-preview.png`, 960 x 1080.
- Focused core comparison: `docs/qa/focus-core-comparison.png`, 960 x 1560.
- Motion resting state: `docs/qa/relay-motion-rest.png`, 1920 x 1080.
- Motion deployed state: `docs/qa/relay-motion-hover.png`, 1920 x 1080.
- Motion comparison: `docs/qa/relay-motion-comparison.png`, 1920 x 1080.
- Touch fallback: `docs/qa/relay-motion-mobile.png`, 390 x 844.
- Energy-cycle low frame: `docs/qa/relay-motion-energy-a.png`, 1920 x 1080.
- Energy-cycle high frame: `docs/qa/relay-motion-energy-b.png`, 1920 x 1080.
- Energy-cycle comparison: `docs/qa/relay-motion-energy-comparison.png`, 1920 x 540.

## Normalization

- CSS viewport: 1920 x 1080.
- Browser: Microsoft Edge through the isolated `relay-ui` QA session.
- Device scale factor: 1.
- Source plate: normalized from 1680 x 945 to 1920 x 1080 for the comparison.
- Implementation capture: native 1920 x 1080, no browser chrome.
- State: authenticated owner, Local team / Local Project, one canonical repository, seven tasks, nineteen executions, three decided approvals, no active agents, and no registered workers.

## Full-View Evidence

The reference composition is preserved: a month ruler across the top, circular date telemetry at upper left, a dominant central reactor, chained peripheral data rails, system and coordination telemetry at right, and a circular command dock across the bottom. The generated plate supplies low-contrast environmental linework while a transparent mechanical rotor supplies two visible counter-rotating layers. The Relay implementation fills all foreground regions with live product state rather than embedded mock data. The original franchise wordmarks and character art are intentionally replaced by Relay identity and product telemetry.

## Focused Evidence

The focused comparison confirms that the implementation preserves the source plate's hollow center, ring scale, and visual center. The live acceptance score, queue readouts, current task, completion count, replans, and 24-hour graphs fit inside the intended negative space without covering the ring detail. A focused comparison was necessary because those data labels are too small to judge reliably in the review-size full comparison.

## Required Fidelity Surfaces

- Fonts and typography: Bahnschrift and Cascadia Code provide the condensed technical display and tabular data voice of the reference. Hierarchy, uppercase labels, tracking, truncation, and two-line task focus were checked at 1920, 1440, 800, and 390 CSS pixels.
- Spacing and layout: the three-region desktop composition, center scale, top ruler, edge rails, and bottom dock match the reference rhythm. Responsive layouts preserve the core first and move the rails below it without overlapping controls.
- Colors and tokens: the implementation uses a near-black navy canvas, electric cyan linework, ice-blue primary text, and restrained semantic status colors. The final full-page axe audit reports zero violations.
- Image quality and asset fidelity: the generated bitmap plate and transparent reactor rotor are sharp, contain no logos, watermarks, fake values, or placeholder UI, and preserve the reference's dense mechanical language. Live HTML remains legible over the animated machinery.
- Copy and content: every visible value comes from Relay APIs or browser/session state. Product-specific labels use Relay terminology, and no reference-image copy or fake telemetry was retained.
- Icons and affordances: the existing Relay icon family is retained for product consistency. All nine dock controls expose readable labels, focus states, badges, and real navigation actions.

## Comparison History

### Pass 1

- Finding P2: at 1440 x 900, the right system module could shrink beneath its content and overlap the coordination module.
- Fix: prevented telemetry modules from shrinking, capped the feed at the compact breakpoint, and hides only the empty workers module at that width.
- Post-fix evidence: `docs/qa/relay-1440-final.png`; no module overlap or persistent-control clipping remains.

### Pass 2

- Finding P2: the status bar changed to Live on WebSocket open while three Home indicators retained their pre-open Connecting or Down text.
- Fix: added one socket-lifecycle synchronizer for the header, system row, circular link gauge, and status state, plus a regression test.
- Post-fix evidence: Edge reported `LINK ESTABLISHED`, `LIVE`, and `LINK LIVE` in the same settled state.

### Pass 3

- Finding P2: the first axe pass found insufficient contrast in the month ruler and ten tiny secondary telemetry labels.
- Fix: raised only the affected muted-cyan tokens and added semantic landmarks to the context switcher and latest-event tape.
- Post-fix evidence: the final full-page axe 4.12.1 run reports 0 violations and 37 passes. Four bright gauge/date values remain manual-review items only because their image-backed backgrounds cannot be inferred by axe; visual inspection confirms high contrast.

### Pass 4

- Finding P2: the first touch capture placed the two lower satellite controls over the first graph heading.
- Fix: reserved additional height for the mobile center so the always-visible touch controls and graph stack occupy separate regions.
- Post-fix evidence: Edge reports all four touch satellites inside the viewport with no score or graph overlap. Desktop satellites also avoid both rails and graphs.
- Motion evidence: the background plate transform changes over time, all four satellites deploy to visible positions on hover and keyboard focus, and reduced-motion emulation disables both plate and score animations plus orb transitions.
- Semantic evidence: after assigning the satellite group and sandbox warning valid landmark roles, the final axe 4.12.1 audit reports 0 violations and 41 passes. Six image-backed contrast checks remain manual-review items and are visibly high contrast.

### Pass 5

- Finding P2: the original 22-second plate drift changed scale by less than one percent, so it was technically active but visually imperceptible in normal use.
- Fix: split the plate into a 13-second parallax drift and a 5.4-second cyan energy cycle. The plate now traverses a 2.6% scale range while opacity, brightness, and saturation visibly breathe.
- Post-fix evidence: Edge frames captured 2.7 seconds apart move from 82% to 95% opacity with distinct transform and filter matrices. A 32,400-point pixel sample measured meaningful change across 16.79% of the viewport.
- Accessibility evidence: the strengthened animation still honors `prefers-reduced-motion`; the final axe 4.12.1 audit remains at 0 violations and 41 passes.

### Pass 6

- Finding P1: the animated plate read as lateral movement rather than rotating machinery; the Home sandbox warning duplicated System telemetry; the 720-pixel minimum height could place the command dock below short desktop viewports; and the terminal opened with no useful initial state when Docker was offline.
- Fix: removed plate translation, added a real transparent segmented rotor rendered as 34-second clockwise and 19-second counter-clockwise layers, removed the duplicate Home warning, let desktop Home fit its available height, and floated the functional console above the dock. The console now provides live `status`, `tasks`, `runs`, `agents`, `approvals`, `repos`, `whoami`, and `open <view>` commands even without Docker.
- Motion evidence: Edge matrices for both rotor layers changed across frames while the plate transform remained `none`. Reduced-motion emulation reports `animation-name: none` for the rotor, meters, and score.
- Layout evidence: at 1365 x 768, all nine dock buttons are inside the viewport, the console clears the dock, its input stays focused and editable, and there is no horizontal overflow. The 390 x 844 touch capture also has no horizontal overflow and keeps all four satellite stats visible.
- Runtime evidence: the banner is absent, the rotor asset loads successfully, live terminal commands and the sandbox-offline fallback both render, every button in the accessibility tree has a name, and Edge reports no runtime errors or failed network requests.

## Interaction And Runtime Checks

- Circular Board navigation opened the real task board with live task data.
- Organization and project selectors remained available only on Home.
- Terminal, Events, Refresh, repository history, approval, and dock controls remained interactive. The terminal accepts keyboard input and keeps product commands available while the optional Docker sandbox is offline.
- Extended telemetry reads live plan revision, scope request, failed execution, and retained audit counts; every orb has an accessible name and routes to the relevant product surface.
- Hover, keyboard-focus, and touch deployment states passed in Microsoft Edge at 1920 x 1080 and 390 x 844.
- Browser errors: none.
- Responsive captures: 1440 x 900, 800 x 1200, and 390 x 844.
- Web package: build passed; all 53 tests passed, including offline console and counter-rotating asset regression coverage.

## Findings

No actionable P0, P1, or P2 visual, responsive, interaction, or accessibility findings remain.

## Follow-Up Polish

- P3: a native 1920 x 1080 plate could remove the small amount of bitmap upscaling at the largest target viewport, though the current linework is visually sharp.

final result: passed
