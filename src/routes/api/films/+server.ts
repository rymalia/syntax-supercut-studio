import { json } from '@sveltejs/kit';
import { readdir, readFile } from 'node:fs/promises';
import type { RequestHandler } from './$types';
import { filmPath, filmsDir } from '$lib/server/engine';

export const GET: RequestHandler = async () => {
	const names = await readdir(filmsDir()).catch(() => []);
	const films = (await Promise.all(names.filter((name) => /^[a-z0-9_-]+\.json$/.test(name)).map(async (name) => {
		const slug = name.slice(0, -5);
		try {
			const film = JSON.parse(await readFile(filmPath(slug), 'utf8'));
			return Array.isArray(film?.lines) ? { slug, title: typeof film.title === 'string' ? film.title : slug } : null;
		} catch { return null; }
	}))).filter((film) => film !== null);
	films.sort((a, b) => a.title.localeCompare(b.title));
	return json({ films });
};
