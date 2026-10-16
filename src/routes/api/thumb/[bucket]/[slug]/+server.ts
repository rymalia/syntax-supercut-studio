import { error } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import type { RequestHandler } from './$types';
import { resolveBuckets } from '$lib/server/paths';
import { ensureThumbStrip, findVideoBySlug } from '$lib/server/thumbs';

/** 4-frame hover-preview strip for a library video, generated on first request. */
export const GET: RequestHandler = async ({ params }) => {
	const slug = params.slug;
	if (!slug || slug.includes('/') || slug.includes('\\') || slug.startsWith('.')) {
		throw error(400, 'Invalid slug');
	}

	const [bucket] = await resolveBuckets([params.bucket]).catch(() => []);
	if (!bucket) throw error(404, 'Unknown bucket');

	const video = await findVideoBySlug(bucket, slug);
	if (!video) throw error(404, 'No video for this slug');

	let file: string;
	try {
		file = await ensureThumbStrip(bucket, slug, video);
	} catch (err) {
		throw error(500, `Thumbnail failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	return new Response(await readFile(file), {
		headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' },
	});
};
