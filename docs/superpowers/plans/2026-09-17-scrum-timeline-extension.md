# Scrum Timeline Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Chrome/Brave extension in the workspace-level `timeline/` directory that reads the authenticated G05 GitLab board and presents its open activities as an automatically refreshed timeline.

**Architecture:** A Manifest V3 content script runs only on the G05 board, reads open issues through GitLab's same-origin REST API, normalizes them into domain objects, and renders an isolated overlay. Pure date and normalization modules keep the timeline rules testable, while a small controller owns DOM injection, refresh scheduling, and cleanup.

**Tech Stack:** TypeScript, DOM APIs, Manifest V3, esbuild, Vitest, jsdom

**Spec:** `docs/superpowers/specs/2026-09-17-scrum-timeline-extension-design.md`

## Global Constraints

- All extension source files live in `/home/messias/Documentos/github/g05-md7/timeline`, outside the `g05` repository directory.
- Read only open issues from project `graduacao/2026-2a/t15/g05` (`data-project-id` currently `29527`).
- Do not send issue mutations or persist credentials, cookies, tokens, or project content.
- Exclude aggregate issues `#179`, `#180`, and `#181` from timeline rows and use them as ART 1, ART 2, and ART 3 legend content.
- Refresh once when opened, every 60 seconds while visible, and when the user clicks **Atualizar agora**.
- Missing start dates use the global start, missing due dates use the global end, and issues missing both dates span the entire global interval.
- The implementation must run in both Chrome and Brave as an unpacked Manifest V3 extension.
- Render all GitLab-provided strings with `textContent`; never inject issue title, description, label, or user data through `innerHTML`.

---

## File Map

- `timeline/package.json`: dependency versions and test/build/typecheck scripts.
- `timeline/tsconfig.json`: strict browser TypeScript configuration.
- `timeline/vitest.config.ts`: jsdom test environment and setup file.
- `timeline/build.mjs`: esbuild bundle plus manifest/CSS copy into `dist/`.
- `timeline/manifest.json`: extension metadata, board match pattern, and same-origin host access.
- `timeline/src/model.ts`: stable domain and DTO types shared by all modules.
- `timeline/src/timeline.ts`: civil-date parsing, global interval, and bar placement rules.
- `timeline/src/gitlab-client.ts`: authenticated GET, response validation, issue normalization, and artifact extraction.
- `timeline/src/timeline-view.ts`: accessible DOM rendering and user event callbacks.
- `timeline/src/controller.ts`: board button injection, refresh lifecycle, timer, and error retention.
- `timeline/src/content-script.ts`: browser entrypoint and SPA remount observer.
- `timeline/src/styles.css`: namespaced overlay, timeline, badges, responsive behavior, and focus styles.
- `timeline/tests/*.test.ts`: unit and DOM integration tests for each responsibility.
- `timeline/README.md`: build, unpacked installation, usage, privacy, and troubleshooting.

---

### Task 1: Buildable Manifest V3 skeleton

**Files:**
- Create: `timeline/package.json`
- Create: `timeline/tsconfig.json`
- Create: `timeline/vitest.config.ts`
- Create: `timeline/tests/setup.ts`
- Create: `timeline/build.mjs`
- Create: `timeline/manifest.json`
- Create: `timeline/src/content-script.ts`
- Create: `timeline/src/styles.css`
- Test: `timeline/tests/manifest.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `npm run build`, `npm test`, and a loadable `timeline/dist/` containing `manifest.json`, `content-script.js`, and `styles.css`.

- [ ] **Step 1: Create package and TypeScript configuration**

Create `package.json` with scripts `build`, `test`, and `typecheck`; use `esbuild`, `typescript`, `vitest`, `jsdom`, and `@types/chrome` as development dependencies. Configure TypeScript with `strict: true`, `moduleResolution: "Bundler"`, `lib: ["ES2022", "DOM", "DOM.Iterable"]`, and `noEmit: true`.

```json
{
  "name": "g05-scrum-timeline",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.287",
    "esbuild": "^0.25.0",
    "jsdom": "^25.0.1",
    "typescript": "^5.7.3",
    "vitest": "^2.1.9"
  }
}
```

- [ ] **Step 2: Write the manifest test before the manifest exists**

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("manifest", () => {
  it("runs only on the G05 board and exposes no write permissions", async () => {
    const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions ?? []).toEqual([]);
    expect(manifest.content_scripts[0].matches).toEqual([
      "https://git.inteli.edu.br/graduacao/2026-2a/t15/g05/-/boards*"
    ]);
    expect(manifest.content_scripts[0].js).toEqual(["content-script.js"]);
    expect(manifest.content_scripts[0].css).toEqual(["styles.css"]);
  });
});
```

