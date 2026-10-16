import { error, json } from '@sveltejs/kit';
import { readdir, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { RequestHandler } from './$types';
import { resolveBuckets } from '$lib/server/paths';
import { logActivity } from '$lib/server/activity';

/**
 * Delete every file associated with a single library slug inside a bucket:
 *   videos/<slug>.<any-media-ext>   (mp4, m4a, mkv, mov, webm, avi, mp3, ...)
 *   transcripts/<slug>.json
 *
 * Returns the list of files that were actually unlinked so the UI can report
 * which bits existed.
 */
export const DELETE: RequestHandler = async ({ params }) => {
	const bucketName = decodeURIComponent(params.bucket);
	const slug = decodeURIComponent(params.slug);

	// Basic traversal guards. Slug comes from the UI and is never a path.
	if (
		!slug ||
		slug.includes('/') ||
		slug.includes('\\') ||
		slug === '.' ||
		slug === '..'
	) {
		throw error(400, 'Invalid slug');
	}

	const [bucket] = await resolveBuckets([bucketName]).catch(() => []);
	if (!bucket) throw error(404, 'Unknown bucket');

	const deleted: string[] = [];

	// 1. Every media file in the bucket's videos/ whose stem matches the slug.
	try {
		for (const f of await readdir(bucket.videosDir)) {
			if (basename(f, extname(f)) !== slug) continue;
			const full = join(bucket.videosDir, f);
			try {
				await unlink(full);
				deleted.push(`videos/${f}`);
			} catch {
				// Report only files that were actually removed.
			}
		}
	} catch {
		// videos dir may not exist yet
	}

	// 2. The JSON transcript if present.
	const transcriptPath = join(bucket.transcriptsDir, `${slug}.json`);
	try {
		await unlink(transcriptPath);
		deleted.push(`transcripts/${slug}.json`);
	} catch {
		// transcript absent — fine
	}

	if (deleted.length === 0) throw error(404, 'Nothing to delete');

	void logActivity('library:delete', `${bucket.name}/${slug}`, deleted.join(', '));

	return json({ ok: true, deleted });
};
