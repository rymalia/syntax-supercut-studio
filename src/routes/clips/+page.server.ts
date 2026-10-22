import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { PageServerLoad } from './$types';
import { listBuckets } from '$lib/server/paths';
import { engineDir } from '$lib/server/engine';

export interface ClipInfo {
	bucket: string;
	file: string;
	sizeMB: number;
	modified: number;
	/** A `.cuts.json` cut list sits beside the mp4, so it can be exported to Resolve. */
	hasCuts: boolean;
}

export interface EngineRenderInfo {
	/** The mp4's file name in `films/out/`. */
	file: string;
	/** The plan name `export --plan` takes (the mp4 name without `.mp4` or `.draft.mp4`). */
	plan: string;
	draft: boolean;
	sizeMB: number;
	modified: number;
	/** The plan has the render times (`t`) the exporter needs; a plan from `plan` alone lacks them. */
	exportable: boolean;
	/** The plan was written after this mp4, so it may describe a different render. */
	planNewer: boolean;
}

/** Sentence and film renders the engine wrote to `films/out/`, newest first. */
async function listEngineRenders(): Promise<EngineRenderInfo[]> {
	const outDir = join(engineDir(), 'films', 'out');
	let entries: string[] = [];
	try {
		entries = await readdir(outDir);
	} catch {
		return [];
	}
	const renders: EngineRenderInfo[] = [];
	for (const file of entries) {
		const m = /^(.+?)(\.draft)?\.mp4$/.exec(file);
		if (!m) continue;
		const info = await stat(join(outDir, file)).catch(() => null);
		if (!info || !info.isFile()) continue;
		const plan = m[1];
		let exportable = false;
		let planNewer = false;
		const planFile = join(outDir, `${plan}.plan.json`);
		// Hand-run renders can have any name, but only engine-style names can be exported.
		const planInfo = /^[a-z0-9_-]+$/.test(plan) ? await stat(planFile).catch(() => null) : null;
		if (planInfo?.isFile()) {
			planNewer = planInfo.mtimeMs > info.mtimeMs + 1000;
			try {
				const snippets: unknown = JSON.parse(await readFile(planFile, 'utf8'));
				exportable =
					Array.isArray(snippets) &&
					snippets.length > 0 &&
					snippets.every((s) => Number.isFinite((s as { t?: unknown } | null)?.t));
			} catch {
				exportable = false;
			}
		}
		renders.push({
			file,
			plan,
			draft: Boolean(m[2]),
			sizeMB: Number((info.size / 1024 / 1024).toFixed(1)),
			modified: info.mtimeMs,
			exportable,
			planNewer,
		});
	}
	return renders.sort((a, b) => b.modified - a.modified);
}

export const load: PageServerLoad = async () => {
	const buckets = await listBuckets();
	const clips: ClipInfo[] = [];

	for (const bucket of buckets) {
		let entries: string[] = [];
		try {
			entries = await readdir(bucket.supercutsDir);
		} catch {
			continue;
		}
		const names = new Set(entries);
		for (const file of entries) {
			if (extname(file).toLowerCase() !== '.mp4') continue;
			const info = await stat(join(bucket.supercutsDir, file)).catch(() => null);
			if (!info || !info.isFile()) continue;
			clips.push({
				bucket: bucket.name,
				file,
				sizeMB: Number((info.size / 1024 / 1024).toFixed(1)),
				modified: info.mtimeMs,
				hasCuts: file.endsWith('.mp4') && names.has(file.replace(/\.mp4$/, '.cuts.json')),
			});
		}
	}

	clips.sort((a, b) => b.modified - a.modified);
	return { clips, buckets: buckets.map((b) => b.name), engineRenders: await listEngineRenders() };
};
