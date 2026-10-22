import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveBuckets, PITCH_CACHE_FILE } from '../paths.js';
import { runFfmpeg, atempoChain, throwIfAborted, CancelledError, type LogFn } from '../ffmpeg.js';
import {
	concatSegments,
	frameCountForDuration,
	renderedDuration,
	renderSegments,
	SEGMENT_AUDIO_RATE,
	segmentAudioFilter,
	segmentEncodeArgs,
	type RenderSegment,
} from '../render.js';
import { slugify, timestampSuffix, type Hit } from '../text.js';
import { collectHits } from '../hits.js';
import { attributeHits } from '../engine-hits.js';
import { clipId, writeCutList, type CutClip, type CutMarker } from '../cutlist.js';

const CANVAS_W = 1280;
const CANVAS_H = 720;

const MIN_PITCH_HZ = 70;
const MAX_PITCH_HZ = 500;
const MIN_CONFIDENT_SAMPLES = 3;
const MAX_SHIFT_SEMITONES = 9;

interface AnalyzedHit extends Hit {
	pitchHz: number;
	pitchMidi: number;
}

function run(
	cmd: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
	if (signal?.aborted) return Promise.reject(new CancelledError());
	return new Promise((res, rej) => {
		const p = spawn(cmd, args);
		let stdout = '';
		let stderr = '';
		let cancelled = false;
		const onAbort = () => {
			cancelled = true;
			try {
				p.kill('SIGTERM');
			} catch {}
			setTimeout(() => {
				try {
					p.kill('SIGKILL');
				} catch {}
			}, 500).unref();
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		p.stdout.on('data', (d) => (stdout += d.toString()));
		p.stderr.on('data', (d) => (stderr += d.toString()));
		p.on('error', (err) => {
			signal?.removeEventListener('abort', onAbort);
			rej(err);
		});
		p.on('close', (code) => {
			signal?.removeEventListener('abort', onAbort);
			if (cancelled) return rej(new CancelledError());
			res({ stdout, stderr, code: code ?? 0 });
		});
	});
}

const NOTE_TO_SEMITONE: Record<string, number> = {
	c: 0,
	'c#': 1,
	db: 1,
	d: 2,
	'd#': 3,
	eb: 3,
	e: 4,
	f: 5,
	'f#': 6,
	gb: 6,
	g: 7,
	'g#': 8,
	ab: 8,
	a: 9,
	'a#': 10,
	bb: 10,
	b: 11,
};

function noteToMidi(note: string): number {
	const m = note.trim().toLowerCase().match(/^([a-g][#b]?)(-?\d+)$/);
	if (!m) throw new Error(`Bad note: ${note}`);
	const [, pitchClass, octaveStr] = m;
	const semi = NOTE_TO_SEMITONE[pitchClass];
	if (semi === undefined) throw new Error(`Bad note: ${note}`);
	const octave = parseInt(octaveStr, 10);
	return (octave + 1) * 12 + semi;
}

function hzToMidi(hz: number): number {
	return 69 + 12 * Math.log2(hz / 440);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToName(midi: number): string {
	const m = Math.round(midi);
	return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

function midiToHz(midi: number): number {
	return 440 * Math.pow(2, (midi - 69) / 12);
}

function parseMelody(input: string): number[] {
	return input.split(/[\s,]+/).filter(Boolean).map(noteToMidi);
}

async function detectPitchHz(audioFile: string, signal?: AbortSignal): Promise<number | null> {
	const { stdout, code } = await run(
		'aubiopitch',
		['-i', audioFile, '-u', 'hertz', '-p', 'yinfft', '-s', '-60'],
		signal,
	);
	if (code !== 0) return null;

	const samples: number[] = [];
	for (const line of stdout.split('\n')) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 2) continue;
		const hz = parseFloat(parts[1]);
		if (!Number.isFinite(hz) || hz <= 0) continue;
		if (hz < MIN_PITCH_HZ || hz > MAX_PITCH_HZ) continue;
		samples.push(hz);
	}
	if (samples.length < MIN_CONFIDENT_SAMPLES) return null;
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)];
}

async function analyzeHits(
	hits: Hit[],
	workDir: string,
	cacheFile: string,
	onLog: LogFn,
	signal?: AbortSignal,
): Promise<AnalyzedHit[]> {
	let cache: Record<string, number> = {};
	if (existsSync(cacheFile)) {
		try {
			cache = JSON.parse(await readFile(cacheFile, 'utf8'));
		} catch {}
	}

	const analyzed: AnalyzedHit[] = [];
	for (let i = 0; i < hits.length; i++) {
		throwIfAborted(signal);
		const h = hits[i];
		const key = `${h.video}::${h.start.toFixed(3)}::${h.end.toFixed(3)}`;
		let hz = cache[key];

		if (hz === undefined) {
			const wavPath = join(workDir, `pitch-${i}.wav`);
			await runFfmpeg(
				[
					'-ss',
					h.start.toFixed(3),
					'-i',
					h.video,
					'-t',
					(h.end - h.start).toFixed(3),
					'-vn',
					'-ac',
					'1',
					'-ar',
					'22050',
					wavPath,
				],
				() => {},
				signal,
			);
			const detected = await detectPitchHz(wavPath, signal);
			hz = detected ?? -1;
			cache[key] = hz;
		}
		if (i % 25 === 0) onLog(`  pitch ${i + 1}/${hits.length}`);
		if (hz > 0) analyzed.push({ ...h, pitchHz: hz, pitchMidi: hzToMidi(hz) });
	}

	await writeFile(cacheFile, JSON.stringify(cache, null, 2));
	return analyzed;
}

async function renderNote(
	hit: AnalyzedHit,
	targetMidi: number,
	noteSeconds: number,
	outPath: string,
	onLog: LogFn,
	signal?: AbortSignal,
): Promise<void> {
	const semitoneShift = targetMidi - hit.pitchMidi;
	const pitchRatio = Math.pow(2, semitoneShift / 12);
	const origAudioRate = SEGMENT_AUDIO_RATE;
	const shiftedRate = Math.round(origAudioRate * pitchRatio);
	const actualPitchRatio = shiftedRate / origAudioRate;

	const wordDur = hit.end - hit.start;
	const segmentDur = Math.min(wordDur, noteSeconds);
	const frameCount = frameCountForDuration(segmentDur);
	const preRoll = Math.min(0.2, hit.start);
	const inputStart = hit.start - preRoll;
	const trimStart = preRoll;
	const trimEnd = preRoll + segmentDur;

	const videoFilter = `[0:v]trim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)},setpts=PTS-STARTPTS,scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,tpad=stop_mode=clone:stop=-1[v]`;

	const noShift = Math.abs(semitoneShift) < 0.01;
	const pitchChain = noShift
		? ''
		: `,aresample=${origAudioRate},asetrate=${shiftedRate},aresample=${origAudioRate},${atempoChain(1 / actualPitchRatio)}`;
	const audioFilter = `[0:a]atrim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)},asetpts=PTS-STARTPTS${pitchChain},atrim=duration=${segmentDur.toFixed(3)},asetpts=PTS-STARTPTS,${segmentAudioFilter(frameCount)}[a]`;

	await runFfmpeg(
		[
			'-ss',
			inputStart.toFixed(3),
			'-i',
			hit.video,
			'-filter_complex',
			`${videoFilter};${audioFilter}`,
			'-map',
			'[v]',
			'-map',
			'[a]',
			...segmentEncodeArgs(frameCount),
			outPath,
		],
		onLog,
		signal,
	);
}

function pickClipsForMelody(melody: number[], hits: AnalyzedHit[]): AnalyzedHit[] {
	const picks: AnalyzedHit[] = [];
	let last: AnalyzedHit | null = null;
	for (const targetMidi of melody) {
		const sorted = [...hits].sort((a, b) => {
			const da = Math.abs(a.pitchMidi - targetMidi);
			const db = Math.abs(b.pitchMidi - targetMidi);
			return da - db;
		});
		const pick = sorted.find((h) => h !== last) ?? sorted[0];
		picks.push(pick);
		last = pick;
	}
	return picks;
}

export interface SongifyOptions {
	target: string;
	melody: string;
	bpm?: number;
	subdivision?: number;
	singleClip?: boolean;
	noShift?: boolean;
	cast?: string[] | null;
	onscreen?: boolean;
	buckets?: string[] | null;
	outDir?: string;
	onLog?: LogFn;
	signal?: AbortSignal;
}

export interface SongifyResult {
	outFile: string;
	/** Cut list v1 beside the mp4 (`<render>.cuts.json`); null if writing failed. */
	cutsFile: string | null;
	notes: number;
	naturalRange: { minHz: number; maxHz: number } | null;
}

export async function buildSong(opts: SongifyOptions): Promise<SongifyResult> {
	const target = opts.target.trim();
	if (!target) throw new Error('Target is empty');
	const melodyStr = opts.melody.trim();
	if (!melodyStr) throw new Error('Melody is empty');

	const bpm = opts.bpm ?? 100;
	const subdivision = opts.subdivision ?? 1;
	const singleClip = opts.singleClip ?? false;
	const noShift = opts.noShift ?? false;
	const cast = opts.cast ?? null;
	const onscreen = opts.onscreen ?? false;

	const onLog = opts.onLog ?? (() => {});
	const signal = opts.signal;

	const buckets = await resolveBuckets(opts.buckets);
	if (buckets.length === 0) throw new Error('No buckets available');
	const outDir = opts.outDir ?? buckets[0].supercutsDir;
	onLog(`Buckets: ${buckets.map((b) => b.name).join(', ')}`);

	const cacheFile = PITCH_CACHE_FILE;
	const noteSeconds = (60 / bpm) * subdivision;

	const melody = parseMelody(melodyStr);
	onLog(`Melody: ${melodyStr} (${melody.length} notes @ ${bpm} bpm × ${subdivision})`);

	let hits = await collectHits({
		target,
		buckets: buckets.map((b) => b.name),
		onLog,
	});
	hits = await attributeHits(hits, { cast, onscreen, onLog, signal });
	onLog(`Found ${hits.length} hits`);
	if (hits.length === 0) {
		if (!cast?.length && !onscreen) throw new Error('No hits found for target');
		const restriction = [cast?.length ? `by ${cast.join(', ')}` : '', onscreen ? '(on-screen)' : ''].filter(Boolean).join(' ');
		throw new Error(`No hits found for "${target}"${restriction ? ` ${restriction}` : ''}`);
	}

	await mkdir(outDir, { recursive: true });
	const slug = slugify(target);
	const castSuffix = cast?.length ? `-${slugify(cast[0].replace(/[\/_]+/g, ' '))}` : '';
	const workDir = join(outDir, `.tmp-songify-${slug}-${Date.now()}`);
	await mkdir(workDir, { recursive: true });

	try {
		onLog('Detecting pitch on each clip...');
		const analyzed = await analyzeHits(hits, workDir, cacheFile, onLog, signal);
		onLog(`  ${analyzed.length}/${hits.length} usable`);
		if (analyzed.length === 0) {
			throw new Error(`No clips with detectable pitch. Try a voiced word like "yeah" or "no".`);
		}

		const minMidi = Math.min(...analyzed.map((a) => a.pitchMidi));
		const maxMidi = Math.max(...analyzed.map((a) => a.pitchMidi));
		onLog(
			`  natural range: ~${minMidi.toFixed(1)}-${maxMidi.toFixed(1)} MIDI (${midiToHz(minMidi).toFixed(0)}-${midiToHz(maxMidi).toFixed(0)} Hz)`,
		);

		let picks: AnalyzedHit[];
		if (singleClip) {
			const idx = Math.floor(Math.random() * analyzed.length);
			const pick = analyzed[idx];
			onLog(`Single-clip mode: "${pick.word}" from ${basename(pick.video)}`);
			picks = melody.map(() => pick);
		} else {
			picks = pickClipsForMelody(melody, analyzed);
		}

		const avgPickMidi = picks.reduce((s, p) => s + p.pitchMidi, 0) / picks.length;
		const avgMelody = melody.reduce((s, m) => s + m, 0) / melody.length;
		const octaveShift = Math.round((avgPickMidi - avgMelody) / 12);
		if (octaveShift !== 0) onLog(`Auto-transposing melody by ${octaveShift} octave(s)`);
		const transposedMelody = melody.map((m) => m + octaveShift * 12);

		// Cut list: each note is its word at the source's own speed. The cut list has
		// no pitch field, so each note's shift goes in its name and marker for the editor.
		const cutClips: CutClip[] = [];
		const cutMarkers: CutMarker[] = [];
		const segments: RenderSegment[] = [];
		const effectiveTargets: number[] = [];
		let rec = 0;
		for (let i = 0; i < transposedMelody.length; i++) {
			throwIfAborted(signal);
			const pick = picks[i];
			const targetMidi = transposedMelody[i];
			const shift = targetMidi - pick.pitchMidi;
			let effectiveTarget: number;
			if (noShift) {
				effectiveTarget = pick.pitchMidi;
			} else {
				const clampedShift = Math.max(
					-MAX_SHIFT_SEMITONES,
					Math.min(MAX_SHIFT_SEMITONES, shift),
				);
				effectiveTarget = pick.pitchMidi + clampedShift;
			}

			const segmentDur = Math.min(pick.end - pick.start, noteSeconds);
			effectiveTargets.push(effectiveTarget);
			segments.push({
				path: join(workDir, `note-${String(i).padStart(4, '0')}.mov`),
				frameCount: frameCountForDuration(segmentDur),
			});
			const semitones = effectiveTarget - pick.pitchMidi;
			const shiftLabel = Math.abs(semitones) < 0.01 ? '0 st' : `${semitones > 0 ? '+' : ''}${semitones.toFixed(2)} st`;
			cutClips.push({ video: pick.video, rec, in: pick.start, out: pick.start + segmentDur, name: `${pick.word} ${shiftLabel}` });
			cutMarkers.push({
				t: rec,
				name: `note ${i + 1}/${transposedMelody.length} ${midiToName(effectiveTarget)}`,
				note: `${clipId(pick.video)} ${pick.start.toFixed(2)}; pitch ${shiftLabel} (${midiToName(pick.pitchMidi)} -> ${midiToName(effectiveTarget)})${pick.person ? ` · ${pick.person} asd ${(pick.asd ?? 0).toFixed(2)}` : ''}`,
			});
			rec += renderedDuration(segmentDur);
		}
		await renderSegments(
			picks.map((pick, i) => async (renderSignal, segmentLog) => {
				segmentLog('note');
				await renderNote(
					pick,
					effectiveTargets[i],
					noteSeconds,
					segments[i].path,
					segmentLog,
					renderSignal,
				);
				return segments[i];
			}),
			{ onLog, signal },
		);

		const stamp = timestampSuffix();
		const bucketTag = buckets.length > 1 ? 'mixed' : buckets[0].name;
		const outFile = join(outDir, `${slug}${castSuffix}-song-${bucketTag}-${stamp}.mp4`);
		onLog(`Concatenating -> ${outFile}`);
		await concatSegments(segments, outFile, workDir, onLog, signal);

		// The render's cut list, for editor export. A failure here shouldn't lose the render.
		let cutsFile: string | null = null;
		try {
			cutsFile = resolvePath(await writeCutList(outFile, 'songify', cutClips, [], cutMarkers));
			onLog(`Cut list: ${cutsFile}`);
		} catch (err) {
			onLog(`Warning: could not write the cut list: ${err instanceof Error ? err.message : err}`);
		}

		onLog(`Done: ${outFile}`);
		return {
			outFile: resolvePath(outFile),
			cutsFile,
			notes: picks.length,
			naturalRange: { minHz: midiToHz(minMidi), maxHz: midiToHz(maxMidi) },
		};
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
