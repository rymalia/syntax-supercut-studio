<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageData } from './$types';
	import { invalidateAll, goto } from '$app/navigation';

	let { data }: { data: PageData } = $props();
	type ActivityEntry = { ts: string; actor: 'app' | 'desktop' | 'code'; action: string; target: string; result: string };
	let activity = $state<ActivityEntry[]>([]);
	let showAllActivity = $state(false);

	onMount(async () => {
		try {
			const res = await fetch('/api/activity?limit=20');
			if (!res.ok) return;
			const body = await res.json();
			if (Array.isArray(body.entries)) activity = body.entries;
		} catch {
			// Activity is supplementary; the Library remains usable when the log is unavailable.
		}
	});

	let filter = $state('');
	let showOnlyMissing = $state(false);
	let activeBucket = $state<string>('all');

	const buckets = $derived(['all', ...data.groups.map((g) => g.name)]);

	const filteredGroups = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		return data.groups
			.filter((g) => activeBucket === 'all' || g.name === activeBucket)
			.map((g) => ({
				name: g.name,
				rows: g.rows.filter((r) => {
					if (showOnlyMissing && r.hasTranscript) return false;
					if (!q) return true;
					return r.slug.toLowerCase().includes(q) || (r.title?.toLowerCase().includes(q) ?? false);
				}),
			}));
	});

	function formatDuration(sec: number): string {
		if (!sec || sec <= 0) return '—';
		const h = Math.floor(sec / 3600);
		const m = Math.floor((sec % 3600) / 60);
		const s = Math.floor(sec % 60);
		if (h > 0) return `${h}h ${m}m`;
		return `${m}m ${s}s`;
	}

	async function transcribe(bucket: string, slug: string) {
		const res = await fetch('/api/jobs', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ kind: 'transcribe-one', bucket, slug }),
		});
		if (!res.ok) {
			const { message } = await res.json().catch(() => ({ message: 'error' }));
			alert(`Failed: ${message}`);
			return;
		}
		const { id } = await res.json();
		goto(`/transcribe?job=${id}`);
	}

	async function del(bucket: string, slug: string) {
		if (
			!confirm(
				`Delete every file for\n\n  ${bucket}/${slug}\n\n(video, mp3, and transcript)?\nThis can't be undone.`,
			)
		)
			return;
		const res = await fetch(
			`/api/library/${encodeURIComponent(bucket)}/${encodeURIComponent(slug)}`,
			{ method: 'DELETE' },
		);
		if (!res.ok) {
			const { message } = await res.json().catch(() => ({ message: 'error' }));
			alert(`Failed: ${message}`);
			return;
		}
		await invalidateAll();
	}

	const totalHours = $derived(data.totals.totalDurationSec / 3600);

	// Hover preview: a 4-frame strip from /api/thumb, shown after a short delay
	// so sweeping the pointer down the table doesn't request every row.
	const PREVIEW_DELAY_MS = 150;
	const POINTER_GAP = 18;
	let preview = $state<{ bucket: string; slug: string; label: string } | null>(null);
	let previewStatus = $state<'loading' | 'ready' | 'error'>('loading');
	let pointer = $state({ x: 0, y: 0 });
	let popW = $state(0);
	let popH = $state(0);
	let hoverTimer: ReturnType<typeof setTimeout> | null = null;

	function showPreview(e: MouseEvent, row: PageData['groups'][number]['rows'][number]) {
		if (hoverTimer) clearTimeout(hoverTimer);
		pointer = { x: e.clientX, y: e.clientY };
		if (!row.hasVideo) {
			preview = null;
			return;
		}
		hoverTimer = setTimeout(() => {
			if (preview?.bucket !== row.bucket || preview?.slug !== row.slug) previewStatus = 'loading';
			preview = { bucket: row.bucket, slug: row.slug, label: row.title ?? row.slug };
		}, PREVIEW_DELAY_MS);
	}

	// Ignore a late load/error from a previous row's image.
	function setPreviewStatus(e: Event, status: 'ready' | 'error') {
		const key = preview && `/api/thumb/${encodeURIComponent(preview.bucket)}/${encodeURIComponent(preview.slug)}`;
		if (key && (e.currentTarget as HTMLImageElement).src.endsWith(key)) previewStatus = status;
	}

	function hidePreview() {
		if (hoverTimer) clearTimeout(hoverTimer);
		hoverTimer = null;
		preview = null;
	}

	// Keep the popover inside the viewport: right of the pointer, flipping
	// left/above near the edges.
	const popStyle = $derived.by(() => {
		const vw = typeof window === 'undefined' ? 0 : window.innerWidth;
		const vh = typeof window === 'undefined' ? 0 : window.innerHeight;
		let left = pointer.x + POINTER_GAP;
		if (left + popW > vw - 16) left = Math.max(16, pointer.x - POINTER_GAP - popW);
		let top = pointer.y + POINTER_GAP;
		if (top + popH > vh - 16) top = Math.max(16, pointer.y - POINTER_GAP - popH);
		return `left: ${left}px; top: ${top}px;`;
	});
