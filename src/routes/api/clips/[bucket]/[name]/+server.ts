import { error, json } from '@sveltejs/kit';
import { unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RequestHandler } from './$types';
import { resolveBuckets, isInsideAllowedRoot } from '$lib/server/paths';
import { logActivity } from '$lib/server/activity';

export const DELETE: RequestHandler = async ({ params }) => {
	const bucketName = decodeURIComponent(params.bucket);
	const name = decodeURIComponent(params.name);
	if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
		throw error(400, 'Invalid filename');
	}
	const [bucket] = await resolveBuckets([bucketName]).catch(() => []);
	if (!bucket) throw error(404, 'Unknown bucket');

	const full = resolve(join(bucket.supercutsDir, name));
	if (!isInsideAllowedRoot(full)) throw error(403, 'Forbidden');
	await unlink(full).catch((err) => {
		throw error(404, err.message);
	});
	// The render's cut list and any editor exports made from it go with it. The
	// engine names exports with its safe() (other characters, like `'`, become `-`).
	if (name.endsWith('.mp4')) {
		const stem = name.slice(0, -'.mp4'.length);
		const exportStem = stem.replace(/[^\p{L}\p{N}._-]/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120);
		const dir = dirname(full);
		await Promise.all(
			[`${stem}.cuts.json`, `${exportStem}.fcpxml`, `${exportStem}.srt`].map((f) => unlink(join(dir, f)).catch(() => {})),
		);
	}
	void logActivity('clip:delete', `${bucket.name}/${name}`, 'deleted');
	return json({ ok: true });
};
