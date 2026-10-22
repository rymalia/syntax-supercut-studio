<script lang="ts">
	import JobPanel from '$lib/JobPanel.svelte';
	import BucketPicker from '$lib/BucketPicker.svelte';
	import CastPicker from '$lib/CastPicker.svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	let target = $state('yeah');
	let melody = $state('C4 E4 G4 C5 G4 E4 C4');
	let bpm = $state(100);
	let subdivision = $state(1);
	let singleClip = $state(false);
	let noShift = $state(true);
	let submitting = $state(false);
	let buckets: string[] = $state([]);
	let cast = $state<string[]>([]);
	let onscreen = $state(false);

	const jobId = $derived($page.url.searchParams.get('job'));

	async function submit(e: Event) {
		e.preventDefault();
		submitting = true;
		try {
			const body = {
				kind: 'songify',
				target: target.trim(),
				melody: melody.trim(),
				bpm,
				subdivision,
				singleClip,
				noShift,
				buckets,
				cast: cast.length ? cast : null,
				onscreen,
			};
			const res = await fetch('/api/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const { message } = await res.json().catch(() => ({ message: 'error' }));
				alert(`Failed: ${message}`);
				return;
			}
			const { id } = await res.json();
			goto(`/songify?job=${id}`, { keepFocus: true });
		} finally {
			submitting = false;
		}
	}
</script>

<section class="hero">
	<h1>
		<mark>Song</mark>ify.
	</h1>
	<p class="muted">
		Pick clips of a word and arrange them into a melody. Requires
		<code>aubiopitch</code> on your PATH.
	</p>
</section>

<section class="split">
	<form onsubmit={submit} class="stack">
		<h3>Parameters</h3>

		<BucketPicker bind:selected={buckets} />
		<CastPicker bind:cast emptyLabel="Every speaker" hint="Optional. Keep only hits spoken by one person or a named group." />
		<label class="field-check">
			<input type="checkbox" bind:checked={onscreen} />
			On-screen speaker only
		</label>
		<div class="help">Cast and on-screen use the engine's speaker data, so they only work on the talking-heads buckets; hits from other buckets are dropped (see the log).</div>

		<div class="field">
			<label for="target">Target word</label>
			<input id="target" type="text" bind:value={target} required />
			<div class="help">Use a voiced word like "yeah", "oh", "no". "Css" won't work.</div>
		</div>

		<div class="field">
			<label for="melody">Melody</label>
			<input
				id="melody"
				type="text"
				bind:value={melody}
				placeholder="C4 E4 G4 C5 G4 E4 C4"
				required
			/>
			<div class="help">
				Space- or comma-separated notes. Sharps: <code>C#4</code>. Flats:
				<code>Db4</code>.
			</div>
		</div>

		<div class="row" style="gap: 1.5rem;">
			<div class="field" style="min-width: 6rem;">
				<label for="bpm">BPM</label>
				<input id="bpm" type="number" min="40" max="300" bind:value={bpm} />
			</div>
			<div class="field" style="min-width: 9rem;">
				<label for="sub">Subdivision</label>
				<select id="sub" bind:value={subdivision}>
					<option value={2}>Half (2)</option>
					<option value={1}>Quarter (1)</option>
					<option value={0.5}>8th (0.5)</option>
					<option value={0.25}>16th (0.25)</option>
				</select>
			</div>
		</div>

		<label class="field-check">
			<input type="checkbox" bind:checked={singleClip} />
			Single clip mode (one voice, all notes)
		</label>
		<label class="field-check">
			<input type="checkbox" bind:checked={noShift} />
			No shift (use natural pitch of closest match)
		</label>

		<div>
			<button type="submit" class="btn-primary" disabled={submitting}>
				{submitting ? 'Starting…' : 'Build song'}
			</button>
		</div>
	</form>

	<div>
		<JobPanel {jobId} />
	</div>
</section>
