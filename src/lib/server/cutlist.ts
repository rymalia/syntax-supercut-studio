import { realpath, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/**
 * Cut list v1 (docs/ENGINE_CONTRACT.md): the edit decisions of a render, so the
 * engine's `export` can rebuild it in an editor from the original sources.
 * Written beside the render as `<render>.cuts.json`.
 */
export interface CutClip {
	/** Bucket video path; resolved to the source file when written. */
	video: string;
	track?: number;
	rec: number;
	in: number;
	out: number;
	speed?: number;
	/** Where the picture sits, as frame fractions `[x, y, w, h]`; null = full frame. */
	rect?: [number, number, number, number] | null;
	name: string;
}

export interface CutText {
	start: number;
	end: number;
	text: string;
}

export interface CutMarker {
	t: number;
	name: string;
	note: string;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Clip id the engine and the editor show for a source: its basename (`c04`). */
export function clipId(video: string): string {
	return basename(video, extname(video));
}

export async function writeCutList(
	outFile: string,
	origin: string,
	clips: CutClip[],
	captions: CutText[] = [],
	markers: CutMarker[] = [],
): Promise<string> {
	// Bucket videos are symlinks; the editor needs the files they point at.
	const sources = new Map<string, string>();
	const out: Record<string, unknown>[] = [];
	for (const c of clips) {
		let src = sources.get(c.video);
		if (!src) sources.set(c.video, (src = await realpath(c.video)));
		out.push({
			media: 'av',
			track: c.track ?? 1,
			rec: r3(c.rec),
			src,
			in: r3(c.in),
			out: r3(c.out),
			speed: Number((c.speed ?? 1).toFixed(6)),
			rect: c.rect ?? null,
			crop: null,
			gain_db: 0,
			fade_in: 0,
			fade_out: 0,
			freeze: 0,
			clip: clipId(c.video),
			name: c.name,
		});
	}
	const cutsFile = outFile.replace(/\.mp4$/, '.cuts.json');
	const list = {
		version: 1,
		name: basename(outFile, '.mp4'),
		origin,
		fps: null,
		width: 1920,
		height: 1080,
		clips: out,
		captions: captions.map((c) => ({ start: r3(c.start), end: r3(c.end), text: c.text })),
		markers: markers.map((m) => ({ ...m, t: r3(m.t) })),
	};
	await writeFile(cutsFile, JSON.stringify(list, null, 1));
	return cutsFile;
}
