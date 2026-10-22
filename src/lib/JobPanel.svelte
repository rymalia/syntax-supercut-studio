<script lang="ts">
	import ExportForResolve from '$lib/ExportForResolve.svelte';

	interface JobState {
		id: string;
		kind: string;
		status: 'running' | 'done' | 'error' | 'cancelled';
		logs: string[];
		error: string | null;
		result: Record<string, unknown> | null;
		startedAt: number;
		finishedAt: number | null;
	}

	interface SentenceResult {
		status?: string;
		check?: {
			lines?: { why?: string }[];
			film?: { why?: string };
		};
	}

	interface TranscribeResult {
		engine?: 'parakeet-mlx' | 'xai';
		fallbackReason?: string;
		byEngine?: { 'parakeet-mlx'?: number; xai?: number };
		completed?: { bucket: string; slug: string; engine?: string; fallbackReason?: string }[];
		failed?: { bucket: string; slug: string; error: string }[];
	}

	function formatDuration(sec: number): string {
		if (!Number.isFinite(sec) || sec <= 0) return '0s';
		const m = Math.floor(sec / 60);
		const s = sec - m * 60;
		if (m === 0) return `${s.toFixed(1)}s`;
		return `${m}m ${s.toFixed(1)}s`;
	}

	let {
		jobId,
	}: {
		jobId: string | null;
	} = $props();

	let cancelling = $state(false);

	async function cancel() {
		if (!jobId) return;
		cancelling = true;
		try {
			await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
		} catch (err) {
			console.error(err);
		} finally {
			// Let the next poll refresh status.
			cancelling = false;
		}
	}

	type PanelState = {
		job: JobState | null;
		mediaUrl: string | null;
		exportTarget?: { bucket: string; file: string } | { plan: string } | null;
	};

	let jobState: PanelState = $state({ job: null, mediaUrl: null });

	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let logEl: HTMLPreElement | null = $state(null);

	async function poll() {
		if (!jobId) return;
		try {
			const res = await fetch(`/api/jobs/${jobId}`);
			if (!res.ok) throw new Error(await res.text());
			const data: PanelState = await res.json();
			jobState = data;
			queueMicrotask(() => {
				if (logEl) logEl.scrollTop = logEl.scrollHeight;
			});
			if (data.job && data.job.status === 'running') {
				pollTimer = setTimeout(poll, 1000);
			}
		} catch (err) {
			console.error(err);
			pollTimer = setTimeout(poll, 2000);
		}
	}

	$effect(() => {
		if (!jobId) {
			jobState = { job: null, mediaUrl: null };
			if (pollTimer) clearTimeout(pollTimer);
			return;
		}
		poll();
		return () => {
			if (pollTimer) clearTimeout(pollTimer);
		};
	});

	function elapsed(start: number, end: number | null): string {
		const ms = (end ?? Date.now()) - start;
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		const rem = s % 60;
		return `${m}m ${rem}s`;
	}
</script>

<div class="panel-title">
	<h3>Output</h3>
</div>

