<script lang="ts">
	import { onMount } from 'svelte';
	import PersonGrid, { type Person } from '../routes/film/PersonGrid.svelte';

	let {
		cast = $bindable<string[]>([]),
		emptyLabel = 'Automatic casting',
		hint = 'Optional. Restrict the engine to one person or a named group.',
	}: { cast?: string[]; emptyLabel?: string; hint?: string } = $props();
	let people = $state<Person[]>([]);
	let names = $state<Record<string, string[]>>({});
	let picker: HTMLDialogElement | null = $state(null);
	let loading = $state(true);
	let failure = $state('');

	onMount(async () => {
		try {
			const res = await fetch('/api/engine/people');
			if (!res.ok) throw new Error(await res.text());
			const data = await res.json();
			people = data.people ?? [];
			names = data.names ?? {};
		} catch (err) {
			failure = `Could not load the cast picker: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			loading = false;
		}
	});

	function chooseCast(value: string) {
		cast = [value];
		picker?.close();
	}

	function clearCast() {
		cast = [];
	}
</script>

<div class="field">
	<span class="caps">Cast restriction</span>
	<div class="row">
		{#if cast.length}
			<span class="tag">{cast[0]}</span>
			<button type="button" class="btn-ghost btn-small" onclick={clearCast}>Clear cast</button>
		{:else}
			<span class="muted">{emptyLabel}</span>
		{/if}
		<button type="button" class="btn-ghost btn-small" onclick={() => picker?.showModal()}>
			Choose person or group
		</button>
	</div>
	<div class="help">{hint}</div>
	{#if failure}<div class="help" role="alert">{failure}</div>{/if}
</div>

<dialog bind:this={picker} class="person-dialog">
	<div class="row" style="justify-content: space-between;">
		<h3>Choose cast</h3>
		<button type="button" class="btn-ghost btn-small" onclick={() => picker?.close()}>Close</button>
	</div>
	{#if loading}
		<p class="help">Loading people…</p>
	{:else if people.length}
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
