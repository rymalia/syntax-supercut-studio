<script lang="ts">
	import JobPanel from '$lib/JobPanel.svelte';
	import BucketPicker from '$lib/BucketPicker.svelte';
	import { page } from '$app/stores';
	import { goto, invalidateAll } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const jobId = $derived($page.url.searchParams.get('job'));

	let submitting = $state(false);
	let buckets: string[] = $state([]);

	async function transcribeOne(bucket: string, slug: string) {
		submitting = true;
		try {
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
			goto(`/transcribe?job=${id}`, { keepFocus: true });
		} finally {
			submitting = false;
		}
	}

	async function transcribeAll() {
		submitting = true;
		try {
			// Re-scan disk before confirming so the count reflects reality, not
			// a stale client-side snapshot from when the page first loaded.
			await invalidateAll();

			const label = buckets.length === 0 ? 'all buckets' : buckets.join(', ');
			const missingInScope = data.missing.filter(
				(m) => buckets.length === 0 || buckets.includes(m.bucket),
			).length;

			if (missingInScope === 0) {
				alert(`Nothing missing in ${label}.`);
				return;
			}
			if (!confirm(`Transcribe ${missingInScope} missing across ${label}?`)) return;

			const res = await fetch('/api/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ kind: 'transcribe-all', buckets }),
			});
			if (!res.ok) {
				const { message } = await res.json().catch(() => ({ message: 'error' }));
				alert(`Failed: ${message}`);
				return;
			}
			const { id } = await res.json();
			goto(`/transcribe?job=${id}`, { keepFocus: true });
		} finally {
			submitting = false;
		}
	}

	// Group missing by bucket for display, respecting the picker so the list
	// matches what "transcribe all missing in scope" will act on.
	interface BucketGroup {
		name: string;
		items: PageData['missing'];
	}
	const grouped: BucketGroup[] = $derived.by(() => {
		const inScope = (m: PageData['missing'][number]) =>
			buckets.length === 0 || buckets.includes(m.bucket);
		const map = new Map<string, PageData['missing']>();
		for (const m of data.missing) {
			if (!inScope(m)) continue;
			if (!map.has(m.bucket)) map.set(m.bucket, []);
			map.get(m.bucket)!.push(m);
		}
		return [...map.entries()].map(([name, items]) => ({ name, items }));
	});

	const missingInScope = $derived(
		data.missing.filter((m) => buckets.length === 0 || buckets.includes(m.bucket)).length,
	);
</script>

<section class="hero">
	<h1>
		<mark>Transcribe</mark>.
	</h1>
	<p class="muted">
		Transcription runs locally by default with parakeet-mlx. If local transcription fails,
		the audio is uploaded to xAI as a fallback. You can also choose xAI explicitly in the
		server environment.
		{data.transcribedCount} transcribed; {data.missing.length} missing across
		{data.buckets.length} bucket{data.buckets.length === 1 ? '' : 's'}.
	</p>
</section>

<section class="split">
	<div class="stack">
		<BucketPicker bind:selected={buckets} help="Empty = every bucket" />

		{#if data.missing.length === 0}
			<p>Nothing to do &mdash; everything has a transcript.</p>
		{:else}
			<div>
				<button
					class="btn-primary"
					onclick={transcribeAll}
					disabled={submitting || missingInScope === 0}
				>
					Transcribe {missingInScope} missing in scope
				</button>
			</div>

			{#each grouped as group (group.name)}
				<div class="stack-tight">
					<h3>{group.name}</h3>
					<table>
						<thead>
							<tr>
								<th>Slug</th>
								<th>Size</th>
								<th>MP3?</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each group.items as m (m.bucket + '::' + m.slug)}
								<tr>
									<td style="max-width: 38rem;">{m.slug}</td>
									<td style="font-variant-numeric: tabular-nums;">{m.sizeMB} MB</td>
									<td>
										<span class="pip" class:pip-filled={m.hasMp3}></span>
									</td>
									<td>
										<button
											class="btn-small"
											onclick={() => transcribeOne(m.bucket, m.slug)}
											disabled={submitting}
										>
											Transcribe
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/each}
		{/if}
	</div>

	<div>
		<JobPanel {jobId} />
	</div>
</section>