- [ ] **Step 3: Run the manifest test and verify the expected failure**

Run: `cd /home/messias/Documentos/github/g05-md7/timeline && npm install && npm test -- manifest.test.ts`

Expected: FAIL because `manifest.json` does not exist.

- [ ] **Step 4: Add the minimal manifest, entrypoint, stylesheet, and build script**

Use this manifest:

```json
{
  "manifest_version": 3,
  "name": "G05 Scrum Timeline",
  "version": "1.0.0",
  "description": "Linha do tempo das atividades abertas do Scrum Board G05.",
  "host_permissions": ["https://git.inteli.edu.br/*"],
  "content_scripts": [{
    "matches": ["https://git.inteli.edu.br/graduacao/2026-2a/t15/g05/-/boards*"],
    "js": ["content-script.js"],
    "css": ["styles.css"],
    "run_at": "document_idle"
  }]
}
```

Start `content-script.ts` with `document.documentElement.dataset.g05TimelineLoaded = "true";`. Add only the namespace sentinel `#g05-timeline-root { box-sizing: border-box; }` to `styles.css`.

Implement `build.mjs` with `esbuild.build({ entryPoints: ["src/content-script.ts"], bundle: true, format: "iife", target: "chrome120", outfile: "dist/content-script.js" })`, recreate `dist/`, and copy `manifest.json` plus `src/styles.css` to `dist/` using `node:fs/promises`.

- [ ] **Step 5: Verify the skeleton**

Run: `npm test -- manifest.test.ts && npm run typecheck && npm run build`

Expected: one passing test, successful typecheck, and three files in `dist/`.

- [ ] **Step 6: Commit the independently buildable skeleton if the workspace parent is under version control**

```bash
git add timeline/package.json timeline/package-lock.json timeline/tsconfig.json timeline/vitest.config.ts timeline/tests/setup.ts timeline/tests/manifest.test.ts timeline/build.mjs timeline/manifest.json timeline/src/content-script.ts timeline/src/styles.css
git commit -m "build: scaffold scrum timeline extension"
```

If `timeline/` is not inside a Git worktree, record that fact in the execution notes and continue without moving the directory.

---

### Task 2: Domain model and timeline calculations

**Files:**
- Create: `timeline/src/model.ts`
- Create: `timeline/src/timeline.ts`
- Test: `timeline/tests/timeline.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `TimelineIssue`, `Artifact`, `TimelineRange`, `ResolvedTimelineIssue`, `resolveTimeline(issues, today)` and `enumerateDays(range)`.

- [ ] **Step 1: Define the stable domain types**

```ts
export type Assignee = { name: string; username: string; avatarUrl: string | null };
export type TimelineIssue = {
  iid: number;
  title: string;
  webUrl: string;
  labels: string[];
  assignees: Assignee[];
  startDate: string | null;
  dueDate: string | null;
};
export type ArtifactCode = "ART 1" | "ART 2" | "ART 3";
export type Artifact = {
  code: ArtifactCode;
  iid: number;
  title: string;
  description: string;
  webUrl: string;
};
export type TimelineRange = { start: string; end: string; dayCount: number; inferred: boolean };
export type ResolvedTimelineIssue = TimelineIssue & {
  resolvedStart: string;
  resolvedEnd: string;
  startOffset: number;
  spanDays: number;
  inferredStart: boolean;
  inferredEnd: boolean;
  invalidRange: boolean;
};
```

- [ ] **Step 2: Write failing tests for explicit, partial, absent, and invalid dates**

Create a helper `issue(iid, startDate, dueDate)` and assert:

```ts
const result = resolveTimeline([
  issue(1, "2026-09-15", "2026-09-17"),
  issue(2, null, "2026-09-16"),
  issue(3, "2026-09-16", null),
  issue(4, null, null)
], "2026-09-17");

