/**
 * Export, render queue, and interchange output.
 *
 * Each entry declares the tool an agent sees and the handler that runs it,
 * so the two cannot drift apart. Handlers reach Premiere through ToolContext.
 */
import { z } from 'zod';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, parse } from 'node:path';
import type { ToolContext, ToolModule } from '../context.js';
import { EncoderPresetEntry, getEncoderPresets, inspectEncoderPreset } from './discovery.js';

export const exportTools: ToolModule[] = [
  {
    name: 'export_sequence',
    description: 'Renders and exports a sequence to a video file. This is for creating the final video.',
    inputSchema: z.object({
      sequenceId: z.string().describe('The ID of the sequence to export'),
      outputPath: z.string().describe('The absolute path where the final video file will be saved'),
      presetPath: z.string().optional().describe('Absolute path to an export preset file (.epr). When omitted, format selects a matching installed AME system preset.'),
      presetName: z.string().optional().describe('Exact preset display name or filename stem. When format is also set, only presets matching that format are considered.'),
      sourceRange: z.enum(['entire', 'in_out', 'work_area']).optional().describe('Export source range. Defaults to entire. Requested ranges are never silently substituted.'),
      allowOverwrite: z.boolean().optional().describe('Allow writing to an existing output file. Defaults to false.'),
      removeOnCompletion: z.boolean().optional().describe('Pass AME removeOnCompletion. Defaults to true to preserve existing queue behavior.'),
      format: z.string().optional().describe('Requested export format, for example mp4 (default), mov, mxf, h264, hevc, prores, dnxhd, dnxhr, avi, flv, wmv, mpeg2, wav, aiff, mp3, aac, png, tiff, jpeg, gif, dpx, or exr. Explicit format is validated against presetPath or presetName and used to choose a system preset when neither is supplied.'),
      quality: z.enum(['low', 'medium', 'high', 'maximum']).optional().describe('Deprecated hint only; the .epr preset controls quality.'),
      resolution: z.string().optional().describe('Deprecated hint only; the .epr preset controls resolution.')
    }),
    run: (ctx, args) => exportSequence(ctx, { sequenceId: args.sequenceId, outputPath: args.outputPath, presetPath: args.presetPath, presetName: args.presetName, sourceRange: args.sourceRange, allowOverwrite: args.allowOverwrite, removeOnCompletion: args.removeOnCompletion, format: args.format, quality: args.quality, resolution: args.resolution }),
  },
  {
    name: 'export_frame',
    description: 'Exports a single frame from a sequence as an image file.',
    inputSchema: z.object({
      sequenceId: z.string().describe('The ID of the sequence'),
      time: z.number().describe('The time in seconds to export the frame from'),
      outputPath: z.string().describe('The absolute path where the image file will be saved'),
      format: z.enum(['png', 'jpg', 'tiff']).optional().describe('The image format')
    }),
    run: (ctx, args) => exportFrame(ctx, args.sequenceId, args.time, args.outputPath, args.format),
  },
  {
    name: 'add_to_render_queue',
    description: 'Adds a sequence to the Adobe Media Encoder render queue.',
    inputSchema: z.object({
      sequenceId: z.string().describe('The ID of the sequence to render'),
      outputPath: z.string().describe('Output file path'),
      presetPath: z.string().optional().describe('Export preset file path'),
      presetName: z.string().optional().describe('Exact preset display name or filename stem. When format is also set, only presets matching that format are considered.'),
      sourceRange: z.enum(['entire', 'in_out', 'work_area']).optional().describe('Export source range. Defaults to entire.'),
      allowOverwrite: z.boolean().optional().describe('Allow writing to an existing output file. Defaults to false.'),
      removeOnCompletion: z.boolean().optional().describe('Pass AME removeOnCompletion. Defaults to true.'),
      startImmediately: z.boolean().optional().describe('Whether to start rendering immediately (default: false)'),
      format: z.string().optional().describe('Requested export format. Defaults to the outputPath extension when it is recognised, otherwise mp4.')
    }),
    run: (ctx, args) => addToRenderQueue(ctx, { sequenceId: args.sequenceId, outputPath: args.outputPath, presetPath: args.presetPath, presetName: args.presetName, sourceRange: args.sourceRange, allowOverwrite: args.allowOverwrite, removeOnCompletion: args.removeOnCompletion, startImmediately: args.startImmediately, format: args.format }),
  },
  {
    name: 'get_render_queue_status',
    description: 'Reports whether render queue monitoring is available. This currently returns guidance for Adobe Media Encoder rather than live queue telemetry.',
    inputSchema: z.object({}),
    run: (_ctx) => getRenderQueueStatus(),
  },
  {
    name: 'export_as_fcp_xml',
    description: 'Exports a sequence as Final Cut Pro XML.',
    inputSchema: z.object({
      sequenceId: z.string().describe('The ID of the sequence to export'),
      outputPath: z.string().describe('The absolute file path for the exported XML file')
    }),
    run: (ctx, args) => exportAsFcpXml(ctx, args.sequenceId, args.outputPath),
  },
  {
    name: 'export_aaf',
    description: 'Exports a sequence as an AAF file for interchange with other editing/audio applications.',
    inputSchema: z.object({
      sequenceId: z.string().describe('The ID of the sequence to export'),
      outputPath: z.string().describe('The absolute file path for the exported AAF file'),
      mixDownVideo: z.boolean().optional().describe('Whether to mix down video (default: true)'),
      explodeToMono: z.boolean().optional().describe('Whether to explode audio to mono (default: false)'),
      sampleRate: z.number().optional().describe('Audio sample rate (default: 48000)'),
      bitsPerSample: z.number().optional().describe('Audio bits per sample (default: 16)')
    }),
    run: (ctx, args) => exportAaf(ctx, args.sequenceId, args.outputPath, args.mixDownVideo, args.explodeToMono, args.sampleRate, args.bitsPerSample),
  },
];

