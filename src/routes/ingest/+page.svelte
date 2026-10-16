<script lang="ts">
	import JobPanel from '$lib/JobPanel.svelte';
	let jobId = $state<string | null>(null);
	let busy = $state(false);
	let failure = $state('');
	async function start() {
		busy = true;
		failure = '';
		try {
			const res = await fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ingest' }) });
			if (!res.ok) throw new Error(await res.text());
			jobId = (await res.json()).id;
		} catch (err) { failure = String(err); }
		finally { busy = false; }
	}
</script>

<section class="hero stack-tight">
	<h1><mark>Ingest</mark> clips.</h1>
	<p class="muted">Process new talking-head videos from the engine's configured Downloads folder. This can take a while.</p>
	<p class="muted">Ingest also refreshes the <a href="/">Library</a> and builds a <a href="/review">speaker review batch</a> for new clips.</p>
</section>
<section class="split">
	<div class="stack">
		<button type="button" class="btn-primary" onclick={start} disabled={busy || !!jobId}>{busy ? 'Starting…' : 'Start ingest'}</button>
		{#if failure}<p role="alert">{failure}</p>{/if}
	</div>
	<JobPanel {jobId} />
</section>