expect(result.range).toEqual({ start: "2026-09-15", end: "2026-09-17", dayCount: 3, inferred: false });
expect(result.issues.find(({ iid }) => iid === 2)).toMatchObject({ resolvedStart: "2026-09-15", inferredStart: true });
expect(result.issues.find(({ iid }) => iid === 3)).toMatchObject({ resolvedEnd: "2026-09-17", inferredEnd: true });
expect(result.issues.find(({ iid }) => iid === 4)).toMatchObject({ resolvedStart: "2026-09-15", resolvedEnd: "2026-09-17", spanDays: 3 });
```

Also assert that no dated issues produce `today` through `today + 7 days`, one-day issues have `spanDays: 1`, civil dates do not shift across time zones, and a start after due date yields `invalidRange: true` with a one-day rendered span at the start date.

- [ ] **Step 3: Run the timeline tests and verify failure**

Run: `npm test -- timeline.test.ts`

Expected: FAIL because `resolveTimeline` and `enumerateDays` are missing.

- [ ] **Step 4: Implement civil-date utilities and resolution**

Parse `YYYY-MM-DD` with `Date.UTC(year, month - 1, day)`. Derive the global start from valid start dates and the global end from valid due dates. When one side is entirely absent, use the other side for both extrema before applying the per-issue missing-date rules. When all dates are absent, use `[today, today + 7 days]` and set `inferred: true`.

Expose:

```ts
export function resolveTimeline(
  issues: TimelineIssue[],
  today: string
): { range: TimelineRange; issues: ResolvedTimelineIssue[] };

export function enumerateDays(range: TimelineRange): string[];

export function formatCivilDate(value: string): string;
```

For inconsistent dates, keep `resolvedStart` as the supplied start, set `resolvedEnd` to the same date, set `invalidRange: true`, and let the UI explain the original due date.

- [ ] **Step 5: Verify calculations and commit**

Run: `npm test -- timeline.test.ts && npm run typecheck`

Expected: all date tests pass.

```bash
git add timeline/src/model.ts timeline/src/timeline.ts timeline/tests/timeline.test.ts
git commit -m "feat: calculate scrum timeline periods"
```

---

### Task 3: Authenticated GitLab reader and artifact normalization

**Files:**
- Create: `timeline/src/gitlab-client.ts`
- Test: `timeline/tests/gitlab-client.test.ts`

**Interfaces:**
- Consumes: `TimelineIssue`, `Artifact`, and `ArtifactCode` from `model.ts`.
- Produces: `loadBoardData(fetchFn, context): Promise<{ issues: TimelineIssue[]; artifacts: Artifact[] }>` and `GitLabReadError`.

- [ ] **Step 1: Write DTO and normalization tests around a realistic response**

Use a fixture with issues `#179`, `#197`, and `#198`. Include string labels, multiple assignees, `start_date`, `due_date`, `description`, and `web_url`. Assert that `#179` becomes an ART 1 artifact, does not remain in `issues`, and that `#197` preserves dates, assignee names, labels, and URL.