type ExportSourceRange = 'entire' | 'in_out' | 'work_area';

interface ExportSequenceArgs {
  sequenceId: string;
  outputPath: string;
  presetPath?: string;
  presetName?: string;
  sourceRange?: ExportSourceRange;
  allowOverwrite?: boolean;
  removeOnCompletion?: boolean;
  format?: string;
  quality?: string;
  resolution?: string;
}

interface AddToRenderQueueArgs extends ExportSequenceArgs {
  startImmediately?: boolean;
}

const FORMAT_ALIASES: Record<string, string> = {
  mp4: 'mp4',
  m4v: 'mp4',
  mpeg4: 'mp4',
  'mpeg-4': 'mp4',
  '3gp': 'mp4',
  mov: 'mov',
  quicktime: 'mov',
  qt: 'mov',
  avi: 'avi',
  mxf: 'mxf',
  'mxf-op1a': 'mxf',
  op1a: 'mxf',
  dcp: 'dcp',
  flv: 'flv',
  wmv: 'wmv',
  mpg: 'mpeg2',
  mpeg: 'mpeg2',
  mpeg2: 'mpeg2',
  'mpeg-2': 'mpeg2',
  h264: 'h264',
  'h.264': 'h264',
  avc: 'h264',
  x264: 'h264',
  hevc: 'hevc',
  h265: 'hevc',
  'h.265': 'hevc',
  hvc1: 'hevc',
  prores: 'prores',
  appleprores: 'prores',
  prores422: 'prores',
  dnx: 'dnx',
  dnxhd: 'dnxhd',
  dnxhr: 'dnxhr',
  avcintra: 'avcintra',
  'avc-intra': 'avcintra',
  xavc: 'xavc',
  xdcam: 'xdcam',
  hdv: 'hdv',
  dv: 'dv',
  wav: 'wav',
  wave: 'wav',
  pcm: 'pcm',
  aiff: 'aiff',
  aif: 'aiff',
  mp3: 'mp3',
  aac: 'aac',
  m4a: 'aac',
  png: 'png',
  tiff: 'tiff',
  tif: 'tiff',
  jpeg: 'jpeg',
  jpg: 'jpeg',
  bmp: 'bmp',
  dpx: 'dpx',
  exr: 'exr',
  openexr: 'exr',
  tga: 'tga',
  targa: 'tga',
  gif: 'gif',
};

const FORMAT_EXTENSIONS: Record<string, string[]> = {
  mp4: ['.mp4', '.m4v'],
  mov: ['.mov', '.qt'],
  avi: ['.avi'],
  mxf: ['.mxf'],
  dcp: ['.dcp'],
  flv: ['.flv'],
  wmv: ['.wmv'],
  mpeg2: ['.mpg', '.mpeg', '.m2v', '.vob'],
  h264: ['.mp4', '.m4v', '.mov'],
  hevc: ['.mp4', '.m4v', '.mov'],
  prores: ['.mov', '.mxf'],
  dnx: ['.mxf', '.mov'],
  dnxhd: ['.mxf', '.mov'],
  dnxhr: ['.mxf', '.mov'],
  avcintra: ['.mxf'],
  xavc: ['.mxf'],
  xdcam: ['.mxf'],
  hdv: ['.m2t', '.m2ts', '.ts'],
  dv: ['.avi', '.mov', '.mxf'],
  wav: ['.wav'],
  pcm: ['.pcm', '.raw', '.wav', '.aif', '.aiff'],
  aiff: ['.aif', '.aiff'],
  mp3: ['.mp3'],
  aac: ['.aac', '.m4a'],
  png: ['.png'],
  tiff: ['.tif', '.tiff'],
  jpeg: ['.jpg', '.jpeg'],
  bmp: ['.bmp'],
  dpx: ['.dpx'],
  exr: ['.exr'],
  tga: ['.tga'],
  gif: ['.gif'],
};

const OUTPUT_EXTENSION_FORMATS: Record<string, string> = {
  '.mp4': 'mp4',
  '.m4v': 'mp4',
  '.mov': 'mov',
  '.qt': 'mov',
  '.avi': 'avi',
  '.mxf': 'mxf',
  '.dcp': 'dcp',
  '.flv': 'flv',
  '.wmv': 'wmv',
  '.mpg': 'mpeg2',
  '.mpeg': 'mpeg2',
  '.m2v': 'mpeg2',
  '.vob': 'mpeg2',
  '.m2t': 'hdv',
  '.m2ts': 'hdv',
  '.ts': 'hdv',
  '.wav': 'wav',
  '.aif': 'aiff',
  '.aiff': 'aiff',
  '.mp3': 'mp3',
  '.aac': 'aac',
  '.m4a': 'aac',
  '.pcm': 'pcm',
  '.raw': 'pcm',
  '.png': 'png',
  '.tif': 'tiff',
  '.tiff': 'tiff',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.bmp': 'bmp',
  '.dpx': 'dpx',
  '.exr': 'exr',
  '.tga': 'tga',
  '.gif': 'gif',
};

