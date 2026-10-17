<script lang="ts">
	import JobPanel from '$lib/JobPanel.svelte';
	import BucketPicker from '$lib/BucketPicker.svelte';
	import RegexTips from '$lib/RegexTips.svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	let mode = $state<'phrase' | 'regex' | 'ai'>('phrase');
	let target = $state('');
	let regexSource = $state('');
	let tile = $state(false);
	let debug = $state(false);
	let dryRun = $state(false);
	let useLimit = $state(true);
	let limit = $state(100);
	let submitting = $state(false);
	let buckets: string[] = $state([]);

	// AI mode state
	let aiPrompt = $state('');
	let aiBusy = $state(false);
	let aiError = $state<string | null>(null);
	let aiRegex = $state('');
	let aiExplanation = $state('');
	let aiApproved = $state(false);

	const jobId = $derived($page.url.searchParams.get('job'));

	async function generateRegex() {
		if (!aiPrompt.trim()) return;
		aiBusy = true;
		aiError = null;
		aiApproved = false;
		try {
			const res = await fetch('/api/regex-suggest', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: aiPrompt }),
			});
			if (!res.ok) {
				const { message } = await res.json().catch(() => ({ message: 'error' }));
				aiError = message;
				return;
			}
			const data = await res.json();
			aiRegex = data.regex;
			aiExplanation = data.explanation;
		} catch (err) {
			aiError = err instanceof Error ? err.message : String(err);
		} finally {
			aiBusy = false;
		}
	}

	async function submit(e: Event) {
		e.preventDefault();

		// In AI mode, require explicit approval before we fire the job.
		if (mode === 'ai' && !aiApproved) return;

		submitting = true;
		try {
			const body: Record<string, unknown> = {
				kind: 'supercut',
				tile,
				debug,
				dryRun,
				limit: useLimit ? limit : null,
				buckets,
			};
			if (mode === 'phrase') body.target = target.trim();
			else if (mode === 'regex') body.regexSource = regexSource.trim();
			else body.regexSource = aiRegex.trim();

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
			goto(`/supercut?job=${id}`, { keepFocus: true });
		} finally {
			submitting = false;
		}
	}

	function copyToRegexMode() {
		regexSource = aiRegex;
		mode = 'regex';
	}
</script>

<section class="hero">
	<h1><mark>Super</mark>cut.</h1>
	<p class="muted">Every time a word or phrase is said, stitched together.</p>
</section>

<section class="split">
	<form onsubmit={submit} class="stack">
		<h3>Parameters</h3>

		<BucketPicker bind:selected={buckets} />

		<div class="row" style="gap: 2rem;">
			<label class="field-check">
				<input type="radio" name="mode" value="phrase" bind:group={mode} />
				Phrase
			</label>
			<label class="field-check">
				<input type="radio" name="mode" value="regex" bind:group={mode} />
				Regex
			</label>
			<label class="field-check">
				<input type="radio" name="mode" value="ai" bind:group={mode} />
				AI (plain English)
			</label>
		</div>

		{#if mode === 'phrase'}
			<div class="field">
				<label for="target">Word or phrase</label>
				<input id="target" type="text" placeholder="e.g. yeah" bind:value={target} required />
				<div class="help">
					Matches every occurrence across all transcripts. Ignores case and
					punctuation, except apostrophes: <code>don't</code> won't match
					<code>dont</code>. Hyphenated words count as one word
					(<code>mm-hmm</code>). Multi-word phrases supported.
				</div>
			</div>
		{:else if mode === 'regex'}
			<div class="field">
				<label for="regex">Regex</label>
				<input
					id="regex"
					type="text"
					placeholder={'e.g. \\b(ooh|ahh|wow)\\b'}
					bind:value={regexSource}
					required
				/>
				<div class="help">
					Runs against the transcript text with words joined by single spaces.
					Punctuation stays attached to its word (<code>know,</code>), so
					<code>you know</code> misses <code>you, know</code>. A match clips every
					word it touches, even partly: <code>\bit\b</code> also hits
					<code>it's</code> (use <code>\bit\b(?!')</code> to skip it). The
					<code>g</code> and <code>i</code> flags are added automatically.
				</div>
				<div>
					<RegexTips onUse={(pattern) => (regexSource = pattern)} />
				</div>
			</div>
		{:else}
			<div class="field">
				<label for="ai-prompt">Describe what you want to find</label>
				<textarea
					id="ai-prompt"
					rows="4"
					placeholder='e.g. every way someone says they got sick, went to the hospital, got hurt, etc.'
					bind:value={aiPrompt}
				></textarea>
				<div class="help">
					Grok will suggest a regex. You'll see it before running.
				</div>
			</div>

			<div>
				<button type="button" class="btn-ghost" onclick={generateRegex} disabled={aiBusy || !aiPrompt.trim()}>
					{aiBusy ? 'Thinking…' : 'Generate regex'}
				</button>
			</div>

			{#if aiError}
				<div style="padding: 1rem; border: 2px solid var(--ink);">
					<strong class="caps">AI error</strong>
					<div style="font-family: var(--font-mono); margin-block-start: 0.5rem;">
						{aiError}
					</div>
				</div>
			{/if}

			{#if aiRegex}
				<div class="field">
					<label for="ai-regex">Suggested regex (edit if you like)</label>
					<input id="ai-regex" type="text" bind:value={aiRegex} />
					{#if aiExplanation}
						<div class="help" style="margin-block-start: 0.5rem;">
							<strong>What it matches:</strong>
							{aiExplanation}
						</div>
					{/if}
				</div>

				<label class="field-check">
					<input type="checkbox" bind:checked={aiApproved} />
					I've reviewed the regex and want to run it
				</label>

				<div class="row" style="gap: 0.75rem;">
					<button type="button" class="btn-ghost btn-small" onclick={copyToRegexMode}>
						Move to manual regex mode
					</button>
					<button
						type="button"
						class="btn-ghost btn-small"
						onclick={generateRegex}
						disabled={aiBusy}
					>
						Regenerate
					</button>
				</div>
			{/if}
		{/if}

		<label class="field-check">
			<input type="checkbox" bind:checked={tile} />
			Tile mode (punchline grids every few clips)
		</label>

		<label class="field-check">
			<input type="checkbox" bind:checked={debug} />
			Debug overlay (burn matched text onto frame)
		</label>

		<label class="field-check">
			<input type="checkbox" bind:checked={dryRun} />
			Dry run (count matches + estimate duration, no render)
		</label>

		<div class="field">
			<label class="field-check">
				<input type="checkbox" bind:checked={useLimit} />
				Limit number of segments
			</label>
			{#if useLimit}
				<input type="number" min="1" max="5000" bind:value={limit} style="max-width: 8rem;" />
			{/if}
		</div>

		<div>
			<button
				type="submit"
				class="btn-primary"
				disabled={submitting || (mode === 'ai' && (!aiRegex || !aiApproved))}
			>
				{submitting ? 'Starting…' : dryRun ? 'Dry run' : 'Run supercut'}
			</button>
		</div>
	</form>

	<div>
		<JobPanel {jobId} />
	</div>
</section>
