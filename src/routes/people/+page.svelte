<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import PersonGrid, { type Person } from '../film/PersonGrid.svelte';
	let people = $state<Person[]>([]);
	let names = $state<Record<string, string[]>>({});
	let version = $state('');
	let failure = $state('');
	let selected = new SvelteSet<string>();
	let nameInput = $state('');
	let saving = $state(false);
	let message = $state('');
	let normalized = $derived(nameInput.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));

	async function load() {
		const res = await fetch('/api/engine/people');
		if (!res.ok) throw new Error(await res.text());
		const data = await res.json();
		people = data.people ?? [];
		names = data.names ?? {};
		version = data.names_version ?? '';
	}
	onMount(async () => {
		try { await load(); } catch (err) { failure = String(err); }
	});

	function toggle(id: string) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
	}
	function selectGroup(name: string) {
		selected.clear();
		for (const id of names[name] ?? []) selected.add(id);
		nameInput = name;
	}

	/** Name the selection, or un-name it when `name` is null. */
	async function save(name: string | null) {
		const ids = [...selected];
		saving = true;
		message = '';
		try {
			const res = await fetch('/api/engine/people/names', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ version, ids, name }),
			});
			if (res.status === 409) {
				await load();
				message = 'people.json changed elsewhere, so names were reloaded. Check the selection and save again.';
				return;
			}
			if (!res.ok) {
				const text = await res.text();
				let reason = text;
				try { reason = JSON.parse(text).message ?? text; } catch { /* plain-text error */ }
				throw new Error(reason);
			}
			const data = await res.json();
			names = data.names;
			version = data.names_version;
			// Only drop what was saved; ticks made while saving stay.
			for (const id of ids) selected.delete(id);
			message = name ? `Named ${ids.length} cluster${ids.length === 1 ? '' : 's'} ${name}.` : `Removed the name from ${ids.length} cluster${ids.length === 1 ? '' : 's'}.`;
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<section class="hero stack-tight">
	<h1><mark>People</mark></h1>
	<p class="muted">Browse the engine's on-screen speakers. Select one to start a film with that person in the cast, or tick clusters and give them a name so they can be cast together.</p>
</section>
{#if failure}<p role="alert">{failure}</p>{:else}
	<section class="naming stack-tight" aria-label="Name clusters">
		<form class="row" onsubmit={(event) => { event.preventDefault(); if (normalized) save(normalized); }}>
			<div class="field naming-input">
				<label for="person-name">Name {selected.size} selected</label>
				<input id="person-name" type="text" list="person-names" bind:value={nameInput} placeholder="trevor_noah" autocomplete="off" />
				<datalist id="person-names">{#each Object.keys(names) as name}<option value={name}></option>{/each}</datalist>
			</div>
			<button type="submit" class="btn-primary btn-small" disabled={saving || !selected.size || !normalized}>Save as {normalized || '…'}</button>
			<button type="button" class="btn-ghost btn-small" disabled={saving || !selected.size} onclick={() => save(null)}>Remove name</button>
			<button type="button" class="btn-ghost btn-small" disabled={saving || !selected.size} onclick={() => selected.clear()}>Clear</button>
		</form>
		{#if message}<p role="status" class="muted">{message}</p>{/if}
	</section>
	<PersonGrid {people} {names} readOnly {selected} onToggle={toggle} onGroup={selectGroup} />
{/if}

<style>
	.naming { margin-block-end: 1.5rem; }
	.naming form { align-items: end; }
	.naming-input { flex: 1 1 16rem; }
	.naming-input label { margin: 0; }
</style>
