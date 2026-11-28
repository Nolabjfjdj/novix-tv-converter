import express from 'express';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const port = Number(process.env.PORT || 10000);
const apiToken = process.env.CONVERTER_API_TOKEN;
function createStorageProvider(id, suffix) {
  const bucket = process.env['FILEBASE_BUCKET' + suffix];
  const accessKeyId = process.env['FILEBASE_ACCESS_KEY_ID' + suffix];
  const secretAccessKey = process.env['FILEBASE_SECRET_ACCESS_KEY' + suffix];
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const endpoint = process.env['FILEBASE_ENDPOINT' + suffix] || 'https://s3.filebase.io';
  const region = process.env['FILEBASE_REGION' + suffix] || 'us-east-1';
  return { id, bucket, client: new S3Client({ endpoint, region, credentials: { accessKeyId, secretAccessKey } }) };
}
const storageProviders = [createStorageProvider('filebase', ''), createStorageProvider('filebase1', '1')].filter(Boolean);
function getStorageProvider(id) { return storageProviders.find(provider => provider.id === id) || null; }
const maxInputBytes = Number(process.env.MAX_INPUT_BYTES || 2147483648);


const jobs = new Map();
let conversionRunning = false;

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr.trim() || command + ' failed').slice(-3000)));
    });
  });
}


function runFfmpeg(args, jobId, job, duration) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', args[args.length - 1]], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    let stdoutBuffer = '';
    let lastLoggedPercent = -1;
    let lastLogAt = Date.now();
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const percent = job.progress?.percent ?? 0;
      console.log('[Conversion ' + jobId + '] FFmpeg still running: ' + elapsed + 's elapsed, ' + percent + '% reported');
    }, 30000);

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const separator = line.indexOf('=');
        if (separator < 0) continue;
        const name = line.slice(0, separator);
        const value = line.slice(separator + 1);

        if (name === 'out_time_us' || name === 'out_time_ms') {
          const encodedSeconds = Number(value) / 1000000;
          if (Number.isFinite(encodedSeconds) && duration > 0) {
            const percent = Math.min(99, Math.max(0, Math.floor(encodedSeconds / duration * 100)));
            job.progress = {
              stage: 'encoding',
              percent,
              elapsedSeconds: Math.floor(encodedSeconds),
              totalSeconds: Math.ceil(duration)
            };
            if (percent >= lastLoggedPercent + 5 || Date.now() - lastLogAt >= 15000) {
              console.log('[Conversion ' + jobId + '] Encoding progress: ' + percent + '% (' + Math.floor(encodedSeconds) + '/' + Math.ceil(duration) + 's)');
              lastLoggedPercent = percent;
              lastLogAt = Date.now();
            }
          }
        } else if (name === 'speed') {
          job.progress = { ...(job.progress || {}), speed: value };
        } else if (name === 'progress' && value === 'end') {
          job.progress = {
            stage: 'encoding',
            percent: 100,
            elapsedSeconds: Math.ceil(duration),
            totalSeconds: Math.ceil(duration)
          };
        }
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    child.once('error', error => { clearInterval(heartbeat); reject(error); });
    child.once('close', code => {
      clearInterval(heartbeat);
      if (code === 0) {
        console.log('[Conversion ' + jobId + '] Encoding finished');
        resolve();
      } else {
        reject(new Error((stderr.trim() || 'ffmpeg failed').slice(-3000)));
      }
    });
  });
}

function safeFilename(value) {
  const base = path.basename(String(value || 'video')).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.replace(/\.[^.]+$/, '').slice(0, 100) || 'video';
}

function assertConfigured(providerId) {
  if (!getStorageProvider(providerId)) throw new Error('Storage provider is not configured: ' + providerId);
  if (!apiToken) throw new Error('Missing environment variable: CONVERTER_API_TOKEN');
}

function authorized(req) {
  return Boolean(apiToken && req.get('authorization') === 'Bearer ' + apiToken);
}