```ts
const data = await loadBoardData(fetchMock, {
  origin: "https://git.inteli.edu.br",
  projectId: "29527"
});
expect(data.artifacts[0]).toMatchObject({ code: "ART 1", iid: 179 });
expect(data.issues.map(({ iid }) => iid)).toEqual([197, 198]);
expect(fetchMock).toHaveBeenCalledWith(
  "https://git.inteli.edu.br/api/v4/projects/29527/issues?scope=all&state=opened&per_page=100&with_labels_details=true",
  { credentials: "include", headers: { Accept: "application/json" } }
);
```

Add cases for detailed label objects, missing assignees, non-JSON responses, status `401`, status `403`, and a second page indicated by the `x-next-page` header.

- [ ] **Step 2: Run the client test and verify failure**

Run: `npm test -- gitlab-client.test.ts`

Expected: FAIL because `gitlab-client.ts` does not exist.

- [ ] **Step 3: Implement read-only pagination and response validation**

Define a `FetchLike` type matching `fetch`. Request only `GET` URLs, include credentials, and reject any response whose status is not successful or whose `content-type` does not include `application/json`.

```ts
export class GitLabReadError extends Error {
  constructor(public readonly kind: "authentication" | "permission" | "network" | "invalid-response", message: string) {
    super(message);
  }
}

export async function loadBoardData(
  fetchFn: FetchLike,
  context: { origin: string; projectId: string }
): Promise<{ issues: TimelineIssue[]; artifacts: Artifact[] }>;
```

Follow `x-next-page` until it is empty. Normalize `start_date` and `due_date` without converting them to `Date`. Accept either string labels or `{ name: string }` labels because `with_labels_details=true` changes the response shape between GitLab versions.

- [ ] **Step 4: Separate artifact aggregates by stable IID and label**

Use this exact map:

```ts
const ARTIFACTS_BY_IID = new Map<number, ArtifactCode>([
  [179, "ART 1"],
  [180, "ART 2"],
  [181, "ART 3"]
]);
```

Only convert one of these IIDs to an artifact when its labels include the mapped code or its title begins with `[ART n]`. Keep its complete plain Markdown description for the modal. Sort artifacts ART 1 through ART 3 and activities by start date, then due date, then IID.

- [ ] **Step 5: Verify the client and commit**

Run: `npm test -- gitlab-client.test.ts && npm run typecheck`

Expected: all client tests pass, including pagination and authorization errors.

```bash
git add timeline/src/gitlab-client.ts timeline/tests/gitlab-client.test.ts
git commit -m "feat: read open GitLab issues"
```

---

### Task 4: Accessible timeline and artifact interface

**Files:**
- Create: `timeline/src/timeline-view.ts`
- Modify: `timeline/src/styles.css`
- Test: `timeline/tests/timeline-view.test.ts`

**Interfaces:**
- Consumes: `Artifact`, `ResolvedTimelineIssue`, `TimelineRange`, `enumerateDays`, and `formatCivilDate`.
- Produces: `createTimelineView(options): TimelineView` with `setLoading`, `render`, `setError`, `setLastUpdated`, `open`, `close`, and `destroy` methods.

- [ ] **Step 1: Write DOM tests for the main interactions**

Instantiate the view in jsdom with one resolved issue and three artifacts. Assert:

```ts
expect(screen.getByRole("dialog", { name: "Linha do tempo do Scrum Board" })).toBeTruthy();
expect(screen.getByText("Implantar melhorias")).toBeTruthy();
expect(screen.getByText("Rayssa Guedes França")).toBeTruthy();
expect(screen.getByRole("button", { name: /ART 3/i })).toBeTruthy();
```

Click ART 3 and verify a detail dialog containing its description and issue link. Press `Escape` and verify focus returns to the ART button. Click an activity and assert `onOpenIssue` receives its URL. Verify `Sem responsável`, inferred-date labels, invalid-range warning, loading state, retained-data warning, empty state, last-update text, and that user strings containing `<img onerror>` render as text rather than elements.

- [ ] **Step 2: Run the view test and verify failure**

Run: `npm test -- timeline-view.test.ts`

