<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import type { BatchSummary, ReviewCard, ReviewItem, Verdict } from '$lib/server/review';

	const VERDICTS: { value: Verdict; label: string }[] = [
		{ value: 'speaking', label: 'Speaking' },
		{ value: 'voiceover', label: 'Voice-over' },
		{ value: 'mixed', label: 'Mixed' },
	];

	let batches = $state<BatchSummary[]>([]);
	let batch = $state('');
	let cards = $state<ReviewCard[]>([]);
	let savedAt = $state<string | null>(null);
	// Only touched items get a verdict; untouched ones keep the detector's call, as in the standalone page.
	let verdicts = new SvelteMap<string, Verdict>();
	let dirty = $state(false);
	// Bumped on every edit, so a save only clears `dirty` if nothing changed while it was in flight.
	let revision = 0;
	let saving = $state(false);
	let failure = $state('');
	let message = $state('');

	let total = $derived(cards.reduce((n, card) => n + card.items.length, 0));
	let flagged = $derived([...verdicts.values()].filter((v) => v !== 'speaking').length);

	const key = (item: ReviewItem) => `${item.clip}:${item.seg}`;

	async function loadBatch(name: string) {
		failure = '';
		message = '';
		const res = await fetch(`/api/review/${encodeURIComponent(name)}`);
		if (!res.ok) { failure = await errorText(res); return; }
		const data = await res.json();
		batch = name;
		cards = data.cards;
		savedAt = data.saved;
		verdicts.clear();
		for (const d of data.decisions) verdicts.set(`${d.clip}:${d.seg}`, d.verdict);
		dirty = false;
	}

	onMount(async () => {
		const res = await fetch('/api/review');
		if (!res.ok) { failure = await errorText(res); return; }
		batches = (await res.json()).batches;
		const wanted = $page.url.searchParams.get('batch');
		const first = batches.find((b) => b.batch === wanted)?.batch ?? batches[0]?.batch;
		if (first) await loadBatch(first);
	});

	async function choose(name: string) {
		if (name === batch) return;
		if (dirty && !confirmDiscard()) return;
		await goto(`?batch=${encodeURIComponent(name)}`, { replaceState: true, noScroll: true, keepFocus: true });
		await loadBatch(name);
	}

	function confirmDiscard() {
		return window.confirm('Discard unsaved review changes?');
	}

	function set(item: ReviewItem, verdict: Verdict) {
		if (verdicts.get(key(item)) === verdict) return;
		verdicts.set(key(item), verdict);
		revision++;
		dirty = true;
	}

	async function save() {
		saving = true;
		message = '';
		const sent = revision;
		try {
			const res = await fetch(`/api/review/${encodeURIComponent(batch)}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ verdicts: [...verdicts].map(([k, verdict]) => {
					const at = k.lastIndexOf(':');
					return { clip: k.slice(0, at), seg: Number(k.slice(at + 1)), verdict };
				}) }),
			});
			if (!res.ok) throw new Error(await errorText(res));
			const data = await res.json();
			savedAt = data.saved;
			dirty = revision !== sent;
			batches = batches.map((b) => (b.batch === batch ? { ...b, decided: data.decided, saved: data.saved } : b));
			message = `Saved ${data.decided} decisions. They take effect when the engine next rebuilds the word bank and buckets.`;
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function errorText(res: Response) {
		const text = await res.text();
		try { return JSON.parse(text).message ?? text; } catch { return text; }
	}

	function mediaUrl(src: string) {
		return `/api/engine-media/review/${encodeURIComponent(batch)}/${src.split('/').map(encodeURIComponent).join('/')}`;
	}

	function beforeUnload(event: BeforeUnloadEvent) {
		if (dirty) event.preventDefault();
	}
</script>

<svelte:window onbeforeunload={beforeUnload} />

<section class="hero stack-tight">
	<h1><mark>Review</mark></h1>
	<p class="muted">
		Each clip plays one segment the detector counted as spoken by the face on screen; the yellow box is the face it
		picked. Everything counts as <strong>Speaking</strong> unless you mark it: <strong>Voice-over</strong> means the voice
		isn't that face (narration, an interviewer, someone off screen), <strong>Mixed</strong> means only part of it is.
		Playing a segment records it as checked.
	</p>
</section>

{#if failure}
	<p role="alert">{failure}</p>
{:else if !batches.length}
	<p class="muted">No review batches yet. The engine builds one per ingest under <code>review/&lt;batch&gt;/</code>.</p>
{:else}
	<section class="row" aria-label="Review batch">
		{#each batches as b (b.batch)}
			<button type="button" class={b.batch === batch ? 'btn-small' : 'btn-ghost btn-small'} aria-pressed={b.batch === batch} onclick={() => choose(b.batch)}>
				{b.batch} · {b.decided}/{b.items}
			</button>
		{/each}
	</section>

	{#each cards as card (card.clip)}
		<section class="clip stack-tight">
			<hr class="rule" />
			<h3>{card.clip} · {card.name.replace(/\.mp4$/, '')}</h3>
			<div class="row">
				<span class="muted">{Math.round(card.off * 100)}% of its speech is off screen · {Math.round(card.border * 100)}% of on-screen words are borderline</span>
				<button type="button" class="btn-ghost btn-small" onclick={() => card.items.forEach((item) => set(item, 'voiceover'))}>Mark whole clip voice-over</button>
			</div>
			<div class="review-grid">
				{#each card.items as item (key(item))}
					{@const verdict = verdicts.get(key(item))}
					<article class="review-card" class:is-flagged={verdict && verdict !== 'speaking'}>
						<!-- svelte-ignore a11y_media_has_caption -->
						<video controls preload="metadata" src={mediaUrl(item.src)} onplay={() => { if (!verdict) set(item, 'speaking'); }}></video>
						<p class="review-text">{item.text}</p>
						<p class="review-meta">
							<span class="pip" class:pip-filled={verdict} title={verdict ? 'Checked' : 'Not checked'}></span>
							{item.start.toFixed(2)}–{item.end.toFixed(2)} s · speaker score {item.score}
						</p>
						<div class="verdicts" role="group" aria-label="Verdict">
							{#each VERDICTS as v}
								<button type="button" class="btn-small" class:is-on={(verdict ?? 'speaking') === v.value} class:is-default={!verdict} aria-pressed={verdict === v.value} onclick={() => set(item, v.value)}>{v.label}</button>
							{/each}
						</div>
					</article>
				{/each}
			</div>
		</section>
	{/each}

	<section class="toolbar stack-tight" aria-label="Save review">
		<div class="row">
			<span class="caps">{verdicts.size} of {total} checked · {flagged} voice-over or mixed</span>
			<span class="muted">{dirty ? 'Unsaved changes' : savedAt ? `Saved ${new Date(savedAt).toLocaleString()}` : 'Not saved yet'}</span>
			<span class="spacer"></span>
			<button type="button" class="btn-primary btn-small" disabled={saving || !dirty} onclick={save}>Save decisions</button>
		</div>
		{#if message}<p role="status" class="muted">{message}</p>{/if}
	</section>
{/if}

<style>
	.toolbar { position: sticky; bottom: 0; z-index: 5; background: var(--bg); padding-block: 1rem; border-block-start: 1px solid var(--rule); }
	.spacer { flex: 1; }
	.clip { margin-block-start: 1.5rem; }
	.clip h3 { font-size: var(--fs-4); overflow-wrap: anywhere; }
	.review-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.5rem; }
	.review-card { display: grid; gap: 0.5rem; align-content: start; padding: 0.75rem; border: 1px solid var(--rule); }
	.review-card.is-flagged { outline: 4px solid var(--accent); outline-offset: -1px; }
	.review-card video { inline-size: 100%; aspect-ratio: 16 / 9; background: var(--well); display: block; }
	.review-text { font-size: 0.95rem; line-height: 1.35; }
	.review-meta { font-size: var(--fs-small); color: var(--muted); display: flex; gap: 0.5rem; align-items: center; }
	.verdicts { display: grid; grid-template-columns: repeat(3, 1fr); }
	.verdicts button { justify-content: center; background: transparent; color: var(--ink); border: 1.5px solid var(--ink); padding-inline: 0.25rem; font-size: 0.7rem; }
	.verdicts button + button { border-inline-start: 0; }
	.verdicts button.is-on { background: var(--accent); color: var(--on-accent); }
	.verdicts button.is-on.is-default { background: transparent; color: var(--ink); box-shadow: inset 0 -4px 0 var(--accent); }
	.verdicts button:hover:not(:disabled) { background: var(--ink); color: var(--bg); }
</style>
