<script lang="ts">
	// "Regex tips" button plus a modal of examples for the supercut regex mode.
	// Every example pattern was checked against the local corpus; "Use" copies
	// one into the regex field.
	let { onUse }: { onUse: (pattern: string) => void } = $props();

	let dialog: HTMLDialogElement | undefined = $state();

	type Example = { pattern: string; finds: string };

	const wholeWords: Example[] = [
		{ pattern: '\\bno\\b', finds: '"no", but not know, not, nothing or nobody' },
		{ pattern: '\\bwork\\b', finds: '"work", but not working or homework' },
	];
	const alternatives: Example[] = [
		{ pattern: '\\b(yeah|yep|yup)\\b', finds: 'yeah, yep, yup' },
		{ pattern: '\\b(um|uh)\\b', finds: 'filler sounds' },
		{ pattern: '\\b(like|kind of|sort of)\\b', finds: 'options can be several words long' },
	];
	const alternativesFixed: Example[] = [
		{ pattern: '\\byour (mom|mam)\\b', finds: '"your mom" or "your mam", and nothing else' },
	];
	const optional: Example[] = [
		{ pattern: '\\b(i|we) loved?\\b', finds: 'I love, I loved, we love, we loved' },
		{ pattern: '\\b(so )?crazy\\b', finds: '"crazy" and "so crazy" (the clip includes "so" when it\'s there)' },
		{ pattern: '\\bwh(at|y|en|ere|o)\\b', finds: 'what, why, when, where, who' },
	];
	const contractions: Example[] = [
		{ pattern: "\\b(don't|do not)\\b", finds: 'both spellings' },
		{ pattern: "\\bit\\b(?!')", finds: '"it", but not the start of "it\'s"' },
	];
	const punctuation: Example[] = [
		{ pattern: '\\byou,? know\\b', finds: '"you know" and "you, know"' },
		{ pattern: '\\bright\\?', finds: '"right?" asked as a question' },
		{ pattern: '\\$\\d[\\d,]*', finds: 'dollar amounts like $25 and $5,000' },
		{ pattern: '\\b\\d+%', finds: 'percentages like 100% and 90%' },
	];
	const clipEdges: Example[] = [
		{ pattern: '(?<=[.?!] )so\\b', finds: '"So" after . ? or !, and the clip is just "So"' },
	];
	const between: Example[] = [
		{ pattern: '\\bI (?:[^\\s|]+ ){0,2}?know\\b', finds: 'I know, I don\'t know, I don\'t even know' },
	];

	function use(pattern: string) {
		onUse(pattern);
		dialog?.close();
	}

	// The dialog has no padding, so a click whose target is the dialog itself
	// landed on the backdrop.
	function closeOnBackdrop(e: MouseEvent) {
		if (e.target === dialog) dialog?.close();
	}
</script>