async function runConversion(jobId, key, filename, providerId) {
  let workdir;
  const job = jobs.get(jobId);
  const provider = getStorageProvider(providerId);
  if (!provider) throw new Error('Storage provider is not configured.');

  try {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'novix-convert-'));
    const inputPath = path.join(workdir, 'input');
    const outputPath = path.join(workdir, 'output.mp4');

    job.message = 'Téléchargement de la vidéo depuis Filebase...';
    console.log('[Conversion ' + jobId + '] Downloading source:', key);
    const source = await provider.client.send(new GetObjectCommand({ Bucket: provider.bucket, Key: key }));
    const sourceLength = Number(source.ContentLength || 0);

    if (sourceLength > maxInputBytes) {
      source.Body?.destroy();
      throw new Error('Source video exceeds the configured size limit.');
    }

    if (!source.Body) throw new Error('Filebase returned an empty file stream.');
    await pipeline(source.Body, createWriteStream(inputPath));

    job.message = 'Analyse des codecs vidéo et audio...';
    console.log('[Conversion ' + jobId + '] Probing source video');
    const probeText = await runProcess('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,pix_fmt',
      '-of', 'json',
      inputPath
    ]);
    const probe = JSON.parse(probeText);
    const duration = Number(probe.format?.duration);
    const formatNames = String(probe.format?.format_name || '').split(',');
    const videoStream = (probe.streams || []).find(stream => stream.codec_type === 'video');
    const audioStreams = (probe.streams || []).filter(stream => stream.codec_type === 'audio');

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Could not determine the video duration.');
    }
    if (!videoStream) {
      throw new Error('No video stream was found in the uploaded file.');
    }

    const isMp4Container = formatNames.includes('mov') && formatNames.includes('mp4');
    const hasBrowserCompatibleCodecs =
      videoStream.codec_name === 'h264' &&
      videoStream.pix_fmt === 'yuv420p' &&
      audioStreams.every(stream => stream.codec_name === 'aac');
    const canUseOriginal = isMp4Container && hasBrowserCompatibleCodecs;

    if (canUseOriginal) {
      const outputKey = 'videos/converted/' + randomUUID() + '-' + filename + '.bin';
      const inputStat = await fs.stat(inputPath);
      job.message = 'Vidéo compatible : préparation du fichier sans réencodage...';
      job.progress = { stage: 'uploading', percent: 0, uploadedBytes: 0, totalBytes: inputStat.size };
      console.log('[Conversion ' + jobId + '] Source already browser-compatible; copying without re-encoding:', key);
      const upload = new Upload({
        client: provider.client,
        params: {
          Bucket: provider.bucket,
          Key: outputKey,
          Body: createReadStream(inputPath),
          ContentLength: inputStat.size,
          ContentType: 'application/octet-stream'
        },
        queueSize: 3,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false
      });
      upload.on('httpUploadProgress', progress => {
        const loaded = Number(progress.loaded || 0);
        const total = Number(progress.total || inputStat.size);
        job.progress = {
          stage: 'uploading',
          percent: Math.min(100, Math.floor(loaded / total * 100)),
          uploadedBytes: loaded,
          totalBytes: total
        };
      });
      await upload.done();
      jobs.set(jobId, {
        status: 'completed',
        message: 'Vidéo compatible : fichier prêt sans réencodage.',
        progress: { stage: 'completed', percent: 100 },
        key: outputKey,
        sourceKey: key,
        contentType: 'video/mp4',
        size: inputStat.size,
        duration,
        passthrough: true,
        storageProvider: provider.id,
        finishedAt: new Date().toISOString()
      });
      console.log('[Conversion ' + jobId + '] Compatible video copied to playlist format:', outputKey);
      return;
    }

    job.message = 'Conversion vidéo en H.264/AAC...';
    job.progress = { stage: 'encoding', percent: 0, elapsedSeconds: 0, totalSeconds: Math.ceil(duration) };
    console.log('[Conversion ' + jobId + '] Encoding with FFmpeg');
    await runFfmpeg([
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '26',
      '-pix_fmt', 'yuv420p',
      '-threads', '0',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-movflags', '+faststart',
      outputPath
    ], jobId, job, duration);

    const outputStat = await fs.stat(outputPath);
    if (!outputStat.size) throw new Error('FFmpeg produced an empty output file.');

    job.message = 'Envoi de la vidéo convertie vers Filebase...';
    console.log('[Conversion ' + jobId + '] Uploading converted video:', outputStat.size, 'bytes');
    const outputKey = 'videos/converted/' + randomUUID() + '-' + filename + '.bin';
    job.progress = { stage: 'uploading', percent: 0, uploadedBytes: 0, totalBytes: outputStat.size };
    const upload = new Upload({
      client: provider.client,
      params: {
        Bucket: provider.bucket,
        Key: outputKey,
        Body: createReadStream(outputPath),
        ContentLength: outputStat.size,
        ContentType: 'application/octet-stream'
      },
      queueSize: 3,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false
    });

    let lastUploadLog = 0;
    upload.on('httpUploadProgress', progress => {
      const loaded = Number(progress.loaded || 0);
      const total = Number(progress.total || outputStat.size);
      const percent = Math.min(100, Math.floor(loaded / total * 100));
      job.progress = { stage: 'uploading', percent, uploadedBytes: loaded, totalBytes: total };
      if (percent >= lastUploadLog + 10 || percent === 100) {
        console.log('[Conversion ' + jobId + '] Upload progress: ' + percent + '%');
        lastUploadLog = percent;
      }
    });
    await upload.done();
    jobs.set(jobId, {
      status: 'completed',
      message: 'Vidéo convertie et prête.',
      progress: { stage: 'completed', percent: 100 },
      key: outputKey,
      contentType: 'video/mp4',
      size: outputStat.size,
      duration,
      passthrough: false,
      storageProvider: provider.id,
      finishedAt: new Date().toISOString()
    });
    console.log('[Conversion ' + jobId + '] Completed:', outputKey);
  } catch (error) {
    console.error('[Conversion ' + jobId + '] Failed:', error);
    jobs.set(jobId, {
      status: 'failed',
      message: String(error.message || error).slice(0, 1000),
      finishedAt: new Date().toISOString()
    });
  } finally {
    if (workdir) await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
    conversionRunning = false;
  }
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'novix-tv-converter' });
});

app.post('/convert', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (conversionRunning) return res.status(429).json({ error: 'A conversion is already running. Retry shortly.' });

  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  const filename = safeFilename(req.body?.filename);
  const providerId = typeof req.body?.storageProvider === 'string' ? req.body.storageProvider : 'filebase';

  if (!key || key.startsWith('/') || key.split('/').includes('..')) {
    return res.status(400).json({ error: 'Invalid source key.' });
  }

  try {
    assertConfigured(providerId);
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }

  const jobId = randomUUID();
  jobs.set(jobId, {
    status: 'processing',
    message: 'Préparation de la conversion...',
    createdAt: new Date().toISOString()
  });
  conversionRunning = true;
  console.log('[Conversion ' + jobId + '] Job accepted');
  runConversion(jobId, key, filename, providerId);
  res.status(202).json({ jobId, status: 'processing' });
});

app.get('/convert/:jobId', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Conversion job not found.' });
  res.json(job);
});

app.listen(port, '0.0.0.0', () => {
  console.log('NOVIX TV Converter listening on port ' + port);
});
