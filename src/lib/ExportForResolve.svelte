<script lang="ts">
	type Target = { bucket: string; file: string } | { plan: string };
	type ExportFile = { name: string; type: string; text: string };

	let { target }: { target: Target } = $props();

	let busy = $state(false);
	let err = $state<string | null>(null);
	let files = $state<{ name: string; url: string }[]>([]);
	let summary = $state('');
	// Bumped when the target changes, so a late response for the old one is dropped.
	let generation = 0;

	// A new target (another clip or job) drops the previous export's links.
	$effect(() => {
		void JSON.stringify(target);
		return () => {
			generation++;
			busy = false;
			for (const f of files) URL.revokeObjectURL(f.url);
			files = [];
			err = null;
			summary = '';
		};
	});

	async function run() {
		const gen = generation;
		busy = true;
		err = null;
		try {
			const res = await fetch('/api/export', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(target),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.message ?? `Export failed (${res.status})`);
			}
			const data: { files: ExportFile[]; clips?: number; sources?: number; fps?: string } = await res.json();
			if (gen !== generation) return;
			for (const f of files) URL.revokeObjectURL(f.url);
			files = data.files.map((f) => ({
				name: f.name,
				url: URL.createObjectURL(new Blob([f.text], { type: f.type })),
			}));
			summary = `${data.clips ?? '?'} items from ${data.sources ?? '?'} sources at ${data.fps ?? '?'} fps`;
			// Start the timeline download right away; the captions stay a link.
			const a = document.createElement('a');
			a.href = files[0].url;
			a.download = files[0].name;
			a.click();
		} catch (e) {
			if (gen !== generation) return;
			err = e instanceof Error ? e.message : String(e);
		} finally {
			if (gen === generation) busy = false;
		}
	}
</script>

<div class="export">
	<div class="row" style="gap: 0.75rem; flex-wrap: wrap;">
		<button type="button" class="btn-ghost btn-small" onclick={run} disabled={busy}>
			{busy ? 'Exporting…' : 'Export for Resolve'}
		</button>
		{#each files as f (f.url)}
			<a class="btn btn-ghost btn-small" href={f.url} download={f.name}>
				.{f.name.split('.').pop()}
			</a>
		{/each}
	</div>
	{#if summary}
		<p class="help">
			{summary}. In Resolve: File › Import › Timeline… with “Automatically import source clips” on;
			captions via File › Import › Subtitle…. The timeline points at the source files on this Mac.
		</p>
	{/if}
	{#if err}
		<p class="help" style="font-family: var(--font-mono); white-space: pre-wrap;">{err}</p>
	{/if}
</div>

<style>
	.export {
		display: grid;
		gap: 0.5rem;
		margin-block-start: 0.75rem;
	}
	.export p {
		margin: 0;
	}
</style>