</script>

<section class="hero">
	<h1>
		The <mark>Library</mark>.
	</h1>
	<p class="muted">
		Every video, its <code>.mp3</code> audio, and word-level transcript &mdash; grouped by bucket.
	</p>
</section>

{#if activity.length}
	<section class="stack-tight" aria-label="Recent activity">
		<div class="row" style="justify-content: space-between;">
			<h3>Recent activity</h3>
			{#if activity.length > 5}
				<button type="button" class="btn-ghost btn-small" onclick={() => (showAllActivity = !showAllActivity)}>{showAllActivity ? 'Show latest 5' : `Show all ${activity.length}`}</button>
			{/if}
		</div>
		<div style="overflow-x: auto;">
			<table>
				<thead>
					<tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Result</th></tr>
				</thead>
				<tbody>
					{#each showAllActivity ? activity : activity.slice(0, 5) as entry, i (i)}
						<tr>
							<td class="muted" style="white-space: nowrap;">{new Date(entry.ts).toLocaleString()}</td>
							<td class="caps">{entry.actor}</td>
							<td>{entry.action}</td>
							<td>{entry.target || '—'}</td>
							<td>{entry.result}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

<section class="stack">
	<div class="row" style="gap: 3rem;">
		<div>
			<div class="caps muted">Buckets</div>
			<div style="font-size: var(--fs-2); font-weight: 800; line-height: 1; margin-block-start: 0.35rem;">
				{data.groups.length}
			</div>
		</div>
		<div>
			<div class="caps muted">Videos</div>
			<div style="font-size: var(--fs-2); font-weight: 800; line-height: 1; margin-block-start: 0.35rem;">
				{data.totals.videos}
			</div>
		</div>
		<div>
			<div class="caps muted">Transcribed</div>
			<div style="font-size: var(--fs-2); font-weight: 800; line-height: 1; margin-block-start: 0.35rem;">
				<mark>{data.totals.transcribed}</mark>
			</div>
		</div>
		<div>
			<div class="caps muted">Total words</div>
			<div style="font-size: var(--fs-2); font-weight: 800; line-height: 1; margin-block-start: 0.35rem;">
				{data.totals.totalWords.toLocaleString()}
			</div>
		</div>
		<div>
			<div class="caps muted">Total runtime</div>
			<div style="font-size: var(--fs-2); font-weight: 800; line-height: 1; margin-block-start: 0.35rem;">
				{totalHours.toFixed(1)}h
			</div>
		</div>
	</div>
</section>

<section class="stack">
	<div class="row" style="justify-content: space-between; gap: 1.5rem; flex-wrap: wrap;">
		<div class="row" style="gap: 0.75rem; flex-wrap: wrap;">
			{#each buckets as b (b)}
				<button
					type="button"
					class="btn-small"
					class:btn-primary={activeBucket === b}
					class:btn-ghost={activeBucket !== b}
					onclick={() => (activeBucket = b)}
				>
					{b}
				</button>
			{/each}
		</div>
		<div class="row" style="gap: 1rem;">
			<input
				type="search"
				placeholder="FILTER BY SLUG OR TITLE..."
				bind:value={filter}
				style="max-width: 28rem;"
			/>
			<label class="field-check">
				<input type="checkbox" bind:checked={showOnlyMissing} />
				Only missing transcripts
			</label>
			<button class="btn-small" onclick={() => invalidateAll()}>Refresh</button>
		</div>
	</div>
</section>

{#each filteredGroups as group (group.name)}
	<section class="stack">
		<div class="row" style="justify-content: space-between;">
			<h3>{group.name}</h3>
			<span class="caps muted">{group.rows.length} shown</span>
		</div>

		<table>
			<thead>
				<tr>
					<th>Slug</th>
					<th>Video</th>
					<th>MP3</th>
					<th>Transcript</th>
					<th>Engine</th>
					<th>Words</th>
					<th>Runtime</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each group.rows as row (row.bucket + '::' + row.slug)}
					<tr
						onmouseenter={(e) => showPreview(e, row)}
						onmousemove={(e) => (pointer = { x: e.clientX, y: e.clientY })}
						onmouseleave={hidePreview}
					>
						<td style="max-width: 38rem;">
							<span style="font-weight: 600;">{row.slug}</span>
							{#if row.title}
								<span class="row-title muted">{row.title}</span>
							{/if}
						</td>
						<td>
							<span class="pip" class:pip-filled={row.hasVideo}></span>
							{#if row.videoSizeMB !== null}
								<span class="muted" style="margin-inline-start: 0.5rem; font-size: var(--fs-small);">
									{row.videoSizeMB} MB
								</span>
							{/if}
						</td>
						<td>
							<span class="pip" class:pip-filled={row.hasMp3}></span>
							{#if row.mp3SizeMB !== null}
								<span class="muted" style="margin-inline-start: 0.5rem; font-size: var(--fs-small);">
									{row.mp3SizeMB} MB
								</span>
							{/if}
						</td>
						<td>
							<span class="pip" class:pip-filled={row.hasTranscript}></span>
						</td>
						<td>
							{#if row.transcriptEngine}
								<span class="engine-badge">{row.transcriptEngine}</span>
							{:else}
								<span class="muted">—</span>
							{/if}
						</td>
						<td style="font-variant-numeric: tabular-nums;">
							{row.transcriptWords?.toLocaleString() ?? '—'}
						</td>
						<td style="font-variant-numeric: tabular-nums;">
							{formatDuration(row.transcriptDurationSec ?? 0)}
						</td>
					<td>
						<div class="row" style="gap: 0.5rem; justify-content: flex-end;">
							{#if !row.hasTranscript && (row.hasVideo || row.hasMp3)}
								<button class="btn-small" onclick={() => transcribe(row.bucket, row.slug)}>
									Transcribe
								</button>
							{/if}
							<button
								class="btn-small btn-ghost"
								onclick={() => del(row.bucket, row.slug)}
								title="Delete video, mp3, and transcript"
							>
								Delete
							</button>
						</div>
					</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
{/each}

{#if preview}
	<div
		class="thumb-pop"
		style={popStyle}
		bind:offsetWidth={popW}
		bind:offsetHeight={popH}
		aria-hidden="true"
	>
		<div class="thumb-pop__label">{preview.label}</div>
		<div class="thumb-pop__frame">
			{#key `${preview.bucket}/${preview.slug}`}
				<img
					src={`/api/thumb/${encodeURIComponent(preview.bucket)}/${encodeURIComponent(preview.slug)}`}
					alt=""
					class:is-ready={previewStatus === 'ready'}
					onload={(e) => setPreviewStatus(e, 'ready')}
					onerror={(e) => setPreviewStatus(e, 'error')}
				/>
			{/key}
			{#if previewStatus !== 'ready'}
				<span class="thumb-pop__status">
					{previewStatus === 'error' ? 'No preview' : 'Loading…'}
				</span>
			{/if}
		</div>
	</div>
{/if}
