import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { PageServerLoad } from './$types';
import { listBuckets, VIDEO_EXTS, AUDIO_EXTS } from '$lib/server/paths';

export interface VideoRow {
	bucket: string;
	slug: string;
	/** Original filename (without extension) when the video is a symlink to a differently named source. */
	title: string | null;
	videoFile: string | null;
	mp3File: string | null;
	transcriptFile: string | null;
	videoSizeMB: number | null;
	mp3SizeMB: number | null;
	transcriptWords: number | null;
	transcriptDurationSec: number | null;
	hasVideo: boolean;
	hasMp3: boolean;
	hasTranscript: boolean;
}

interface BucketGroup {
	name: string;
	rows: VideoRow[];
}

export const load: PageServerLoad = async () => {
	const buckets = await listBuckets();
	const groups: BucketGroup[] = [];

	let totals = {
		videos: 0,
		transcribed: 0,
		totalWords: 0,
		totalDurationSec: 0,
	};

	for (const bucket of buckets) {
		const videos = new Map<string, { file: string; size: number; title: string | null }>();
		const mp3s = new Map<string, { file: string; size: number }>();

		let videoEntries: string[] = [];
		try {
			videoEntries = await readdir(bucket.videosDir);
		} catch {}

		for (const file of videoEntries) {
			const ext = extname(file).toLowerCase();
			const slug = basename(file, extname(file));
			const full = join(bucket.videosDir, file);
			const info = await stat(full).catch(() => null);
			if (!info) continue;
			if (VIDEO_EXTS.has(ext)) {
				// Ingested buckets symlink `<slug>.mp4` to the original download,
				// whose name is the only human-readable title we have.
				const target = await readlink(full).catch(() => null);
				const original = target ? basename(target, extname(target)) : null;
				videos.set(slug, { file, size: info.size, title: original && original !== slug ? original : null });
			} else if (AUDIO_EXTS.has(ext) && ext === '.mp3') {
				mp3s.set(slug, { file, size: info.size });
			}
		}

		let transcriptEntries: string[] = [];
		try {
			transcriptEntries = await readdir(bucket.transcriptsDir);
		} catch {}

		const transcripts = new Map<string, string>();
		for (const file of transcriptEntries) {
			if (!file.endsWith('.json')) continue;
			transcripts.set(basename(file, '.json'), file);
		}

		const slugs = new Set<string>([...videos.keys(), ...mp3s.keys(), ...transcripts.keys()]);
		const rows: VideoRow[] = [];
		for (const slug of slugs) {
			const v = videos.get(slug);
			const m = mp3s.get(slug);
			const tFile = transcripts.get(slug);

			let words: number | null = null;
			let durationSec: number | null = null;
			if (tFile) {
				try {
					const json = JSON.parse(await readFile(join(bucket.transcriptsDir, tFile), 'utf8'));
					words = Array.isArray(json.words) ? json.words.length : 0;
					durationSec = typeof json.duration === 'number' ? json.duration : null;
				} catch {}
			}

			rows.push({
				bucket: bucket.name,
				slug,
				title: v?.title ?? null,
				videoFile: v?.file ?? null,
				mp3File: m?.file ?? null,
				transcriptFile: tFile ?? null,
				videoSizeMB: v ? Number((v.size / 1024 / 1024).toFixed(1)) : null,
				mp3SizeMB: m ? Number((m.size / 1024 / 1024).toFixed(1)) : null,
				transcriptWords: words,
				transcriptDurationSec: durationSec,
				hasVideo: Boolean(v),
				hasMp3: Boolean(m),
				hasTranscript: Boolean(tFile),
			});
		}

		rows.sort((a, b) => a.slug.localeCompare(b.slug));
		groups.push({ name: bucket.name, rows });

		totals.videos += rows.filter((r) => r.hasVideo).length;
		totals.transcribed += rows.filter((r) => r.hasTranscript).length;
		totals.totalWords += rows.reduce((s, r) => s + (r.transcriptWords ?? 0), 0);
		totals.totalDurationSec += rows.reduce((s, r) => s + (r.transcriptDurationSec ?? 0), 0);
	}

	return { groups, totals };
};
