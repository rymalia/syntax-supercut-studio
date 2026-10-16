<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	export type Person = { id: string; clip: string; clip_name: string; seconds: number; words: number; thumb: string; thumb_index: number };
	let { people, names = {}, onSelect, readOnly = false, selected, onToggle, onGroup }: {
		people: Person[];
		names?: Record<string, string[]>;
		onSelect?: (id: string) => void;
		readOnly?: boolean;
		/** With `onToggle`, each tile gets a checkbox (used by /people for naming). */
		selected?: ReadonlySet<string>;
		onToggle?: (id: string) => void;
		/** In read-only mode, makes the group tags buttons. */
		onGroup?: (name: string) => void;
	} = $props();
	let nameOf = $derived(new Map(Object.entries(names).flatMap(([name, ids]) => ids.map((id) => [id, name] as const))));
	let search = $state('');
	// A name like billy_boy also matches "billy boy".
	let matches = $derived(people.filter((person) => {
		const name = nameOf.get(person.id) ?? '';
		return `${person.id} ${person.clip_name} ${person.clip} ${name} ${name.replaceAll('_', ' ')}`.toLowerCase().includes(search.toLowerCase());
	}));
	let groups = $derived(Object.entries(names).filter(([name]) => `${name} ${name.replaceAll('_', ' ')}`.toLowerCase().includes(search.toLowerCase())));
	let groupsOpen = $state(true);
	onMount(() => {
		try { groupsOpen = localStorage.getItem('people.groupsOpen') !== '0'; } catch { /* storage blocked */ }
	});
	function rememberGroupsOpen(open: boolean) {
		groupsOpen = open;
		try { localStorage.setItem('people.groupsOpen', open ? '1' : '0'); } catch { /* storage blocked */ }
	}
	function choose(id: string) {
		if (readOnly) goto(`/film?person=${encodeURIComponent(id)}`);
		else onSelect?.(id);
	}
	function thumbUrl(path: string) {
		return `/api/engine-media/${path.split('/').map(encodeURIComponent).join('/')}`;
	}
</script>

<div class="stack-tight">
	<label for="people-search">Search people and groups</label>
	<input id="people-search" type="search" bind:value={search} placeholder="Person, clip, or group" />
	{#if groups.length}
		<details open={groupsOpen} ontoggle={(event) => rememberGroupsOpen(event.currentTarget.open)}>
		<summary class="caps">Groups · {groups.length === Object.keys(names).length ? groups.length : `${groups.length} of ${Object.keys(names).length}`}</summary>
		<div class="row groups">
			{#each groups as [name, ids]}
				{#if readOnly && onGroup}
					<button type="button" class="btn-ghost btn-small" onclick={() => onGroup(name)} title={`Select ${name}`}>{name} · {ids.length}</button>
				{:else if readOnly}
					<span class="tag">{name} · {ids.length}</span>
				{:else}
					<button type="button" class="btn-ghost btn-small" onclick={() => choose(name)}>{name} · {ids.length}</button>
				{/if}
			{/each}
		</div>
		</details>
	{/if}
	<div class="person-grid">
		{#each matches as person (person.id)}
			<div class="person-cell" class:is-selected={selected?.has(person.id)}>
				<button type="button" class="person-tile" onclick={() => choose(person.id)} title={person.id}>
					<span class="person-thumb" style={`background-image: url('${thumbUrl(person.thumb)}'); background-position: -${(person.thumb_index % 8) * 160}px -${Math.floor(person.thumb_index / 8) * 160}px;`}></span>
					<strong>{person.id}</strong>
					{#if nameOf.has(person.id)}<span class="person-name">{nameOf.get(person.id)}</span>{/if}
					<span class="person-meta">{person.clip_name}</span>
					<span class="person-meta">{person.words} words · {Number(person.seconds).toFixed(1)}s</span>
				</button>
				{#if onToggle}
					<label class="person-check"><input type="checkbox" checked={selected?.has(person.id) ?? false} onchange={() => onToggle(person.id)} /> Select</label>
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	summary { cursor: pointer; }
	.groups { margin-block-start: 0.75rem; }
	.person-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 1rem; max-height: 32rem; overflow: auto; }
	.person-tile { display: grid; gap: 0.35rem; padding: 0; background: transparent; color: var(--ink); text-transform: none; letter-spacing: normal; text-align: left; min-width: 0; }
	.person-tile:hover { background: transparent; color: var(--ink); }
	.person-tile:hover strong { background: var(--accent); color: var(--on-accent); }
	.person-thumb { display: block; width: 160px; height: 160px; background-repeat: no-repeat; background-color: var(--well); }
	.person-cell { display: grid; gap: 0.35rem; align-content: start; min-width: 0; }
	.person-cell.is-selected .person-thumb { outline: 4px solid var(--accent); outline-offset: -4px; }
	.person-name { font-size: var(--fs-small); font-family: var(--font-mono); overflow-wrap: anywhere; }
	.person-check { display: flex; gap: 0.4rem; align-items: center; margin: 0; cursor: pointer; }
	.person-meta { font-size: var(--fs-small); color: var(--muted); overflow-wrap: anywhere; line-height: 1.3; }
</style>
