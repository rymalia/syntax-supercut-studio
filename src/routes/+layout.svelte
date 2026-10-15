<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';

	const links = [
		{ href: '/', label: 'Library' },
		{ href: '/clips', label: 'Clips' },
		{ href: '/supercut', label: 'Supercut' },
		{ href: '/sentence', label: 'Sentence' },
		{ href: '/songify', label: 'Songify' },
		{ href: '/transcribe', label: 'Transcribe' },
		{ href: '/stats', label: 'Stats' },
	];

	let { children } = $props();

	// app.html sets data-theme before paint. The toggle reads it from the DOM
	// and its label is CSS-driven, so the server render is never wrong.
	function toggleTheme() {
		const root = document.documentElement;
		const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
		root.dataset.theme = next;
		try {
			localStorage.setItem('theme', next);
		} catch {
			// storage unavailable; the choice just won't persist
		}
	}
</script>

<header class="topbar">
	<a href="/" class="wordmark">
		Super<mark>cut</mark> Studio
	</a>
	<nav class="nav">
		{#each links as link}
			<a
				href={link.href}
				aria-current={$page.url.pathname === link.href ? 'page' : undefined}
			>
				{link.label}
			</a>
		{/each}
	</nav>
	<button class="btn-small btn-ghost theme-toggle" onclick={toggleTheme}>
		<span class="theme-toggle__to-dark">Dark</span>
		<span class="theme-toggle__to-light">Light</span>
		<span class="visually-hidden">mode</span>
	</button>
</header>

<main class="shell">
	{@render children()}
</main>
