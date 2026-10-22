<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import JobPanel from '$lib/JobPanel.svelte';
	import CastPicker from '$lib/CastPicker.svelte';

	let sentence = $state('');
	let captions = $state(true);
	let draft = $state(false);
	let cast = $state<string[]>([]);
	let submitting = $state(false);
	let failure = $state('');

	const jobId = $derived($page.url.searchParams.get('job'));

	async function submit(e: Event) {
		e.preventDefault();
		failure = '';
		submitting = true;
		try {
			const res = await fetch('/api/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					kind: 'sentence',
					sentence: sentence.trim(),
					cast: cast.length ? cast : null,
					captions,
					speakerLabels: false,
					draft,
				}),
			});
			if (!res.ok) {
				const { message } = await res.json().catch(() => ({ message: 'error' }));
				throw new Error(message);
			}
			const { id } = await res.json();
			goto(`/sentence?job=${id}`, { keepFocus: true });
		} catch (err) {
			failure = `Failed: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			submitting = false;
		}
	}
</script>

<section class="hero">
	<h1><mark>Sentence</mark> mashup.</h1>
	<p class="muted">Build one coherent monologue line from the talking-heads engine corpus.</p>
</section>
{#if failure}<p role="alert">{failure}</p>{/if}

<section class="split">
	<form onsubmit={submit} class="stack">
		<h3>Parameters</h3>

		<p class="help">Uses the talking-heads engine corpus.</p>

		<div class="field">
			<label for="sentence">Sentence</label>
			<textarea
				id="sentence"
				rows="3"
				placeholder="e.g. i love to code in the cloud"
				bind:value={sentence}
				required
			></textarea>
			<div class="help">
				The engine builds this as one monologue line. If it cannot build, try a shorter sentence.
			</div>
		</div>

		<CastPicker bind:cast />

		<div class="row">
			<label class="field-check"><input type="checkbox" bind:checked={captions} /> Captions</label>
			<label class="field-check"><input type="checkbox" bind:checked={draft} /> Draft render</label>
		</div>

		<div>
			<button type="submit" class="btn-primary" disabled={submitting}>
				{submitting ? 'Starting…' : 'Build sentence'}
			</button>
		</div>
	</form>

	<div>
		<JobPanel {jobId} />
	</div>
</section>