const VIDEO_FORMATS = new Set([
  'mp4',
  'mov',
  'avi',
  'mxf',
  'dcp',
  'flv',
  'wmv',
  'mpeg2',
  'h264',
  'hevc',
  'prores',
  'dnx',
  'dnxhd',
  'dnxhr',
  'avcintra',
  'xavc',
  'xdcam',
  'hdv',
  'dv',
  'gif',
]);

function normalizeRequestedFormat(value?: string): string | undefined {
  if (!value || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return FORMAT_ALIASES[normalized] ?? normalized;
}

function formatFromOutputExtension(outputPath: string): string | undefined {
  return OUTPUT_EXTENSION_FORMATS[extname(outputPath).toLowerCase()];
}

function supportedPresetFormats(presets: EncoderPresetEntry[]): string[] {
  const formats = [...new Set(Object.values(FORMAT_ALIASES))];
  return formats
    .filter((format) => presets.some((preset) => presetMatchesFormat(preset, format)))
    .sort();
}

function presetMatchesFormat(preset: EncoderPresetEntry, requestedFormat: string): boolean {
  const format = normalizeRequestedFormat(requestedFormat) ?? requestedFormat;
  const tags = new Set((preset.formatTags ?? []).map((tag) => normalizeRequestedFormat(tag) ?? tag));
  if (VIDEO_FORMATS.has(format) && preset.hasVideo === false) return false;
  if (format === 'dv') {
    return preset.exporterFileType === 'AVIV' && (tags.has('dv') || preset.container === 'avi');
  }
  if (format === 'pcm') {
    return preset.exporterFileType === 'PCM' || tags.has('pcm');
  }
  if (tags.has(format)) return true;

  switch (format) {
    case 'mp4':
      return preset.container === 'mp4';
    case 'mov':
      return preset.container === 'mov';
    case 'avi':
      return preset.container === 'avi';
    case 'mxf':
      return preset.container === 'mxf';
    case 'dcp':
      return preset.container === 'dcp';
    case 'flv':
      return preset.container === 'flv';
    case 'wmv':
      return preset.container === 'wmv';
    case 'mpeg2':
      return preset.container === 'mpeg2';
    case 'h264':
      return tags.has('h264') || preset.exporterFileType === 'H264';
    case 'hevc':
      return tags.has('hevc') || preset.exporterFileType === 'HEVC';
    case 'prores':
      return tags.has('prores') || tags.has('appleprores');
    case 'dnx':
      return tags.has('dnx');
    case 'dnxhd':
      return tags.has('dnxhd') && !tags.has('dnxhr');
    case 'dnxhr':
      return tags.has('dnxhr');
    case 'avcintra':
      return tags.has('avcintra');
    case 'xavc':
      return tags.has('xavc');
    case 'xdcam':
      return tags.has('xdcam');
    case 'hdv':
      return tags.has('hdv');
    case 'dv':
      return tags.has('dv');
    default:
      return false;
  }
}

function presetFormatScore(preset: EncoderPresetEntry, requestedFormat: string): number {
  const format = normalizeRequestedFormat(requestedFormat) ?? requestedFormat;
  const name = preset.name.toLowerCase();
  const text = `${preset.name} ${preset.path}`.toLowerCase();
  let score = preset.source === 'system' ? 10000 : 1000;

  score += presetMatchesFormat(preset, format) ? 1000 : 0;
  if (/match source/.test(text)) score += 500;
  if (/\b(?:00|01)\b/.test(name)) score += 60;
  if (/high bitrate|high quality|highest quality/.test(text)) score += 120;

  if (format === 'mp4' || format === 'h264') {
    if (preset.exporterFileType === 'H264') score += 800;
    if (/\b00\b/.test(name) && /match source/.test(text)) score += 250;
    if (/high bitrate/.test(text)) score += 80;
  }
  if (format === 'hevc') {
    if (preset.exporterFileType === 'HEVC') score += 800;
    if (/high bitrate/.test(text)) score += 80;
  }
  if (format === 'mov' && /\b01\b/.test(name) && /match source/.test(text)) score += 300;
  if (format === 'prores' && /apple prores 422 hq/.test(text)) score += 500;
  if (format === 'prores' && /^apple prores 422 hq\b/.test(name)) score += 300;
  if (format === 'prores' && /adobe stock/.test(text)) score -= 200;
  if (format === 'dnx' && /dnx hq|match source/.test(text)) score += 300;
  if (format === 'dnxhd' && /dnx hq/.test(text)) score += 400;
  if (format === 'dnxhr' && /dnxhr hq/.test(text)) score += 400;
  if (format === 'mxf' && /match source/.test(text)) score += 250;
  if (format === 'wav' && /waveform|48khz|16-bit/.test(text)) score += 250;
  if (format === 'mp3' && /192|256|high quality/.test(text)) score += 180;
  if (format === 'png' && /match source/.test(text) && !/alpha/.test(text)) score += 120;
  if (format === 'dv') {
    if (preset.exporterFileType === 'AVIV') score += 800;
    if (/^ntsc dv$/.test(name)) score += 500;
    else if (/^pal dv$/.test(name)) score += 450;
    else if (/widescreen/.test(name)) score += 100;
    if (/24p/.test(name)) score -= 100;
  }
  if (format === 'mpeg2') {
    if (preset.exporterFileType === 'mpg2') score += 900;
    if (preset.exporterFileType === 'dvd') score -= 700;
    if (preset.exporterFileType === 'mbd') score -= 300;
  }
  if (format === 'wmv') {
    if (/1080p/.test(name)) score += 300;
    else if (/720p/.test(name)) score += 200;
    if (/29\.97/.test(name)) score += 60;
    if (/half|ntsc dv|pal dv/.test(name)) score -= 250;
  }
  if (format === 'gif') {
    if (/^animated gif/.test(name)) score += 900;
    else if (/sequence/.test(name)) score -= 900;
    if (/transparency/.test(name)) score -= 30;
  }
  if (format === 'flv') {
    if (/1920x1080/.test(name)) score += 250;
    else if (/640x480/.test(name)) score -= 250;
    if (/29\.97/.test(name)) score += 40;
  }

  if (/proxy|\blb\b|low bitrate|medium bitrate|draft|middle|mono|stereo/.test(text)) score -= 220;
  if (/hlg|\bpq\b|2020|alpha/.test(text)) score -= 120;
  if (/without audio/.test(text)) score -= 30;
  return score;
}

function chooseFormatPreset(presets: EncoderPresetEntry[], requestedFormat: string): EncoderPresetEntry | undefined {
  const matches = presets.filter((preset) => presetMatchesFormat(preset, requestedFormat));
  return matches
    .slice()
    .sort((left, right) => {
      const scoreDifference = presetFormatScore(right, requestedFormat) - presetFormatScore(left, requestedFormat);
      if (scoreDifference !== 0) return scoreDifference;
      return left.path.localeCompare(right.path);
    })[0];
}

async function resolvePresetPath(
  presetPath?: string,
  presetName?: string,
  requestedFormat?: string,
): Promise<
  { success: true; presetPath: string; presetName?: string; presetResolution?: any } |
  { success: false; error: string; presetName?: string; matches?: EncoderPresetEntry[]; searchedDirectories?: string[]; availableFormats?: string[] }
> {
  if (presetPath && presetName) {
    return { success: false, error: 'Provide either presetPath or presetName, not both.', presetName };
  }

  if (presetPath) {
    if (requestedFormat) {
      try {
        const preset = await inspectEncoderPreset(presetPath);
        if (!presetMatchesFormat(preset, requestedFormat)) {
          const detected = preset.container ?? preset.exporterFileType ?? 'unknown';
          return {
            success: false,
            error: `presetPath "${presetPath}" is a ${detected} preset, but format "${requestedFormat}" was requested. Pass a matching preset or omit format to let the preset control the output.`,
            matches: [preset],
          };
        }
      } catch (error) {
        return {
          success: false,
          error: `Could not inspect presetPath "${presetPath}" while validating format "${requestedFormat}": ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return { success: true, presetPath };
  }

  const discovery = await getEncoderPresets();
  const availableFormats = supportedPresetFormats(discovery.presets);
  if (!presetName) {
    const format = requestedFormat ?? 'mp4';
    const match = chooseFormatPreset(discovery.presets, format);
    if (!match) {
      return {
        success: false,
        error: `No discovered .epr preset matches format "${format}". Available discovered formats: ${availableFormats.join(', ') || 'none'}. Install or save a matching AME preset, or pass presetPath.`,
        searchedDirectories: discovery.searchedDirectories,
        availableFormats,
      };
    }
    return {
      success: true,
      presetPath: match.path,
      presetName: match.name,
      presetResolution: {
        method: 'format_default',
        requestedFormat: format,
        name: match.name,
        path: match.path,
        source: match.source,
        container: match.container,
        exporterFileType: match.exporterFileType,
        ameVersion: match.ameVersion,
      },
    };
  }

  const namedMatches = discovery.presets.filter(
    (preset) => preset.name === presetName || parse(preset.path).name === presetName,
  );
  const matches = requestedFormat
    ? namedMatches.filter((preset) => presetMatchesFormat(preset, requestedFormat))
    : namedMatches;
  if (matches.length === 1) {
    const [match] = matches as [EncoderPresetEntry];
    return {
      success: true,
      presetPath: match.path,
      presetName,
      presetResolution: {
        method: 'exact_name',
        name: match.name,
        path: match.path,
        source: match.source,
        container: match.container,
        exporterFileType: match.exporterFileType,
        requestedFormat,
        ameVersion: match.ameVersion,
      },
    };
  }
  if (matches.length > 1) {
    return {
      success: false,
      error: `presetName "${presetName}" is ambiguous; pass presetPath instead.`,
      presetName,
      matches,
      searchedDirectories: discovery.searchedDirectories,
      availableFormats,
    };
  }
    const failure: {
      success: false;
      error: string;
      presetName: string;
      searchedDirectories: string[];
      availableFormats: string[];
      matches?: EncoderPresetEntry[];
    } = {
      success: false,
      error: requestedFormat
        ? `presetName "${presetName}" was not found for format "${requestedFormat}" in discovered AME presets.`
        : `presetName "${presetName}" was not found in discovered AME presets.`,
      presetName,
      searchedDirectories: discovery.searchedDirectories,
      availableFormats,
    };
    if (namedMatches.length > 0) failure.matches = namedMatches;
    return failure;
}

async function validateExportPaths(
  outputPath: string,
  presetPath: string,
  allowOverwrite = false,
  requestedFormat?: string,
): Promise<Array<{ code: string; message: string; path?: string }>> {
  const errors: Array<{ code: string; message: string; path?: string }> = [];

  if (!isAbsolute(presetPath)) {
    errors.push({ code: 'PRESET_PATH_NOT_ABSOLUTE', message: 'presetPath must be an absolute .epr path.', path: presetPath });
  } else if (extname(presetPath).toLowerCase() !== '.epr') {
    errors.push({ code: 'PRESET_EXTENSION', message: 'presetPath must point to a .epr file.', path: presetPath });
  } else {
    try {
      await fs.access(presetPath, fsConstants.R_OK);
    } catch {
      errors.push({ code: 'PRESET_NOT_READABLE', message: 'Export preset file does not exist or is not readable.', path: presetPath });
    }
  }

  if (!isAbsolute(outputPath)) {
    errors.push({ code: 'OUTPUT_PATH_NOT_ABSOLUTE', message: 'outputPath must be absolute.', path: outputPath });
  } else {
    const normalizedFormat = normalizeRequestedFormat(requestedFormat);
    const outputExtension = extname(outputPath).toLowerCase();
    if (normalizedFormat && outputExtension) {
      const expectedExtensions = FORMAT_EXTENSIONS[normalizedFormat];
      if (expectedExtensions && !expectedExtensions.includes(outputExtension)) {
        errors.push({
          code: 'OUTPUT_FORMAT_MISMATCH',
          message: `outputPath ends in ${outputExtension}, which does not match requested format "${normalizedFormat}". Expected ${expectedExtensions.join(' or ')}.`,
          path: outputPath,
        });
      }
    }

    const outputDirectory = dirname(outputPath);
    try {
      const stat = await fs.stat(outputDirectory);
      if (!stat.isDirectory()) {
        errors.push({ code: 'OUTPUT_FOLDER_NOT_DIRECTORY', message: 'Output parent path is not a directory.', path: outputDirectory });
      }
    } catch {
      errors.push({ code: 'OUTPUT_FOLDER_NOT_FOUND', message: 'Output parent folder does not exist.', path: outputDirectory });
    }

    try {
      await fs.access(outputPath, fsConstants.F_OK);
      if (!allowOverwrite) {
        errors.push({ code: 'OUTPUT_EXISTS', message: 'Output file already exists; pass allowOverwrite:true to replace it.', path: outputPath });
      }
    } catch {
      // Missing output file is the normal export case.
    }
  }

  return errors;
}

function deprecatedExportOptionWarnings(quality?: string, resolution?: string): Array<{ code: string; message: string; value?: string }> {
  const warnings: Array<{ code: string; message: string; value?: string }> = [];
  if (quality) warnings.push({ code: 'QUALITY_IGNORED', message: 'quality is deprecated for export_sequence; the .epr preset controls export quality.', value: quality });
  if (resolution) warnings.push({ code: 'RESOLUTION_IGNORED', message: 'resolution is deprecated for export_sequence; the .epr preset controls output dimensions.', value: resolution });
  return warnings;
}

interface ExportArtifact {
  path: string;
  kind: 'file' | 'directory';
  size: number | null;
  modifiedAt: number;
  isRequestedPath: boolean;
}

/**
 * A .epr preset controls the real container. Adobe presets can therefore write
 * `requested.mp4` as `requested.mov`, or as a folder bundle with the requested
 * stem. Verify the immediate output directory after a direct render instead of
 * reporting the requested suffix as the produced artifact.
 */
async function findExportArtifact(outputPath: string, sinceMs: number): Promise<ExportArtifact | null> {
  const outputDirectory = dirname(outputPath);
  const requestedName = basename(outputPath);
  const requestedStem = parse(requestedName).name;
  const requestedLower = requestedName.toLowerCase();
  const requestedStemLower = requestedStem.toLowerCase();

  let entries;
  try {
    entries = await fs.readdir(outputDirectory, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: ExportArtifact[] = [];
  for (const entry of entries) {
    const lowerName = entry.name.toLowerCase();
    const isRequestedPath = lowerName === requestedLower;
    if (!isRequestedPath) {
      if (lowerName.startsWith('.') || lowerName.endsWith('.xmp')) continue;
      if (parse(entry.name).name.toLowerCase() !== requestedStemLower) continue;
    }

    const artifactPath = join(outputDirectory, entry.name);
    let stat;
    try {
      stat = await fs.stat(artifactPath);
    } catch {
      continue;
    }

    // An exact requested path may legitimately predate the call when
    // allowOverwrite was explicitly requested. Same-stem variants must be
    // recent, otherwise an old sibling file could be mistaken for this render.
    if (!isRequestedPath && stat.mtimeMs < sinceMs - 1500) continue;

    candidates.push({
      path: artifactPath,
      kind: stat.isDirectory() ? 'directory' : 'file',
      size: stat.isFile() ? stat.size : null,
      modifiedAt: stat.mtimeMs,
      isRequestedPath,
    });
  }

  candidates.sort((left, right) => {
    if (left.isRequestedPath !== right.isRequestedPath) return left.isRequestedPath ? -1 : 1;
    if (left.kind !== right.kind) return left.kind === 'file' ? -1 : 1;
    return right.modifiedAt - left.modifiedAt;
  });
  return candidates[0] ?? null;
}

interface FormatSelection {
  format?: string;
  source: 'explicit' | 'output_extension' | 'default' | 'preset';
  error?: string;
  availableFormats?: string[];
}

function selectExportFormat(
  format: string | undefined,
  outputPath: string,
  hasPreset: boolean,
): FormatSelection {
  if (format?.trim()) {
    const normalized = normalizeRequestedFormat(format)!;
    if (!Object.prototype.hasOwnProperty.call(FORMAT_ALIASES, normalized)) {
      return {
        source: 'explicit',
        error: `Unsupported format "${format}". Supported values include: ${[...new Set(Object.values(FORMAT_ALIASES))].sort().join(', ')}.`,
        availableFormats: [...new Set(Object.values(FORMAT_ALIASES))].sort(),
      };
    }
    return { format: normalized, source: 'explicit' };
  }

  if (hasPreset) return { source: 'preset' };

  const inferred = formatFromOutputExtension(outputPath);
  if (inferred) return { format: inferred, source: 'output_extension' };
  if (extname(outputPath) === '') return { format: 'mp4', source: 'default' };

  return {
    source: 'default',
    error: `Could not infer an export format from outputPath "${outputPath}". Pass format explicitly or use a recognised extension such as .mp4, .mov, .mxf, .wav, or .png.`,
    availableFormats: [...new Set(Object.values(FORMAT_ALIASES))].sort(),
  };
}

async function exportSequence(ctx: ToolContext, args: ExportSequenceArgs): Promise<any> {
  const {
    sequenceId,
    outputPath,
    presetName,
    sourceRange = 'entire',
    allowOverwrite = false,
    removeOnCompletion = true,
    format,
    quality,
    resolution,
  } = args;
  const formatSelection = selectExportFormat(format, outputPath, Boolean(args.presetPath || presetName));
  if (formatSelection.error) {
    return {
      success: false,
      error: formatSelection.error,
      sequenceId,
      outputPath,
      requestedFormat: format,
      availableFormats: formatSelection.availableFormats,
    };
  }
  const effectiveFormat = formatSelection.format;

  // app.encoder.encodeSequence() expects an absolute path to a .epr preset file.
  // A format string is only used to discover a real .epr; it is never passed
  // to Adobe as a preset name.
  const presetResolution = await resolvePresetPath(args.presetPath, presetName, effectiveFormat);
  if (!presetResolution.success) {
    return {
      success: false,
      error: presetResolution.error,
      hint: effectiveFormat && !args.presetPath && !presetName
        ? `No installed system preset matched format "${effectiveFormat}". Install Adobe Media Encoder, refresh its system presets, or pass a matching presetPath.`
        : 'Create or select a matching .epr preset and pass its absolute path as presetPath.',
      sequenceId,
      outputPath,
      presetName,
      matches: presetResolution.matches,
      searchedDirectories: presetResolution.searchedDirectories,
      availableFormats: presetResolution.availableFormats,
      requestedFormat: format,
      format: effectiveFormat,
      formatSource: formatSelection.source,
      quality,
      resolution,
    };
  }
  const presetPath = presetResolution.presetPath;

  const pathErrors = await validateExportPaths(outputPath, presetPath, allowOverwrite, effectiveFormat);
  const warnings = deprecatedExportOptionWarnings(quality, resolution);
  if (pathErrors.length > 0) {
    return {
      success: false,
      error: pathErrors.map((pathError) => pathError.message).join(' '),
      errors: pathErrors,
      warnings,
      sequenceId,
      outputPath,
      presetPath,
      presetName,
      sourceRange,
      allowOverwrite,
      requestedFormat: format,
      format: effectiveFormat,
      formatSource: formatSelection.source,
      quality,
      resolution,
    };
  }

  try {
    const exportStartedAt = Date.now();
    // bridge.renderSequence returns a structured response; propagate it instead
    // of unconditionally claiming success. Pre-fix wrapper reported success even
    // when AME never received the job (false-success false positives).
    const result = await ctx.bridge.renderSequence(sequenceId, outputPath, presetPath, {
      sourceRange,
      removeOnCompletion,
    });

    if (result && result.success === false) {
      return {
        ...result,
        sequenceId,
        outputPath,
        presetPath,
        presetName,
        presetResolution: presetResolution.presetResolution,
        sourceRange,
        allowOverwrite,
        warnings: [...warnings, ...(result.warnings ?? [])],
        requestedFormat: format,
        format: effectiveFormat,
        formatSource: formatSelection.source,
        quality,
        resolution,
      };
    }

    const artifact = await findExportArtifact(outputPath, exportStartedAt);
    const bridgeReportedOutput = result?.outputExists === true;
    const requestedOutputExists = bridgeReportedOutput || artifact?.isRequestedPath === true;
    const artifactPath = artifact?.path ?? (bridgeReportedOutput ? outputPath : undefined);
    const artifactExists = Boolean(artifactPath);
    const renderedDirectly =
      result?.rendered === true ||
      result?.method === 'exportAsMediaDirect' ||
      result?.status === 'rendered';
    const artifactExtension = artifactPath && artifact?.kind === 'file'
      ? extname(artifactPath).toLowerCase()
      : undefined;
    const requestedExtension = extname(outputPath).toLowerCase();
    const extensionMismatch = Boolean(
      artifactExtension &&
      requestedExtension &&
      artifactExtension !== requestedExtension &&
      !requestedOutputExists
    );
    const finalWarnings: Array<{ code: string; message: string; value?: string }> = [
      ...warnings,
      ...(result?.warnings ?? []),
    ];
    if (extensionMismatch && artifactPath) {
      finalWarnings.push({
        code: 'EXPORT_EXTENSION_MISMATCH',
        message: `The .epr preset wrote ${artifactPath} instead of the requested ${outputPath}. Probe the actual artifact path.`,
        value: artifactPath,
      });
    }
    if (renderedDirectly && !artifactExists) {
      finalWarnings.push({
        code: 'EXPORT_ARTIFACT_NOT_FOUND',
        message: 'Premiere reported a direct render, but no requested or same-stem artifact was found in the output directory. Inspect the directory before reporting completion.',
        value: outputPath,
      });
      return {
        success: false,
        status: 'unverified',
        error: 'Premiere reported a successful direct render, but no output artifact could be verified on disk.',
        sequenceId,
        outputPath,
        presetPath,
        presetName,
        presetResolution: presetResolution.presetResolution,
        sourceRange,
        resolvedRange: result?.resolvedRange,
        method: result?.method,
        rendered: true,
        directResult: result?.directResult,
        requestedOutputExists,
        artifactExists: false,
        artifactPath: undefined,
        outputExists: false,
        allowOverwrite,
        warnings: finalWarnings,
        requestedFormat: format,
        format: effectiveFormat,
        formatSource: formatSelection.source,
        verify: `Get-ChildItem -LiteralPath '${dirname(outputPath)}' | Sort-Object LastWriteTime -Descending | Select-Object -First 20`,
      };
    }

    return {
      success: true,
      status: result?.status ?? 'queued',
      message: renderedDirectly
        ? `Sequence rendered directly by Premiere. Verified artifact: ${artifactPath ?? outputPath}.`
        : `Sequence queued in Adobe Media Encoder${effectiveFormat ? ` for requested format "${effectiveFormat}"` : ''}. The selected .epr preset is "${presetName ?? presetResolution.presetName ?? presetPath}"; verify the actual artifact.`,
      sequenceId,
      outputPath,
      presetPath,
      presetName,
      presetResolution: presetResolution.presetResolution,
      sourceRange,
      resolvedRange: result?.resolvedRange,
      encoderRangeConstant: result?.encoderRangeConstant,
      method: result?.method,
      rendered: result?.rendered ?? renderedDirectly,
      directAttempted: result?.directAttempted,
      directResult: result?.directResult,
      requestedOutputExists,
      artifactExists,
      artifactPath,
      artifactKind: artifact?.kind,
      artifactExtensionMismatch: extensionMismatch,
      outputExists: artifactExists || bridgeReportedOutput,
      directWorkAreaType: result?.directWorkAreaType,
      mediaEncoderAvailable: result?.mediaEncoderAvailable,
      removeOnCompletion,
      requestedFormat: format,
      format: effectiveFormat,
      formatSource: formatSelection.source,
      quality,
      resolution,
      warnings: finalWarnings,
      jobID: result?.jobID,
      queued: result?.queued,
      queueStarted: result?.queueStarted,
      verify: renderedDirectly
        ? `ffprobe -show_entries format=duration,size '${artifactPath ?? outputPath}'`
        : `Get-ChildItem -LiteralPath '${dirname(outputPath)}' | Sort-Object LastWriteTime -Descending | Select-Object -First 10; # then ffprobe the actual file (the preset may change the extension)`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to export sequence: ${error instanceof Error ? error.message : String(error)}`,
      sequenceId,
      outputPath,
    };
  }
}

async function exportFrame(ctx: ToolContext, sequenceId: string, time: number, outputPath: string, format = 'png'): Promise<any> {
  const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });

        if (sequence.openInTimeline) {
          try { sequence.openInTimeline(); } catch (e0) {}
        }

        // Resolve the QE handle for the sequence the caller named. Reaching for
        // qe.project.getActiveSequence() here exported whatever happened to be
        // open in the timeline instead: asking for a non-active sequence
        // returned success, echoed back the requested sequenceId, and wrote a
        // frame of the active sequence's content.
        var qeSequence = __qeSequenceForRetry(sequence);
        if (!qeSequence) {
          return JSON.stringify({
            success: false,
            error: "Could not address sequence '" + sequence.name + "' through the QE API, which frame export requires. Open it in a timeline and retry."
          });
        }

        var methodName = ${JSON.stringify(format)} === "jpg" ? "exportFrameJPEG" : (${JSON.stringify(format)} === "tiff" ? "exportFrameTiff" : "exportFramePNG");
        if (typeof qeSequence[methodName] !== "function") {
          return JSON.stringify({
            success: false,
            error: "Frame export format '" + ${JSON.stringify(format)} + "' is not supported by the available Premiere API"
          });
        }

        var timeNumber = ${time};
        var timeString = String(timeNumber);
        var timeTicks = timeString;
        try {
          var exportTime = new Time();
          exportTime.seconds = timeNumber;
          timeTicks = exportTime.ticks;
        } catch (e1) {}
        var fps = 30;
        try {
          fps = sequence.timebase ? (254016000000 / parseInt(sequence.timebase, 10)) : 30;
        } catch (eFps) {}
        var timeCode = __secondsToTimecode(timeNumber, fps);

        // Premiere's exportFrame* methods always append "." + format to the
        // path they are handed, so passing the caller's "shot.png" wrote
        // "shot.png.png" while the tool reported "shot.png" — a path with no
        // file at it. Hand Premiere the stem and let it add the extension back,
        // so the frame lands exactly where the caller asked.
        var formatExtension = ${JSON.stringify(format)} === "jpg"
          ? ".jpg"
          : (${JSON.stringify(format)} === "tiff" ? ".tiff" : ".png");
        var requestedPath = ${JSON.stringify(outputPath)};
        var exportStem = requestedPath;
        if (requestedPath.length > formatExtension.length) {
          var tail = requestedPath.substring(requestedPath.length - formatExtension.length);
          if (tail.toLowerCase() === formatExtension) {
            exportStem = requestedPath.substring(0, requestedPath.length - formatExtension.length);
          }
        }

        // Where the frame should land, and where it would land if some future
        // version stopped appending the extension.
        var candidatePaths = [exportStem + formatExtension, requestedPath];

        // A non-throwing call is not proof that a file was written, so record
        // what is on disk first. Comparing modification stamps rather than mere
        // existence keeps a stale file from an earlier run from being reported
        // as this call's output.
        var beforeState = [];
        for (var p = 0; p < candidatePaths.length; p++) {
          var state = { existed: false, stamp: 0, length: -1 };
          try {
            var probe = new File(candidatePaths[p]);
            if (probe.exists) {
              state.existed = true;
              state.stamp = probe.modified ? probe.modified.getTime() : 0;
              state.length = probe.length;
            }
          } catch (eProbe) {}
          beforeState.push(state);
        }

        // Returns the path that looks freshly written, or null. Freshness is judged
        // on modification time first and length second, because a filesystem with
        // one-second timestamp granularity can rewrite a file within the same second
        // and leave the stamp unchanged.
        function writtenPath(acceptUnchanged) {
          for (var w = 0; w < candidatePaths.length; w++) {
            try {
              var file = new File(candidatePaths[w]);
              if (!file.exists) continue;
              if (!beforeState[w].existed) return candidatePaths[w];
              var stamp = file.modified ? file.modified.getTime() : 0;
              if (stamp !== beforeState[w].stamp) return candidatePaths[w];
              if (file.length !== beforeState[w].length) return candidatePaths[w];
              // Neither moved. The export may still have written identical bytes over
              // an existing file, so on the final check accept it rather than report a
              // failure for a write that did happen -- a false failure invites a retry.
              if (acceptUnchanged) return candidatePaths[w];
            } catch (eCheck) {}
          }
          return null;
        }

        var exportError = null;
        function tryExport(arg1, arg2) {
          try {
            qeSequence[methodName](arg1, arg2);
          } catch (e2) {
            exportError = e2.toString();
            return false;
          }
          // Some argument orders are accepted without throwing and without
          // producing anything, so keep probing the remaining orders rather
          // than reporting a success that left no file behind.
          return writtenPath(false) !== null;
        }

        var exported =
          tryExport(timeCode, exportStem) ||
          tryExport(exportStem, timeCode) ||
          tryExport(timeNumber, exportStem) ||
          tryExport(exportStem, timeNumber) ||
          tryExport(timeString, exportStem) ||
          tryExport(exportStem, timeString) ||
          tryExport(timeTicks, exportStem) ||
          tryExport(exportStem, timeTicks);

        var actualPath = writtenPath(true);
        if (!exported || !actualPath) {
          return JSON.stringify({
            success: false,
            error: exportError || "Frame export reported no error but wrote no file"
          });
        }

        return JSON.stringify({
          success: true,
          message: "Frame exported successfully",
          sequenceId: ${JSON.stringify(sequenceId)},
          sequenceName: sequence.name,
          time: ${time},
          outputPath: actualPath,
          requestedPath: requestedPath,
          format: ${JSON.stringify(format)}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

  return await ctx.bridge.executeScript(script);
}

async function addToRenderQueue(ctx: ToolContext, args: AddToRenderQueueArgs): Promise<any> {
  return await exportSequence(ctx, args);
}

async function getRenderQueueStatus(): Promise<any> {
  return {
    success: true,
    available: false,
    queueStatusAvailable: false,
    note: "Render queue monitoring requires Adobe Media Encoder integration. Check Adobe Media Encoder for live render status."
  };
}

async function exportAsFcpXml(ctx: ToolContext, sequenceId: string, outputPath: string): Promise<any> {
  const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        seq.exportAsFinalCutProXML(${JSON.stringify(outputPath)});
        return JSON.stringify({
          success: true,
          message: "Exported as Final Cut Pro XML",
          sequenceId: ${JSON.stringify(sequenceId)},
          outputPath: ${JSON.stringify(outputPath)}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
  return await ctx.bridge.executeScript(script);
}

async function exportAaf(ctx: ToolContext, sequenceId: string, outputPath: string, mixDownVideo?: boolean, explodeToMono?: boolean, sampleRate?: number, bitsPerSample?: number): Promise<any> {
  const mixDown = mixDownVideo !== false ? 1 : 0;
  const explode = explodeToMono ? 1 : 0;
  const rate = sampleRate || 48000;
  const bits = bitsPerSample || 16;
  const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        app.project.exportAAF(seq, ${JSON.stringify(outputPath)}, ${mixDown}, ${explode}, ${rate}, ${bits}, 0, 0, 1, 0);
        return JSON.stringify({
          success: true,
          message: "Exported as AAF",
          sequenceId: ${JSON.stringify(sequenceId)},
          outputPath: ${JSON.stringify(outputPath)}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
  return await ctx.bridge.executeScript(script);
}