Expected: FAIL because `createTimelineView` is missing.

- [ ] **Step 3: Implement DOM-only rendering**

Use `document.createElement`, `replaceChildren`, `textContent`, and event listeners. Do not use `innerHTML`. Render the overlay as a `<section role="dialog" aria-modal="true" aria-label="Linha do tempo do Scrum Board">` with:

- header and counts;
- ART buttons in a `<nav aria-label="Legenda de artefatos">`;
- sticky metadata column;
- one day header per value returned by `enumerateDays`;
- one row per resolved activity;
- one `<button>` bar per activity with `grid-column: startOffset + 1 / span spanDays`;
- an artifact `<dialog>` with a `<pre>`-like text container that preserves line breaks.

Use exact callback types:

```ts
type TimelineViewOptions = {
  host: HTMLElement;
  onRefresh: () => void;
  onClose: () => void;
  onOpenIssue: (url: string) => void;
};
```

- [ ] **Step 4: Add namespaced responsive styles**

Prefix every selector with `#g05-timeline-root`. Use a fixed overlay with a white/dark neutral surface, a 320px sticky metadata column, `minmax(44px, 1fr)` day columns, visible `:focus-visible` outlines, label pills, a patterned appearance for inferred spans, and a warning border for invalid spans. At widths below 900px, stack metadata above each row and allow horizontal scrolling in the day grid.

Respect `prefers-reduced-motion: reduce` and use no animations when it is enabled.

- [ ] **Step 5: Verify view behavior and commit**

Run: `npm test -- timeline-view.test.ts && npm run typecheck`

Expected: all DOM tests pass.

```bash
git add timeline/src/timeline-view.ts timeline/src/styles.css timeline/tests/timeline-view.test.ts
git commit -m "feat: render interactive scrum timeline"
```

---

### Task 5: Board integration and refresh lifecycle

**Files:**
- Create: `timeline/src/controller.ts`
- Modify: `timeline/src/content-script.ts`
- Test: `timeline/tests/controller.test.ts`

**Interfaces:**
- Consumes: `loadBoardData`, `resolveTimeline`, and `createTimelineView`.
- Produces: `createTimelineController(dependencies): TimelineController` and automatic mounting from `content-script.ts`.

- [ ] **Step 1: Write controller tests with fake clock and loader**

Create a board fixture containing `body[data-project-id="29527"]`, `<main>`, and `<h1>Issue Boards</h1>`. Assert that `mount()` adds exactly one **Linha do tempo** button even when called twice. After clicking it, assert one immediate load, a second load after `vi.advanceTimersByTime(60_000)`, no concurrent load while a deferred promise is unresolved, manual refresh, and no timer calls after close.

Also assert that a failed second refresh keeps previously rendered data and calls `setError(message, true)`, while an initial failure calls `setError(message, false)`.

- [ ] **Step 2: Run the controller test and verify failure**

Run: `npm test -- controller.test.ts`

Expected: FAIL because `createTimelineController` does not exist.

- [ ] **Step 3: Implement controller ownership and dependency injection**

Expose:

```ts
export function createTimelineController(dependencies: {
  document: Document;
  fetchFn: typeof fetch;
  origin: string;
  now: () => Date;
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
}): TimelineController;
```

The controller must:

- read `document.body.dataset.projectId` and refuse to mount outside the expected project path;
- place the button next to the `Issue Boards` heading, falling back to the start of `<main>`;
- create the view only after the user clicks the button;
- format `today` from local date parts as `YYYY-MM-DD`;
- retain the last valid board data across refresh errors;
- skip refresh when `refreshing === true`;
- create one 60-second interval only while open;
- remove listeners, interval, button, and overlay in `destroy()`.

- [ ] **Step 4: Add SPA-safe entrypoint behavior**

