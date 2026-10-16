<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import JobPanel from '$lib/JobPanel.svelte';
	import PersonGrid, { type Person } from '../film/PersonGrid.svelte';

	let sentence = $state('');
	let captions = $state(true);
	let draft = $state(false);
	let cast = $state<string[]>([]);
	let people = $state<Person[]>([]);
	let names = $state<Record<string, string[]>>({});
	let picker: HTMLDialogElement | null = $state(null);
	let submitting = $state(false);
	let failure = $state('');

	const jobId = $derived($page.url.searchParams.get('job'));

	onMount(async () => {
		try {
			const res = await fetch('/api/engine/people');
			if (!res.ok) throw new Error(await res.text());
			const data = await res.json();
			people = data.people ?? [];
			names = data.names ?? {};
		} catch (err) {
			failure = `Could not load the cast picker: ${err instanceof Error ? err.message : String(err)}`;
		}
	});

	function chooseCast(value: string) {
		cast = [value];
		picker?.close();
	}

	function clearCast() {
		cast = [];
	}

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

		<div class="field">
			<span class="caps">Cast restriction</span>
			<div class="row">
				{#if cast.length}
					<span class="tag">{cast[0]}</span>
					<button type="button" class="btn-ghost btn-small" onclick={clearCast}>Clear cast</button>
				{:else}
					<span class="muted">Automatic casting</span>
				{/if}
				<button type="button" class="btn-ghost btn-small" onclick={() => picker?.showModal()}>
					Choose person or group
				</button>
			</div>
			<div class="help">Optional. Restrict the engine to one person or a named group.</div>
		</div>

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

<dialog bind:this={picker} class="person-dialog">
	<div class="row" style="justify-content: space-between;">
		<h3>Choose cast</h3>
		<button type="button" class="btn-ghost btn-small" onclick={() => picker?.close()}>Close</button>
	</div>
	{#if people.length}
		<PersonGrid {people} {names} onSelect={chooseCast} />
	{:else}
		<p class="help">No engine people are available yet.</p>
	{/if}
</dialog>

<style>
	.person-dialog {
		background: var(--bg);
		color: var(--ink);
		border: 2px solid var(--ink);
		width: min(90vw, 880px);
		max-height: 85vh;
		overflow: auto;
	}
</style>
