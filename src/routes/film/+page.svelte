<script lang="ts">
	import { onMount } from 'svelte';
	import JobPanel from '$lib/JobPanel.svelte';
	import PersonGrid, { type Person } from './PersonGrid.svelte';

	type Line = { speaker: string; text: string; caption?: string; pause?: number };
	type Film = { title: string; subtitle: string; pause: number; bed: string; bed_db: number; captions: boolean; caption_pos: string; speaker_labels: boolean; cast: Record<string, string[]>; lines: Line[]; [key: string]: unknown };
	type Hit = { person: string; clip_name: string; start: number; end: number; text: string; asd: unknown; final: unknown };
	type Result = Record<string, unknown>;
	type JobView = { job: { kind: string; status: string; result: Result | null } | null; mediaUrl: string | null };
	const blank = (): Film => ({ title: '', subtitle: '', pause: 0.5, bed: 'roomtone', bed_db: -33, captions: true, caption_pos: 'top', speaker_labels: true, cast: {}, lines: [{ speaker: 'SPEAKER', text: '' }] });

	let film = $state<Film>(blank());
	let slug = $state('');
	let films = $state<{ slug: string; title: string }[]>([]);
	let people = $state<Person[]>([]);
	let names = $state<Record<string, string[]>>({});
	let picker: HTMLDialogElement | null = $state(null);
	let pickerSpeaker = $state('');
	let phrase = $state('');
	let hits = $state<Hit[]>([]);
	let checkResult = $state<Result | null>(null);
	let jobId = $state<string | null>(null);
	let jobView = $state<JobView>({ job: null, mediaUrl: null });
	let busy = $state(false);
	let searching = $state(false);
	let message = $state('');
	let failure = $state('');
	let draft = $state(false);
	let speakers = $derived([...new Set(film.lines.map((line) => line.speaker.trim()).filter(Boolean))]);
	let result = $derived(jobView.job?.status === 'done' ? jobView.job.result : null);
	let qa = $derived((result?.qa ?? null) as Result | null);

	function mediaUrl(path: unknown): string | null {
		if (typeof path !== 'string' || !path) return null;
		const name = path.split('/').pop();
		return name ? `/api/engine-media/films/out/${encodeURIComponent(name)}` : null;
	}
	function display(value: unknown): string {
		if (value === null || value === undefined) return '—';
		return typeof value === 'object' ? JSON.stringify(value) : String(value);
	}
	async function api<T>(url: string, init?: RequestInit): Promise<T> {
		const res = await fetch(url, init);
		const data = await res.json().catch(() => null);
		if (!res.ok) throw new Error(data?.message ?? data?.error ?? `${res.status} ${res.statusText}`);
		return data as T;
	}
	async function refreshFilms() {
		films = (await api<{ films: { slug: string; title: string }[] }>('/api/films')).films;
	}
	async function load(selected: string) {
		failure = ''; message = ''; checkResult = null; jobId = null; jobView = { job: null, mediaUrl: null };
		if (!selected) { slug = ''; film = blank(); return; }
		try {
			const data = await api<Film>(`/api/films/${encodeURIComponent(selected)}`);
			const cast = Array.isArray(data.cast) ? { '*': data.cast } : (data.cast ?? {});
			film = { ...blank(), ...data, cast };
			slug = selected;
		} catch (err) { failure = String(err); }
	}
	onMount(async () => {
		try {
			await refreshFilms();
			const res = await api<{ people: Person[]; names: Record<string, string[]> }>('/api/engine/people');
			people = res.people ?? []; names = res.names ?? {};
			const params = new URLSearchParams(location.search);
			const existing = params.get('slug');
			if (existing) await load(existing);
			const person = params.get('person');
			if (person) { film.cast.SPEAKER = [person]; message = `${person} added to SPEAKER`; }
		} catch (err) { failure = String(err); }
	});
	$effect(() => {
		if (!jobId) return;
		let active = true;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			try {
				const view = await api<JobView>(`/api/jobs/${jobId}`);
				if (!active) return;
				jobView = view;
				if (view.job?.status === 'running') timer = setTimeout(poll, 1000);
			} catch (err) { if (active) { failure = String(err); timer = setTimeout(poll, 2000); } }
		}
		poll();
		return () => { active = false; clearTimeout(timer); };
	});
	function addLine() { film.lines.push({ speaker: speakers[0] ?? 'SPEAKER', text: '' }); }
	function moveLine(index: number, change: number) {
		const target = index + change;
		if (target < 0 || target >= film.lines.length) return;
		const [line] = film.lines.splice(index, 1);
		film.lines.splice(target, 0, line);
	}
	function openPicker(speaker: string) { pickerSpeaker = speaker; picker?.showModal(); }
	function choosePerson(id: string) {
		const current = film.cast[pickerSpeaker] ?? [];
		if (!current.includes(id)) film.cast[pickerSpeaker] = [...current, id];
		picker?.close();
	}
	function removeCast(speaker: string, id: string) { film.cast[speaker] = (film.cast[speaker] ?? []).filter((value) => value !== id); }
	async function save(): Promise<boolean> {
		failure = ''; message = '';
		if (!/^[a-z0-9_-]+$/.test(slug)) { failure = 'Slug must use lowercase letters, numbers, _ or -.'; return false; }
		if (!film.lines.length || film.lines.some((line) => !line.text.trim())) { failure = 'Every line needs text.'; return false; }
		try {
			await api(`/api/films/${encodeURIComponent(slug)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(film) });
			await refreshFilms();
			message = 'Film saved.';
			return true;
		} catch (err) { failure = String(err); return false; }
	}
	async function check() {
		busy = true; checkResult = null;
		try { if (await save()) checkResult = await api<Result>('/api/engine/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug }) }); }
		catch (err) { failure = String(err); }
		finally { busy = false; }
	}
	async function start(kind: 'film-plan' | 'film-render') {
		busy = true; jobId = null; jobView = { job: null, mediaUrl: null };
		try {
			if (!await save()) return;
			jobId = (await api<{ id: string }>('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, slug, draft }) })).id;
		} catch (err) { failure = String(err); }
		finally { busy = false; }
	}
	async function search() {
		if (!phrase.trim()) { hits = []; return; }
		searching = true; failure = '';
		try { hits = (await api<{ hits: Hit[] }>(`/api/engine/grep?q=${encodeURIComponent(phrase.trim())}&limit=50`)).hits ?? []; }
		catch (err) { failure = String(err); }
		finally { searching = false; }
	}
	function addHit(hit: Hit) {
		film.lines.push({ speaker: hit.person, text: phrase.trim() });
		film.cast[hit.person] = [...new Set([...(film.cast[hit.person] ?? []), hit.person])];
		message = `Added line for ${hit.person}.`;
	}
</script>

<section class="hero stack-tight">
	<h1><mark>Film</mark> studio.</h1>
	<p class="muted">Write dialogue, choose a cast, check buildability, then plan and render.</p>
</section>

<div class="row">
	<div class="field" style="min-width: 16rem; flex: 1;">
		<label for="existing-film">Load film</label>
		<select id="existing-film" value={slug} onchange={(event) => load(event.currentTarget.value)}>
			<option value="">New film</option>
			{#each films as item}<option value={item.slug}>{item.title} ({item.slug})</option>{/each}
		</select>
	</div>
	<div class="field" style="min-width: 16rem; flex: 1;">
		<label for="film-slug">Filename / slug</label>
		<input id="film-slug" type="text" bind:value={slug} placeholder="my_film" pattern="[a-z0-9_-]+" />
	</div>
</div>
{#if failure}<p role="alert" class="film-alert">{failure}</p>{/if}
{#if message}<p role="status">{message}</p>{/if}

<section class="split film-split">
	<div class="stack">
		<h3>Story & cast</h3>
		<div class="film-fields">
			<div class="field"><label for="film-title">Title</label><input id="film-title" bind:value={film.title} /></div>
			<div class="field"><label for="film-subtitle">Subtitle</label><input id="film-subtitle" bind:value={film.subtitle} /></div>
			<div class="field"><label for="film-pause">Default pause (s)</label><input id="film-pause" type="number" min="0" step="0.1" bind:value={film.pause} /></div>
			<div class="field"><label for="film-bed">Bed (roomtone or file path)</label><input id="film-bed" bind:value={film.bed} /></div>
			<div class="field"><label for="film-bed-db">Bed dB</label><input id="film-bed-db" type="number" step="1" bind:value={film.bed_db} /></div>
			<div class="field"><label for="film-caption-pos">Caption position</label><select id="film-caption-pos" bind:value={film.caption_pos}><option value="top">Top</option><option value="bottom">Bottom</option></select></div>
		</div>
		<div class="row">
			<label class="field-check"><input type="checkbox" bind:checked={film.captions} /> Captions</label>
			<label class="field-check"><input type="checkbox" bind:checked={film.speaker_labels} /> Speaker labels</label>
		</div>
		<div class="row" style="justify-content: space-between;"><h4>Lines</h4><button type="button" class="btn-ghost btn-small" onclick={addLine}>Add line</button></div>
		<div class="film-table-scroll"><table>
			<thead><tr><th>#</th><th>Speaker</th><th>Text</th><th>Caption override</th><th>Pause</th><th>Order</th></tr></thead>
			<tbody>{#each film.lines as line, index}
				<tr>
					<td>{index + 1}</td>
					<td><input aria-label={`Speaker for line ${index + 1}`} bind:value={line.speaker} /></td>
					<td><textarea aria-label={`Text for line ${index + 1}`} rows="2" bind:value={line.text}></textarea></td>
					<td><input aria-label={`Caption for line ${index + 1}`} bind:value={line.caption} placeholder="Optional" /></td>
					<td><input aria-label={`Pause for line ${index + 1}`} type="number" min="0" step="0.1" bind:value={line.pause} placeholder="Default" /></td>
					<td><div class="row" style="gap: .3rem;"><button type="button" class="btn-ghost btn-small" aria-label={`Move line ${index + 1} up`} disabled={index === 0} onclick={() => moveLine(index, -1)}>↑</button><button type="button" class="btn-ghost btn-small" aria-label={`Move line ${index + 1} down`} disabled={index === film.lines.length - 1} onclick={() => moveLine(index, 1)}>↓</button><button type="button" class="btn-ghost btn-small" aria-label={`Remove line ${index + 1}`} disabled={film.lines.length === 1} onclick={() => film.lines.splice(index, 1)}>×</button></div></td>
				</tr>
			{/each}</tbody>
		</table></div>
		<div class="stack-tight"><h4>Cast by speaker</h4>
			{#each speakers as speaker}
				<div class="row"><strong>{speaker}</strong>
					{#each film.cast[speaker] ?? [] as id}<button type="button" class="btn-ghost btn-small" onclick={() => removeCast(speaker, id)} title="Remove from cast">{id} ×</button>{/each}
					<button type="button" class="btn-small" onclick={() => openPicker(speaker)}>Choose person</button>
				</div>
			{/each}
		</div>
		<div class="row">
			<button type="button" class="btn-primary" onclick={() => save()} disabled={busy}>Save</button>
			<button type="button" class="btn-ghost" onclick={check} disabled={busy}>Check</button>
			<button type="button" class="btn-ghost" onclick={() => start('film-plan')} disabled={busy}>Plan</button>
			<button type="button" onclick={() => start('film-render')} disabled={busy}>Render</button>
		</div>
		<label class="field-check"><input type="checkbox" bind:checked={draft} /> Draft render</label>
		{#if checkResult}
			<section class="stack-tight"><h4>Buildability</h4>
				<p><span class="pip" class:pip-filled={(checkResult.film as Result | undefined)?.ok === true}></span> Whole film: {display((checkResult.film as Result | undefined)?.ok)} {display((checkResult.film as Result | undefined)?.why)}</p>
				<p class="help">Each take needs at least 2 words and 0.45 seconds; a one-word line needs a complete source utterance. The engine also checks on-screen presence, loudness, shot continuity, and one person per speaker.</p>
				<table><thead><tr><th>Line</th><th>Status</th><th>Reason / takes</th></tr></thead><tbody>
					{#each (checkResult.lines as Result[] ?? []) as item}<tr><td>{display(item.line)} · {display(item.speaker)}</td><td><span class="pip" class:pip-filled={item.ok === true}></span> {item.ok ? 'OK' : 'No'}</td><td>{display(item.why ?? item.takes)}</td></tr>{/each}
				</tbody></table>
			</section>
		{/if}
	</div>

	<div class="stack">
		<h3>Find a phrase</h3>
		<form class="row" onsubmit={(event) => { event.preventDefault(); search(); }}>
			<input type="search" bind:value={phrase} placeholder="Search the engine's spoken phrases" style="flex: 1;" />
			<button type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
		</form>
		{#if hits.length}<div class="film-table-scroll"><table><thead><tr><th>Person / clip</th><th>Time</th><th>Text</th><th>ASD</th><th>Final</th><th></th></tr></thead><tbody>
			{#each hits as hit}<tr><td>{hit.person}<br /><span class="muted">{hit.clip_name}</span></td><td>{Number(hit.start).toFixed(1)}–{Number(hit.end).toFixed(1)}</td><td>{hit.text}</td><td>{display(hit.asd)}</td><td>{display(hit.final)}</td><td><button type="button" class="btn-small" onclick={() => addHit(hit)}>Add as line</button></td></tr>{/each}
		</tbody></table></div>{/if}
		<JobPanel {jobId} />
		{#if result && jobView.job?.kind === 'film-plan'}
			<section class="stack-tight"><h4>Plan</h4><p>{display(result.lines)} lines · {display(result.takes_per_line)} takes per line · {display(result.speech_seconds)} speech seconds</p>
				{#if mediaUrl(result.sheet)}<a href={mediaUrl(result.sheet) ?? undefined} target="_blank" rel="noreferrer"><img class="film-sheet" src={mediaUrl(result.sheet) ?? undefined} alt="Film plan contact sheet" /></a>{/if}
				<div class="film-table-scroll"><table><thead><tr><th>Take</th><th>Person</th><th>Clip</th><th>In–out</th><th>Said</th><th>ASD</th></tr></thead><tbody>
					{#each (result.snippets as Result[] ?? []) as take, index}<tr><td>{index + 1}</td><td>{display(take.person)}</td><td>{display(take.clip)}</td><td>{display(take.in)}–{display(take.out)}</td><td>{display(take.said)}</td><td>{display(take.asd)}</td></tr>{/each}
				</tbody></table></div>
			</section>
		{/if}
		{#if qa}
			<section class="stack-tight"><h4>Quality check</h4>
				<p>{display(qa.heard)}/{display(qa.total)} heard · gate {display(qa.gate)} · ghosts {display(qa.ghosts)}</p>
				<p>Missed: {display(qa.missed)}</p>
				<p>Acoustic: {display(qa.acoustic)}</p>
				{#each (qa.sheets as string[] ?? []) as sheet}{#if mediaUrl(sheet)}<a href={mediaUrl(sheet) ?? undefined} target="_blank" rel="noreferrer"><img class="film-sheet" src={mediaUrl(sheet) ?? undefined} alt="QA contact sheet" /></a>{/if}{/each}
			</section>
		{/if}
	</div>
</section>

<dialog bind:this={picker} class="person-dialog">
	<div class="row" style="justify-content: space-between;"><h3>Choose for {pickerSpeaker}</h3><button type="button" class="btn-ghost btn-small" onclick={() => picker?.close()}>Close</button></div>
	<PersonGrid {people} {names} onSelect={choosePerson} />
</dialog>

<style>
	.film-split { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); }
	.film-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 1rem; }
	.film-table-scroll { overflow-x: auto; }
	.film-table-scroll input { min-width: 7rem; }
	.film-table-scroll textarea { min-width: 15rem; }
	.film-sheet { max-width: 100%; height: auto; border: 1px solid var(--ink); }
	.film-alert { border: 2px solid var(--ink); padding: 1rem; }
	.person-dialog { background: var(--bg); color: var(--ink); border: 2px solid var(--ink); width: min(90vw, 880px); max-height: 85vh; overflow: auto; }
	.person-dialog::backdrop { background: #0009; }
	@media (max-width: 1100px) { .film-split { grid-template-columns: 1fr; } }
</style>
