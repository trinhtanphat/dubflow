# Phase 3A Project Dashboard + Durable Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real project dashboard plus durable job history with fail-closed retry and cooperative cancel for dubbing/export jobs.

**Architecture:** Keep the existing D1 `projects`/`jobs` tables as the source of truth. Extend the existing job repository with guarded state transitions, expose list/retry/cancel through the existing Hono project routes, and make both Cloudflare Workflows observe cancellation between expensive stages. On the frontend, add a dashboard shell that lists persisted projects/jobs and hydrates the existing Studio Pro editor without replacing its V2.5 autosave/CAS model.

**Tech Stack:** React 19 + TypeScript + Vite, Hono Worker API, Cloudflare D1, Cloudflare Workflows, Vitest, existing `apiFetch` client and current GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-09-05-dubflow-design.md` — Phase 3 items `project dashboard`, `durable job UX`, and `retry/cancel`.

## Global Constraints

- Preserve the existing Studio Pro V2.5 per-segment optimistic concurrency and 600 ms autosave behavior.
- A retry reuses the existing job row/job ID and increments `retry_count`; it must not create duplicate logical jobs for the same user action.
- Retry is allowed only from `failed`; terminal `completed` and `needs_review` jobs are never restarted through this endpoint.
- Cancel is cooperative: mark the job `cancelled` immediately, then both workflow pipelines must stop before the next expensive step and must not overwrite `cancelled` with `failed`.
- All job reads and mutations remain scoped by project ID + current user authorization.
- Project/job status remains durable in D1; frontend state is only a view of canonical server state.
- Current repository qualification policy overrides the original no-Actions prototype note: exact-head GitHub Actions CI must pass before merge, followed by post-merge `main` CI.
- Production Cloudflare runtime qualification remains separate and must not be claimed while the Containers Edit/Write credential blocker exists.
- No unrelated credits, observability, rate-limit, share-link, or provider-metrics work in this PR; those are separate Phase 3B/3C plans.

---

### Task 1: Durable Job History and Guarded State Transitions

**Files:**
- Modify: `worker/src/db/jobs.ts`
- Modify: `worker/test/jobs.test.ts`

**Interfaces:**
- Extend `DubbingJob` with `retryCount: number`, `createdAt: string`, `updatedAt: string`.
- Add `JobStore.listForProject(projectId: string, userId: string): Promise<DubbingJob[]>`.
- Add `JobStore.markRetrying(projectId: string, jobId: string, userId: string): Promise<DubbingJob>`.
- Add `JobStore.cancel(projectId: string, jobId: string, userId: string): Promise<DubbingJob>`.
- Add `JobStore.isCancelled(projectId: string, jobId: string, userId: string): Promise<boolean>`.
- `markRetrying` succeeds only from `failed`, increments `retry_count`, resets progress to `0`, sets `current_step='retrying'`, and clears stored error fields.
- `cancel` succeeds only from `queued`, `running`, or `retrying`; other states throw `JobStateError('JOB_NOT_CANCELLABLE', ...)`.

- [ ] **Step 1: Write failing repository tests for list ordering and full job shape**

Add a test using a fake D1 row containing `retry_count`, `created_at`, and `updated_at`:

```ts
it('lists authorized project jobs newest first with retry metadata', async () => {
  const repo = new JobRepository(dbReturning([
    {
      id: 'j2', project_id: 'p1', type: 'export', status: 'failed', progress: 0.6,
      current_step: 'rendering', error_code: 'RENDER_FAILED', error_message: 'boom',
      retry_count: 2, created_at: '2026-09-05T12:00:00Z', updated_at: '2026-09-05T12:05:00Z',
    },
  ]));
  await expect(repo.listForProject('p1', 'dev-user')).resolves.toEqual([
    expect.objectContaining({ id: 'j2', retryCount: 2, createdAt: '2026-09-05T12:00:00Z' }),
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run worker/test/jobs.test.ts`

Expected: FAIL because `listForProject` and the new metadata fields do not exist yet.

- [ ] **Step 3: Implement row mapping and authorized history query**

Update `JobRow`, `JOB_COLUMNS`, `fromRow`, and `create()` so all `DubbingJob` values carry `retryCount`, `createdAt`, and `updatedAt`. Implement:

```ts
async listForProject(projectId: string, userId: string): Promise<DubbingJob[]> {
  const result = await this.db.prepare(
    `SELECT ${JOB_COLUMNS}
     FROM jobs j INNER JOIN projects p ON p.id = j.project_id
     WHERE j.project_id = ? AND p.user_id = ?
     ORDER BY j.created_at DESC, j.id DESC`,
  ).bind(projectId, userId).all<JobRow>();
  return (result.results ?? []).map(fromRow);
}
```

For freshly created jobs, use one server-side timestamp value in the INSERT/RETURN representation rather than inventing client time in routes.

- [ ] **Step 4: Write failing guarded retry/cancel tests**

Cover these exact cases:

```ts
await expect(repo.markRetrying('p1', 'failed-job', 'dev-user'))
  .resolves.toMatchObject({ status: 'retrying', progress: 0, retryCount: 2, errorCode: null });

await expect(repo.markRetrying('p1', 'running-job', 'dev-user'))
  .rejects.toMatchObject({ code: 'JOB_NOT_RETRYABLE' });

await expect(repo.cancel('p1', 'running-job', 'dev-user'))
  .resolves.toMatchObject({ status: 'cancelled' });

await expect(repo.cancel('p1', 'completed-job', 'dev-user'))
  .rejects.toMatchObject({ code: 'JOB_NOT_CANCELLABLE' });
```

The fake D1 implementation must report `meta.changes` so guarded UPDATE behavior is exercised rather than bypassed.

- [ ] **Step 5: Run focused tests and verify RED**

Run: `npx vitest run worker/test/jobs.test.ts`

Expected: FAIL because guarded transition methods do not exist.

- [ ] **Step 6: Implement fail-closed guarded transitions**

Use authorization + state in the SQL `WHERE` clause. After UPDATE, if `changes !== 1`, re-read the authorized job and distinguish `JOB_NOT_FOUND`, `JOB_NOT_RETRYABLE`, or `JOB_NOT_CANCELLABLE`. Do not silently succeed on stale/terminal state.

`markRetrying` SQL semantics:

```sql
UPDATE jobs
SET status = 'retrying', progress = 0, current_step = 'retrying',
    error_code = NULL, error_message = NULL,
    retry_count = retry_count + 1, updated_at = datetime('now')
WHERE id = ? AND project_id = ? AND status = 'failed'
  AND EXISTS (SELECT 1 FROM projects p WHERE p.id = jobs.project_id AND p.user_id = ?)
```

`cancel` uses `status IN ('queued','running','retrying')` and sets `current_step='cancelled'` without altering retry count.

- [ ] **Step 7: Run job repository tests GREEN**

Run: `npx vitest run worker/test/jobs.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 8: Commit Task 1**

```bash
git add worker/src/db/jobs.ts worker/test/jobs.test.ts
git commit -m "feat: add durable guarded job state"
```

---

### Task 2: Authorized Job List, Retry, and Cancel Routes

**Files:**
- Modify: `worker/src/routes/jobs.ts`
- Create: `worker/test/job-control-routes.test.ts`
- Modify: `worker/src/env.ts`

**Interfaces:**
- `GET /api/projects/:id/jobs` returns newest-first durable job history.
- `POST /api/projects/:id/jobs/:jobId/retry` retries the same job ID after `markRetrying` succeeds.
- `POST /api/projects/:id/jobs/:jobId/cancel` marks the job cancelled.
- Retry dispatches by `job.type`: `dubbing -> DUBBING_WORKFLOW`, `export -> EXPORT_WORKFLOW`; any other type returns `JOB_TYPE_UNSUPPORTED` without starting a workflow.
- Workflow instance ID format is `retry-${job.id}-${job.retryCount}` after increment, so one retry generation has one deterministic Workflow identity.

- [ ] **Step 1: Write failing route tests**

Use an injected store and workflow binding. Cover:

```ts
expect((await listResponse.json())[0]).toMatchObject({ id: 'j2', retryCount: 1 });
expect(retryResponse.status).toBe(202);
expect(workflowCreates).toEqual([{
  id: 'retry-j1-2',
  params: { projectId: 'p1', userId: 'dev-user', jobId: 'j1' },
}]);
expect(cancelResponse.status).toBe(200);
expect(await cancelResponse.json()).toMatchObject({ status: 'cancelled' });
```

Also verify repository `JOB_NOT_FOUND -> 404`, `JOB_NOT_RETRYABLE -> 409`, `JOB_NOT_CANCELLABLE -> 409`, and unsupported type -> `409`.

- [ ] **Step 2: Run route tests RED**

Run: `npx vitest run worker/test/job-control-routes.test.ts`

Expected: FAIL because list/retry/cancel routes do not exist.

- [ ] **Step 3: Extend route dependency injection and implement endpoints**

Change `createJobRoutes` to accept a dependency object:

```ts
export type JobRouteDeps = {
  makeStore?: (env: Env) => JobStore;
  startWorkflow?: (
    env: Env,
    job: DubbingJob,
    params: { projectId: string; userId: string; jobId: string },
  ) => Promise<{ id: string }>;
};
```

The default dispatcher chooses `env.DUBBING_WORKFLOW` or `env.EXPORT_WORKFLOW` and calls `.create({ id, params })`.

If workflow creation fails after `markRetrying`, call `jobs.fail(job.id, 'WORKFLOW_RETRY_START_FAILED', message)` so the job remains retryable and the failure is durable.

- [ ] **Step 4: Run route tests GREEN**

Run: `npx vitest run worker/test/job-control-routes.test.ts worker/test/jobs.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add worker/src/routes/jobs.ts worker/src/env.ts worker/test/job-control-routes.test.ts
git commit -m "feat: add job retry and cancel API"
```

---

### Task 3: Cooperative Cancellation in Dubbing and Export Pipelines

**Files:**
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/test/dubbing-workflow.test.ts`
- Modify: `worker/test/export-pipeline.test.ts`

**Interfaces:**
- Pipeline job dependencies additionally consume `getForProject(projectId, jobId, userId)`.
- Add a small internal `JobCancelledError`/guard in each pipeline module or one shared helper under `worker/src/workflows/jobCancellation.ts` if both implementations are identical.
- A guard reads canonical job state and throws `JOB_CANCELLED` when status is `cancelled`.
- Catch blocks recognize cancellation, set the project to `cancelled`, do **not** call `jobs.fail`, and return/throw a stable cancellation error rather than converting it to a generic provider failure.

- [ ] **Step 1: Add a RED dubbing cancellation test**

Create a fake job store whose first checkpoint returns `running` and whose next checkpoint returns `cancelled`. Assert an expensive downstream dependency is never called:

```ts
await expect(runDubbingPipeline(params, deps, step)).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
expect(asr.transcribe).not.toHaveBeenCalled();
expect(jobs.fail).not.toHaveBeenCalled();
expect(projectStatuses).toContain('cancelled');
```

- [ ] **Step 2: Add a RED export cancellation test**

Return `cancelled` before voice generation/render and assert voice/media providers are not called and the job is not rewritten as failed.

- [ ] **Step 3: Run both focused suites RED**

Run: `npx vitest run worker/test/dubbing-workflow.test.ts worker/test/export-pipeline.test.ts`

Expected: cancellation cases FAIL before implementation.

- [ ] **Step 4: Implement cancellation checkpoints around expensive boundaries**

For dubbing, check before probe, audio extraction, each ASR chunk, each translation batch, and final completion.

For export, check before per-segment voice generation, timing/render operations, R2 final write, and final completion.

Do not add a check inside a provider call; cancellation takes effect at the next durable boundary.

- [ ] **Step 5: Run both workflow suites GREEN**

Run: `npx vitest run worker/test/dubbing-workflow.test.ts worker/test/export-pipeline.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add worker/src/workflows worker/test/dubbing-workflow.test.ts worker/test/export-pipeline.test.ts
git commit -m "feat: stop workflows on cancelled jobs"
```

---

### Task 4: Frontend Durable Job Client

**Files:**
- Modify: `src/features/projects/jobApi.ts`
- Modify: `src/features/projects/jobApi.test.ts`
- Modify: `src/features/projects/jobPolling.ts`
- Modify: `src/features/projects/jobPolling.test.ts`

**Interfaces:**
- Extend `CloudJob` with `retryCount`, `createdAt`, `updatedAt`.
- Add `listProjectJobs(projectId)`.
- Add `retryProjectJob(projectId, jobId)` returning `{ jobId, workflowId, status: 'retrying' }`.
- Add `cancelProjectJob(projectId, jobId)` returning the canonical `CloudJob`.
- Polling treats `cancelled` as terminal and returns it without throwing a generic failure.

- [ ] **Step 1: Add RED client tests**

```ts
await listProjectJobs('p 1');
expect(fetch).toHaveBeenCalledWith('/api/projects/p%201/jobs', expect.anything());

await retryProjectJob('p1', 'j/1');
expect(request.method).toBe('POST');
expect(request.url).toContain('/api/projects/p1/jobs/j%2F1/retry');

await cancelProjectJob('p1', 'j1');
expect(request.url).toContain('/cancel');
```

- [ ] **Step 2: Run frontend job tests RED**

Run: `npx vitest run src/features/projects/jobApi.test.ts src/features/projects/jobPolling.test.ts`

- [ ] **Step 3: Implement client functions and cancelled terminal polling**

Keep all encoding through `encodeURIComponent` and all transport through the existing `apiFetch` helper.

- [ ] **Step 4: Run frontend job tests GREEN**

Run: `npx vitest run src/features/projects/jobApi.test.ts src/features/projects/jobPolling.test.ts`

- [ ] **Step 5: Commit Task 4**

```bash
git add src/features/projects/jobApi.ts src/features/projects/jobApi.test.ts src/features/projects/jobPolling.ts src/features/projects/jobPolling.test.ts
git commit -m "feat: add durable job client controls"
```

---

### Task 5: Project Dashboard and Studio Navigation

**Files:**
- Create: `src/features/projects/ProjectDashboard.tsx`
- Create: `src/features/projects/ProjectDashboard.test.tsx`
- Create: `src/styles/project-dashboard.css`
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `src/app/StudioTopbar.tsx`
- Modify: `src/app/StudioTopbar.test.tsx`
- Modify: `src/features/projects/projectApi.ts`
- Modify: `src/features/projects/projectApi.test.ts`
- Modify: `worker/src/db/projects.ts`
- Modify: `worker/test/projects.test.ts`
- Modify: `src/main.tsx`

**Interfaces:**
- Extend project DTOs with `createdAt` and `updatedAt`; use D1 timestamps already present in `projects`.
- `ProjectDashboard` props:

```ts
type ProjectDashboardProps = {
  projects: CloudProject[];
  jobsByProject: Record<string, CloudJob[]>;
  loading: boolean;
  error: string;
  onOpenProject(projectId: string): void;
  onRetryJob(projectId: string, jobId: string): void;
  onCancelJob(projectId: string, jobId: string): void;
  onCreateProject(): void;
};
```

- `App` owns view mode `'dashboard' | 'studio'`.
- On initial mount, `App` loads projects and their recent job histories. Opening a project calls existing `loadCloudStudioProject(projectId)`, dispatches `hydrateProject`, then switches to `studio`.
- Creating a new project switches to the existing demo/upload studio; the existing `UploadPanel` remains the creation/upload flow for this PR.
- `StudioTopbar` receives `onOpenDashboard` and exposes one accessible Projects/Dashboard control; it does not reset or bypass unsaved-work protection.

- [ ] **Step 1: Add RED project timestamp mapping tests**

Assert repository/API project objects include existing D1 `created_at`/`updated_at` without schema migration.

- [ ] **Step 2: Run project tests RED**

Run: `npx vitest run worker/test/projects.test.ts src/features/projects/projectApi.test.ts`

Expected: FAIL because timestamp fields are not mapped yet.

- [ ] **Step 3: Implement project timestamp mapping**

Add `created_at` and `updated_at` to `PROJECT_COLUMNS`/`ProjectRow`, map them to `createdAt`/`updatedAt`, and mirror the fields in `CloudProject`.

- [ ] **Step 4: Write RED dashboard component tests**

Cover: empty state, project title/status rendering, failed job error rendering, retry button, cancel button only for `queued|running|retrying`, and opening a project.

Example assertions:

```tsx
expect(screen.getByText('Episode 01')).toBeInTheDocument();
fireEvent.click(screen.getByRole('button', { name: /thử lại/i }));
expect(onRetryJob).toHaveBeenCalledWith('p1', 'j1');
```

- [ ] **Step 5: Run dashboard tests RED**

Run: `npx vitest run src/features/projects/ProjectDashboard.test.tsx src/app/App.test.tsx`

- [ ] **Step 6: Implement dashboard UI and navigation state**

Render compact project cards with title, language pair, project status, updated time, latest job progress/error, retry/cancel actions, and an explicit `Tạo dự án` action. Keep the existing dark workstation visual language; do not redesign Studio Pro in this task.

When `onOpenDashboard` is triggered while V2.5 save state is `dirty`, `saving`, `error`, or `conflict`, keep the browser unsaved-work guard semantics: flush first where possible and do not silently discard a local draft. The easiest safe integration is to expose dashboard navigation only when the shell's derived save state is `saved` or `offline`; otherwise disable it with an accessible explanation.

- [ ] **Step 7: Import dashboard stylesheet from `src/main.tsx`**

Add:

```ts
import './styles/project-dashboard.css';
```

- [ ] **Step 8: Run dashboard/app/topbar suites GREEN**

Run: `npx vitest run src/features/projects/ProjectDashboard.test.tsx src/app/App.test.tsx src/app/StudioTopbar.test.tsx worker/test/projects.test.ts src/features/projects/projectApi.test.ts`

- [ ] **Step 9: Commit Task 5**

```bash
git add src/app src/features/projects src/styles/project-dashboard.css src/main.tsx worker/src/db/projects.ts worker/test/projects.test.ts
git commit -m "feat: add project dashboard and job history"
```

---

### Task 6: Integrated Job Control from Dashboard

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `src/features/projects/ProjectDashboard.tsx`
- Modify: `src/features/projects/ProjectDashboard.test.tsx`

**Interfaces:**
- Retry action updates the canonical dashboard job from the API response, then resumes polling/fetching until a terminal state.
- Cancel action immediately replaces the displayed job with the canonical `cancelled` response.
- Refresh project metadata after terminal job changes so project `failed/cancelled/needs_review/completed` state does not drift from job state.
- No optimistic fake success state; network errors remain visible and the previous canonical job is preserved.

- [ ] **Step 1: Add RED App orchestration tests**

Mock `listProjects`, `listProjectJobs`, `retryProjectJob`, `cancelProjectJob`, and `getProject`. Verify retry/cancel call the right IDs and that API failure renders an error without deleting the existing job card.

- [ ] **Step 2: Run orchestration tests RED**

Run: `npx vitest run src/app/App.test.tsx src/features/projects/ProjectDashboard.test.tsx`

- [ ] **Step 3: Implement dashboard orchestration**

Keep request orchestration in `App` (or a focused `useProjectDashboard` hook if `App.tsx` exceeds roughly 180 lines). Keep `ProjectDashboard` presentational.

- [ ] **Step 4: Run orchestration tests GREEN**

Run: `npx vitest run src/app/App.test.tsx src/features/projects/ProjectDashboard.test.tsx`

- [ ] **Step 5: Commit Task 6**

```bash
git add src/app/App.tsx src/app/App.test.tsx src/features/projects/ProjectDashboard.tsx src/features/projects/ProjectDashboard.test.tsx
git commit -m "feat: wire dashboard job controls"
```

---

### Task 7: Full Qualification, PR, Merge, and Post-Merge Verification

**Files:**
- Verify only unless a qualification failure exposes a real regression.

- [ ] **Step 1: Run complete repository verification**

Run: `npm run verify`

Expected: deploy-config tests, all Vitest suites, and production build pass with zero failures.

- [ ] **Step 2: Run Wrangler dry-run**

Run the same dry-run command used by `.github/workflows/ci.yml`.

Expected: success without production deployment.

- [ ] **Step 3: Push exact head and create a Draft PR against current `main`**

The PR description must state Phase 3A scope, cooperative-cancel semantics, and that credits/observability/rate-limit/share controls are intentionally deferred.

- [ ] **Step 4: Require exact-head CI GREEN**

The exact branch head must pass source/tests/build, Wrangler dry-run, reference screenshot capture, and artifact upload. Do not reuse a CI result from an earlier SHA.

- [ ] **Step 5: Reconcile current `main` without force**

If `main` advanced, merge/reconcile it into the feature branch, preserve both sides contract-aware, and repeat exact-head qualification.

- [ ] **Step 6: Merge by expected head SHA**

Mark ready only after exact-head GREEN, then merge with GitHub expected-head protection so a concurrent branch mutation fails closed.

- [ ] **Step 7: Verify post-merge `main` CI**

Confirm `main` points to the merge commit and the push-triggered CI for that exact merge SHA passes all verification, Wrangler, screenshot, and artifact steps.

- [ ] **Step 8: Record next Phase 3 boundary**

After Phase 3A is merged, continue with separate plans:

1. Phase 3B — credits ledger + provider usage metrics.
2. Phase 3C — observability + rate limits.
3. Phase 3D — share/download controls.

Do not claim production runtime qualification until Cloudflare Containers Edit/Write credentials are qualified.
