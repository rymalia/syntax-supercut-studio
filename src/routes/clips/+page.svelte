<script lang="ts">
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import ExportForResolve from '$lib/ExportForResolve.svelte';

	let { data }: { data: PageData } = $props();

	let filter = $state('');
	let selected = $state<string | null>(null);
	let activeBucket = $state<string>('all');

	const bucketTabs = $derived(['all', ...data.buckets]);

	const filtered = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		return data.clips.filter((c) => {
			if (activeBucket !== 'all' && c.bucket !== activeBucket) return false;
			if (!q) return true;
			return c.file.toLowerCase().includes(q) || c.bucket.toLowerCase().includes(q);
		});
	});

	function mediaUrl(bucket: string, file: string): string {
		return `/api/media/${encodeURIComponent(bucket)}/supercuts/${encodeURIComponent(file)}`;
	}

	function formatDate(ms: number): string {
		return new Date(ms).toLocaleString();
	}

	async function del(bucket: string, file: string) {
		if (!confirm(`Delete ${bucket}/${file}?`)) return;
		const res = await fetch(
			`/api/clips/${encodeURIComponent(bucket)}/${encodeURIComponent(file)}`,
			{ method: 'DELETE' },
		);
		if (!res.ok) {
			alert('Failed to delete');
			return;
		}
		const key = `${bucket}::${file}`;
		if (selected === key) selected = null;
		invalidateAll();
	}
</script>

<section class="hero">
	<h1>
		Rendered <mark>Clips</mark>.
	</h1>
	<p class="muted">{data.clips.length} supercuts across {data.buckets.length} buckets.</p>
</section>

<section class="row" style="justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
	<div class="row" style="gap: 0.75rem; flex-wrap: wrap;">
		{#each bucketTabs as b (b)}
			<button
				type="button"
				class="btn-small"
				class:btn-primary={activeBucket === b}
				class:btn-ghost={activeBucket !== b}
				onclick={() => (activeBucket = b)}
			>
				{b}
			</button>
		{/each}
	</div>
	<input
		type="search"
		placeholder="FILTER..."
		bind:value={filter}
		style="max-width: 28rem;"
	/>
</section>

<section class="clip-grid">
	{#each filtered as clip (clip.bucket + '::' + clip.file)}
		{@const key = `${clip.bucket}::${clip.file}`}
		<div class="clip-tile">
			<button
				type="button"
				onclick={() => (selected = selected === key ? null : key)}
				style="all: unset; cursor: pointer; display: grid; gap: 0.75rem;"
			>
				<video
					src={mediaUrl(clip.bucket, clip.file)}
					preload="metadata"
					muted
					playsinline
					onmouseenter={(e) => (e.currentTarget as HTMLVideoElement).play().catch(() => {})}
					onmouseleave={(e) => {
						const v = e.currentTarget as HTMLVideoElement;
						v.pause();
						v.currentTime = 0;
					}}
				></video>
				<div class="clip-tile__name">
					<span class="tag" style="margin-inline-end: 0.4em;">{clip.bucket}</span>
					{clip.file}
				</div>
				<div class="clip-tile__meta">
					<span>{clip.sizeMB} MB</span>
					<span>{formatDate(clip.modified)}</span>
				</div>
			</button>

			{#if selected === key}
				<div style="margin-block-start: 1rem;">
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						controls
						src={mediaUrl(clip.bucket, clip.file)}
						style="inline-size: 100%; aspect-ratio: 16/9;"
					></video>
					<div class="row" style="margin-block-start: 0.75rem;">
						<a class="btn btn-ghost btn-small" href={mediaUrl(clip.bucket, clip.file)} download>
							Download
						</a>
						<button class="btn-small" onclick={() => del(clip.bucket, clip.file)}>Delete</button>
					</div>
					{#if clip.hasCuts}
						<ExportForResolve target={{ bucket: clip.bucket, file: clip.file }} />
					{/if}
				</div>
			{/if}
		</div>
	{/each}
</section>
