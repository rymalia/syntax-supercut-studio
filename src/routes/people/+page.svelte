<script lang="ts">
	import { onMount } from 'svelte';
	import PersonGrid, { type Person } from '../film/PersonGrid.svelte';
	let people = $state<Person[]>([]);
	let names = $state<Record<string, string[]>>({});
	let failure = $state('');
	onMount(async () => {
		try {
			const res = await fetch('/api/engine/people');
			if (!res.ok) throw new Error(await res.text());
			const data = await res.json();
			people = data.people ?? [];
			names = data.names ?? {};
		} catch (err) { failure = String(err); }
	});
</script>

<section class="hero stack-tight">
	<h1><mark>People</mark></h1>
	<p class="muted">Browse the engine's on-screen speakers. Select one to start a film with that person in the cast.</p>
</section>
{#if failure}<p role="alert">{failure}</p>{:else}<PersonGrid {people} {names} readOnly />{/if}
