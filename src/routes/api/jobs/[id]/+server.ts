import { json, error } from '@sveltejs/kit';
import { basename, dirname, join } from 'node:path';
import type { RequestHandler } from './$types';
import { cancelJob, getJob } from '$lib/server/jobs';
import { bucketForPath } from '$lib/server/paths';
import { engineDir, engineMediaPath } from '$lib/server/engine';

export const DELETE: RequestHandler = async ({ params }) => {
	const ok = cancelJob(params.id);
	if (!ok) throw error(404, 'Job not found or already finished');
	return json({ ok: true });
};

export const GET: RequestHandler = async ({ params }) => {
	const job = getJob(params.id);
	if (!job) throw error(404, 'Job not found');

	// Build a media URL for the result if it produced one.
	let mediaUrl: string | null = null;
	if (
		job.status === 'done' &&
		job.result &&
		'outFile' in job.result &&
		typeof job.result.outFile === 'string'
	) {
		const abs = job.result.outFile;
		const loc = bucketForPath(abs);
		if (loc) {
			const filename = basename(abs);
			mediaUrl = `/api/media/${encodeURIComponent(loc.bucket)}/${loc.kind}/${encodeURIComponent(filename)}`;
		} else if (job.kind === 'film-render' || job.kind === 'sentence') {
			const rel = engineMediaPath(abs);
			if (rel?.startsWith('films/out/')) mediaUrl = `/api/engine-media/${rel.split('/').map(encodeURIComponent).join('/')}`;
		}
	}

	// What "Export for Resolve" (POST /api/export) should be given for this job.
	let exportTarget: { bucket: string; file: string } | { plan: string } | null = null;
	const result = job.status === 'done' ? (job.result as Record<string, unknown> | null) : null;
	if (job.kind === 'supercut' && typeof result?.cutsFile === 'string' && typeof result.outFile === 'string') {
		const loc = bucketForPath(result.outFile);
		if (loc?.kind === 'supercuts') exportTarget = { bucket: loc.bucket, file: basename(result.outFile) };
	} else if ((job.kind === 'sentence' || job.kind === 'film-render') && typeof result?.plan === 'string') {
		const plan = result.plan;
		if (plan.endsWith('.plan.json') && dirname(plan) === join(engineDir(), 'films', 'out')) {
			exportTarget = { plan: basename(plan, '.plan.json') };
		}
	}

	return json({ job, mediaUrl, exportTarget });
};