{#snippet examples(list: Example[])}
	<ul class="tip-examples">
		{#each list as ex (ex.pattern)}
			<li>
				<code class="tip-pattern">{ex.pattern}</code>
				<span class="tip-finds">{ex.finds}</span>
				<button type="button" class="btn-ghost btn-small" onclick={() => use(ex.pattern)}>Use</button>
			</li>
		{/each}
	</ul>
{/snippet}

<button type="button" class="btn-ghost btn-small" onclick={() => dialog?.showModal()}>Regex tips</button>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="regex-tips" aria-labelledby="regex-tips-title" onclick={closeOnBackdrop}>
	<div class="tip-body">
		<header class="tip-head">
			<h3 id="regex-tips-title">Regex tips</h3>
			<button type="button" class="btn-ghost btn-small" onclick={() => dialog?.close()}>Close</button>
		</header>

		<p>
			Your regex runs over each transcript as one long line of text, and every match becomes a
			clip. Press <strong>Use</strong> to copy an example into the regex field, and tick
			<strong>Dry run</strong> to count matches before rendering.
		</p>

		<section>
			<h4>What the regex sees</h4>
			<div class="tip-sample">Yeah, I don't know. You know, it's crazy.</div>
			<ul class="tip-points">
				<li>Exactly one space between words.</li>
				<li>Punctuation stays on its word: <code>Yeah,</code> and <code>know.</code></li>
				<li>Case doesn't matter (the <code>i</code> flag), and every match is found (the <code>g</code> flag).</li>
				<li><code>^</code> and <code>$</code> mean the start and end of a whole transcript, not of a sentence.</li>
			</ul>
		</section>

		<section>
			<h4><code>\b</code> matches whole words</h4>
			<p>
				A plain <code>no</code> also matches inside know, not, nothing and nobody. <code>\b</code>
				marks the edge of a word, so wrap words in it. In the talking-heads bucket, <code>no</code>
				gets 7,660 hits and <code>\bno\b</code> gets 1,474. A hyphen is also a word edge, so
				<code>\bhmm\b</code> matches inside "mm-hmm".
			</p>
			{@render examples(wholeWords)}
		</section>

		<section>
			<h4><code>|</code> means "or"</h4>
			<p>
				List the options inside parentheses, with <code>\b</code> outside them, so the word edges
				apply to every option.
			</p>
			{@render examples(alternatives)}
			<p class="tip-warn">
				Without parentheses, <code>\bno|yes\b</code> means <code>\bno</code> or <code>yes\b</code>,
				so it still matches the start of "nothing" and "nobody": 5,098 hits instead of 2,021.
			</p>
			<p class="tip-warn">
				A <code>|</code> splits everything around it, not just the nearest words.
				<code>\byour mom|mam</code> means <code>\byour mom</code> or <code>mam</code>: the first
				half has no end edge, so it can clip "your moment", and the second matches "mam" inside
				any word, like mama and umami. In the talking-heads bucket it gets 45 hits, and only 16
				are "your mom". Parentheses keep the "or" to the last word:
			</p>
			{@render examples(alternativesFixed)}
		</section>

		<section>
			<h4><code>?</code> makes a piece optional</h4>
			<p>
				<code>?</code> applies to the one thing before it: a letter, or a group in parentheses.
			</p>
			{@render examples(optional)}
		</section>

		<section>
			<h4>Apostrophes and contractions</h4>
			<p>
				Type contractions with an apostrophe; a curly <code>’</code> works too.
				<code>\b</code> treats an apostrophe as the end of a word, so <code>\bit\b</code> also
				matches the "it" in "it's", and <code>\bdon\b</code> matches "don't". A clip always covers
				the whole word, so those hits come out as "it's" and "don't". <code>(?!')</code> means
				"not followed by an apostrophe".
			</p>
			{@render examples(contractions)}
		</section>

		<section>
			<h4>Punctuation</h4>
			<p>
				Because punctuation sticks to the word, <code>you know</code> misses "you, know". Make the
				comma optional, or match punctuation on purpose. These characters have special meanings
				and need a backslash to match literally: <code class="tip-nowrap">{'. ? $ ( ) [ ] { } | * + ^ \\'}</code>.
			</p>
			{@render examples(punctuation)}
		</section>

		<section>
			<h4>What ends up in the clip</h4>
			<p>
				A clip runs from the start of the first word the match touches to the end of the last.
				Matching the period in <code>\. so\b</code> pulls the previous sentence's last word into
				the clip; one such hit ran 61 seconds. A lookbehind <code>(?&lt;=…)</code> checks the
				text before the match without including it.
			</p>
			{@render examples(clipEdges)}
		</section>

		<section>
			<h4>Words in between</h4>
			<p>
				<code>[^\s|]+</code> followed by a space is one word, <code>{'{0,2}'}</code> allows zero to
				two of them, and the <code>?</code> after it prefers the fewest.
			</p>
			{@render examples(between)}
			<p class="tip-warn">
				Never put <code>.*</code> between words. <code>\bI .*know\b</code> reaches from the first
				"I" to the last "know" in a transcript; one clip ran over two hours. Even
				<code>.*?</code> crosses sentences and made clips several minutes long.
			</p>
		</section>

		<section>
			<h4>The on-screen bucket</h4>
			<p>
				In talking-heads-onscreen, a lone <code>|</code> stands in for words spoken off-screen.
				Use <code>[^\s|]+</code> rather than <code>\S+</code> for "any word", so a match can't
				bridge that gap and pull off-screen speech into the clip.
			</p>
		</section>
	</div>
</dialog>

<style>
	.regex-tips {
		background: var(--bg);
		color: var(--ink);
		border: 2px solid var(--ink);
		padding: 0;
		width: min(calc(100vw - 2rem), 760px);
		max-height: 85vh;
		overflow: auto;
	}
	.regex-tips::backdrop {
		background: color-mix(in oklab, var(--well) 60%, transparent);
	}
	.tip-body {
		display: grid;
		gap: 1.75rem;
		padding: 0 1.5rem 1.5rem;
	}
	.tip-head {
		position: sticky;
		top: 0;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding-block: 1.25rem 1rem;
		background: var(--bg);
		border-bottom: 1px solid var(--rule);
	}
	.tip-head h3 {
		margin: 0;
	}
	section {
		display: grid;
		gap: 0.75rem;
	}
	h4 {
		margin: 0;
		font-size: var(--fs-body);
	}
	p {
		margin: 0;
		line-height: var(--lh-body);
	}
	/* No ligatures: JetBrains Mono would draw the `<=` in `(?<=` as one glyph. */
	code {
		font-family: var(--font-mono);
		font-size: 0.9em;
		font-variant-ligatures: none;
	}
	.tip-nowrap {
		white-space: nowrap;
	}
	.tip-sample {
		background: var(--well);
		border: 1px solid var(--well-border);
		color: var(--accent);
		font-family: var(--font-mono);
		padding: 0.75rem 1rem;
	}
	.tip-points {
		margin: 0;
		padding-inline-start: 1.25rem;
		display: grid;
		gap: 0.35rem;
	}
	.tip-examples {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	.tip-examples li {
		display: grid;
		grid-template-columns: minmax(0, 15rem) minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem;
		padding-block: 0.5rem;
		border-top: 1px solid color-mix(in oklab, var(--rule) 20%, transparent);
	}
	.tip-pattern {
		background: var(--well);
		color: var(--accent);
		padding: 0.35rem 0.5rem;
		overflow-wrap: anywhere;
	}
	.tip-finds {
		font-size: var(--fs-small);
		color: var(--muted);
	}
	.tip-warn {
		border-left: 3px solid var(--accent);
		padding-inline-start: 0.75rem;
	}
	@media (max-width: 640px) {
		.tip-body {
			padding: 0 1rem 1rem;
		}
		.tip-examples li {
			grid-template-columns: minmax(0, 1fr) auto;
		}
		.tip-pattern {
			grid-column: 1 / -1;
		}
	}
</style>