{#if !jobId}
	<div class="logs logs-empty">Submit the form to start a job.</div>
{:else if !jobState.job}
	<div class="logs logs-empty">Loading…</div>
{:else}
	<div class="row" style="justify-content: space-between; margin-block-end: 1rem;">
		<span class="tag" class:tag-accent={jobState.job.status === 'done'}>
			{jobState.job.status}
		</span>
		<div class="row" style="gap: 0.75rem;">
			{#if jobState.job.status === 'running'}
				<button type="button" class="btn-ghost btn-small" onclick={cancel} disabled={cancelling}>
					{cancelling ? 'Cancelling…' : 'Cancel'}
				</button>
			{/if}
			<span class="caps muted">
				{elapsed(jobState.job.startedAt, jobState.job.finishedAt)}
			</span>
		</div>
	</div>

	{#if jobState.job.status === 'done' && jobState.job.kind === 'sentence' && jobState.job.result?.status === 'cannot-build'}
		{@const r = jobState.job.result as SentenceResult}
		{@const lineWhy = r.check?.lines?.[0]?.why}
		{@const filmWhy = r.check?.film?.why}
		<div role="status" style="padding: 1.25rem; border: 2px solid var(--ink);">
			<strong class="caps">Cannot build sentence</strong>
			<!-- The engine's reasons are one line per word; a one-line film repeats the line's reason. -->
			{#if lineWhy}<p style="margin-block-start: 0.75rem; white-space: pre-wrap; font-family: var(--font-mono); font-size: var(--fs-small);">{lineWhy}</p>{/if}
			{#if filmWhy && filmWhy !== lineWhy}<p style="margin-block-start: 0.5rem; white-space: pre-wrap; font-family: var(--font-mono); font-size: var(--fs-small);">{filmWhy}</p>{/if}
			{#if !lineWhy && !filmWhy}<p style="margin-block-start: 0.75rem;">The engine could not find a buildable take.</p>{/if}
			<ul style="margin-block: 1rem 0; padding-inline-start: 1.25rem;">
				<li>Try splitting this into shorter sentences.</li>
				<li>Try another person/group.</li>
				<li>Clear cast restriction and let the engine choose.</li>
			</ul>
		</div>
	{:else if jobState.job.status === 'done' && (jobState.job.kind === 'transcribe-one' || jobState.job.kind === 'transcribe-all') && jobState.job.result}
		{@const r = jobState.job.result as TranscribeResult}
		<div role="status" style="padding: 1.25rem; border: 1.5px solid var(--ink);">
			{#if jobState.job.kind === 'transcribe-one'}
				<div class="row" style="gap: 0.75rem;">
					<span class="caps">Engine</span>
					<span class="engine-badge">{r.engine ?? 'unknown'}</span>
				</div>
				{#if r.fallbackReason}
					<p style="margin-block: 0.75rem 0;">Fallback reason: <span style="font-family: var(--font-mono);">{r.fallbackReason}</span></p>
				{/if}
			{:else}
				<div class="row" style="gap: 2rem; flex-wrap: wrap;">
					<div><div class="caps muted">Parakeet-mlx</div><div style="font-size: var(--fs-2); font-weight: 800;">{r.byEngine?.['parakeet-mlx'] ?? 0}</div></div>
					<div><div class="caps muted">xAI fallback</div><div style="font-size: var(--fs-2); font-weight: 800;">{r.byEngine?.xai ?? 0}</div></div>
					<div><div class="caps muted">Failed</div><div style="font-size: var(--fs-2); font-weight: 800;">{r.failed?.length ?? 0}</div></div>
				</div>
				{#if r.completed?.some((item) => item.fallbackReason)}
					<div style="margin-block-start: 1rem;">
						<div class="caps">Fallbacks</div>
						<ul style="margin-block: 0.5rem 0; padding-inline-start: 1.25rem; font-family: var(--font-mono); font-size: var(--fs-small);">
							{#each r.completed.filter((item) => item.fallbackReason) as item}
								<li>{item.bucket}/{item.slug}: {item.fallbackReason}</li>
							{/each}
						</ul>
					</div>
				{/if}
			{/if}
		</div>
	{:else if jobState.job.status === 'done' && jobState.job.result?.dryRun}
		{@const r = jobState.job.result as {
			totalHits?: number;
			segments?: number;
			tiledSegments?: number;
			estimatedDurationSec?: number;
		}}
		<div
			class="row"
			style="gap: 2.5rem; padding: 1.5rem; border: 1.5px solid var(--ink); flex-wrap: wrap;"
		>
			<div>
				<div class="caps muted">Hits</div>
				<div style="font-size: var(--fs-2); font-weight: 800; line-height: 1;">
					{r.totalHits ?? 0}
				</div>
			</div>
			<div>
				<div class="caps muted">Segments</div>
				<div style="font-size: var(--fs-2); font-weight: 800; line-height: 1;">
					{r.segments ?? 0}
					{#if r.tiledSegments && r.tiledSegments > 0}
						<span class="muted" style="font-size: 1rem; font-weight: 400;">
							({r.tiledSegments} tiled)
						</span>
					{/if}
				</div>
			</div>
			<div>
				<div class="caps muted">Estimated runtime</div>
				<div style="font-size: var(--fs-2); font-weight: 800; line-height: 1;">
					<mark>{formatDuration(r.estimatedDurationSec ?? 0)}</mark>
				</div>
			</div>
		</div>
		<div class="help" style="margin-block-start: 0.75rem;">
			No file was rendered. Uncheck "Dry run" and submit again to generate it.
		</div>
	{:else if jobState.job.status === 'done' && jobState.mediaUrl}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			controls
			src={jobState.mediaUrl}
			style="inline-size: 100%; aspect-ratio: 16/9; background: var(--well);"
		></video>
		<div class="row" style="margin-block-start: 1rem;">
			<a class="btn btn-ghost btn-small" href={jobState.mediaUrl} download>
				Download
			</a>
			<a class="btn btn-small" href={jobState.mediaUrl} target="_blank" rel="noreferrer">
				Open
			</a>
		</div>
		{#if jobState.exportTarget}
			<ExportForResolve target={jobState.exportTarget} />
		{/if}
	{/if}

	<details style="margin-block-start: 1rem;" open={jobState.job.status !== 'done'}>
		<summary class="caps" style="cursor: pointer;">Logs</summary>
		<pre bind:this={logEl} class="logs" style="margin-block-start: 0.75rem;">{#if jobState.job.logs.length === 0}<span class="logs-empty">waiting for output…</span>{:else}{jobState.job.logs.join('\n')}{/if}</pre>
	</details>

	{#if jobState.job.error}
		<div style="margin-block-start: 1rem; padding: 1rem; border: 2px solid var(--ink);">
			<strong class="caps">Error</strong>
			<div style="font-family: var(--font-mono); margin-block-start: 0.5rem;">
				{jobState.job.error}
			</div>
		</div>
	{/if}
{/if}
