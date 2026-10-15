<script lang="ts">
	import { goto } from '$app/navigation';

	export type Person = { id: string; clip: string; clip_name: string; seconds: number; words: number; thumb: string; thumb_index: number };
	let { people, names = {}, onSelect, readOnly = false }: {
		people: Person[];
		names?: Record<string, string[]>;
		onSelect?: (id: string) => void;
		readOnly?: boolean;
	} = $props();
	let search = $state('');
	let matches = $derived(people.filter((person) => `${person.id} ${person.clip_name} ${person.clip}`.toLowerCase().includes(search.toLowerCase())));
	let groups = $derived(Object.entries(names).filter(([name]) => name.toLowerCase().includes(search.toLowerCase())));
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
		<div class="row">
			{#each groups as [name, ids]}
				{#if readOnly}
					<span class="tag">{name} · {ids.length}</span>
				{:else}
					<button type="button" class="btn-ghost btn-small" onclick={() => choose(name)}>{name} · {ids.length}</button>
				{/if}
			{/each}
		</div>
	{/if}
	<div class="person-grid">
		{#each matches as person (person.id)}
			<button type="button" class="person-tile" onclick={() => choose(person.id)} title={person.id}>
				<span class="person-thumb" style={`background-image: url('${thumbUrl(person.thumb)}'); background-position: -${(person.thumb_index % 8) * 160}px -${Math.floor(person.thumb_index / 8) * 160}px;`}></span>
				<strong>{person.id}</strong>
				<span class="person-meta">{person.clip_name}</span>
				<span class="person-meta">{person.words} words · {Number(person.seconds).toFixed(1)}s</span>
			</button>
		{/each}
	</div>
</div>

<style>
	.person-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 1rem; max-height: 32rem; overflow: auto; }
	.person-tile { display: grid; gap: 0.35rem; padding: 0; background: transparent; color: var(--ink); text-transform: none; letter-spacing: normal; text-align: left; min-width: 0; }
	.person-tile:hover { background: transparent; color: var(--ink); }
	.person-tile:hover strong { background: var(--accent); color: var(--on-accent); }
	.person-thumb { display: block; width: 160px; height: 160px; background-repeat: no-repeat; background-color: var(--well); }
	.person-meta { font-size: var(--fs-small); color: var(--muted); overflow-wrap: anywhere; line-height: 1.3; }
</style>