In `content-script.ts`, keep a single controller on `globalThis` under a symbol created with `Symbol.for("g05.scrumTimeline.controller")`. Mount immediately, then attach a debounced `MutationObserver` to remount the button after GitLab client-side navigation. If the pathname leaves `/graduacao/2026-2a/t15/g05/-/boards`, call `destroy()`.

Open issue URLs with `window.open(url, "_blank", "noopener,noreferrer")`.

- [ ] **Step 5: Verify lifecycle, full tests, and build**

Run: `npm test && npm run typecheck && npm run build`

Expected: all tests pass and `dist/` rebuilds successfully.

```bash
git add timeline/src/controller.ts timeline/src/content-script.ts timeline/tests/controller.test.ts
git commit -m "feat: integrate timeline with GitLab board"
```

---

### Task 6: Documentation and live-board validation

**Files:**
- Create: `timeline/README.md`
- Modify only if validation finds a defect: files under `timeline/src/` and matching tests under `timeline/tests/`.

**Interfaces:**
- Consumes: the built `timeline/dist/` extension.
- Produces: installation instructions and evidence that the real authenticated board meets the acceptance criteria.

- [ ] **Step 1: Write operator instructions**

Document these exact flows in Portuguese:

1. run `npm install`, `npm test`, and `npm run build` inside `g05-md7/timeline`;
2. open `chrome://extensions` or `brave://extensions`;
3. enable developer mode;
4. choose **Carregar sem compactação** and select `g05-md7/timeline/dist`;
5. open the G05 Scrum Board and click **Linha do tempo**;
6. use **Atualizar agora** after board edits if immediate refresh is desired;
7. rebuild and reload the unpacked extension after source changes.

State that the extension makes read-only authenticated requests to `git.inteli.edu.br`, stores no credentials, and sends no data elsewhere. Include troubleshooting for expired session, missing button, permission response, and stale unpacked build.

- [ ] **Step 2: Run automated verification before browser installation**

Run: `npm test && npm run typecheck && npm run build`

Expected: all tests and typecheck pass; `dist/manifest.json`, `dist/content-script.js`, and `dist/styles.css` exist.

- [ ] **Step 3: Ask for action-time confirmation before installing the unpacked extension**

Explain that the extension will be installed locally in Chrome/Brave and will receive read access to pages under `git.inteli.edu.br`. Wait for explicit confirmation immediately before using the browser's extension installation UI. If the user prefers manual installation, provide the `dist/` path and continue validation after they report it loaded.

- [ ] **Step 4: Validate against the authenticated Scrum Board**

On `https://git.inteli.edu.br/graduacao/2026-2a/t15/g05/-/boards`, verify:

- the button appears once;
- the extension reads only open issues;
- `#179`, `#180`, and `#181` appear only in the ART legend;
- clicking ART 1, ART 2, and ART 3 shows their current GitLab descriptions;
- task rows show title, non-ART labels, ART buttons, and every assignee;
- issue `#197` renders with start and due date `2026-09-16` if those values remain current;
- missing-date activities apply the approved global-edge rules;
- **Atualizar agora** changes the last-updated timestamp;
- clicking a task opens its GitLab issue;
- closing and reopening creates no duplicate timer or button;
- keyboard focus and `Escape` work for artifact details.

- [ ] **Step 5: Fix any observed defect with a failing regression test first**

For each defect, add one test that reproduces it, run that test to see it fail, apply the smallest implementation change, and rerun `npm test && npm run typecheck && npm run build`.

- [ ] **Step 6: Commit documentation if the workspace parent is under version control**

```bash
git add timeline/README.md timeline/src timeline/tests
git commit -m "docs: document scrum timeline extension"
```

If `timeline/` is not inside a Git worktree, leave the verified files in the user-requested location and report that they are outside the `g05` repository.

---

### Task 7: Redesign the timeline as horizontal artifact swimlanes

**Files:**
- Modify: `timeline/src/timeline-view.ts`
- Modify: `timeline/src/styles.css`
- Modify: `timeline/tests/timeline-view.test.ts`

**Interfaces:**
- Consumes: the existing `TimelineView`, `Artifact`, `ResolvedTimelineIssue`, and controller contracts without changing their public signatures.
- Produces: a horizontal swimlane view organized by ART 1, ART 2, ART 3, Transversais, and Outras atividades.

- [ ] **Step 1: Write failing classification and rendering tests**

Create fixtures for: one ART 1 task, one ART 2 task, one ART 3 task, one task with ART 1 plus ART 3, and one task without any ART label. Render them with overlaps and assert:

```ts
expect(root.querySelector('[data-lane="ART 1"] [data-issue-iid="101"]')).not.toBeNull();
expect(root.querySelector('[data-lane="ART 2"] [data-issue-iid="102"]')).not.toBeNull();
expect(root.querySelector('[data-lane="ART 3"] [data-issue-iid="103"]')).not.toBeNull();
expect(root.querySelectorAll('[data-issue-iid="104"]')).toHaveLength(1);
expect(root.querySelector('[data-lane="Transversais"] [data-issue-iid="104"]')).not.toBeNull();
expect(root.querySelector('[data-lane="Outras atividades"] [data-issue-iid="105"]')).not.toBeNull();
```

Assert that task titles, assignees and non-ART labels are inside the bars, that no separate metadata table exists, that bar grid columns continue to use `startOffset` and `spanDays`, and that overlapping bars in the same lane receive different `data-stack-row` values.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- timeline-view.test.ts`

Expected: FAIL because the current view renders one metadata row per issue instead of artifact swimlanes.

- [ ] **Step 3: Implement pure lane classification and overlap stacking**

Inside `timeline-view.ts`, add internal helpers:

```ts
type LaneId = ArtifactCode | "Transversais" | "Outras atividades";
type LaneItem = { issue: ResolvedTimelineIssue; stackRow: number };

function classifyLane(issue: ResolvedTimelineIssue): LaneId;
function stackLaneIssues(issues: ResolvedTimelineIssue[]): LaneItem[];
```

`classifyLane` must inspect only exact ART labels. A single ART label selects that ART lane, two or three select **Transversais**, and none selects **Outras atividades**. `stackLaneIssues` must sort by `startOffset`, then assign the lowest row whose previous issue ends before the new issue starts; an issue ending on a day conflicts with another starting on that same day.

- [ ] **Step 4: Render the selected swimlane design**

Render one named section per non-empty lane in this order: ART 1, ART 2, ART 3, Transversais, Outras atividades. ART lane headers must be buttons that open their artifact description. Each activity must be a single button placed on the day grid using `grid-column: startOffset + 1 / span spanDays` and a `grid-row` derived from `stackRow`. Put title, all assignee names, and non-ART labels inside the bar. Keep ART labels as accessible text in `aria-label` and show all of them on Transversais.

Preserve issue opening, artifact detail, loading/error/empty states, last update, focus lifecycle, and all existing callbacks.

- [ ] **Step 5: Replace table-like styles with timeline structure**

Use a sticky 120px lane header plus a horizontally scrollable day canvas with at least 72px per day. Keep the date ruler sticky at the top, use subtle vertical day guides, and show the current day as one accent guide. Bars use the artifact color and occupy their true duration. Do not render a separate title/assignee column or one full-width row per task.

Below 900px, reduce lane-header width to 92px while preserving horizontal scrolling and readable bar content. Continue to scope every selector under `#g05-timeline-root` and respect reduced motion.

- [ ] **Step 6: Verify the redesign**

Run: `npm test -- timeline-view.test.ts && npm test && npm run typecheck && npm run build`

Expected: all tests pass, with the artifact swimlane assertions protecting the chosen design.

- [ ] **Step 7: Commit**

```bash
git add timeline/src/timeline-view.ts timeline/src/styles.css timeline/tests/timeline-view.test.ts
git commit -m "feat: organize timeline by artifact lanes"
```
