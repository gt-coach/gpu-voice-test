import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as ort from 'onnxruntime-node';
import { createOnnxCpuSessionOptions } from './kitten-runtime.mjs';

// Inference flow adapted from supertone-inc/supertonic's MIT Node.js helper.
const HF_BASE = 'https://huggingface.co/Supertone/supertonic-3/resolve/main';
const CORE_ASSETS = [
  'onnx/duration_predictor.onnx',
  'onnx/text_encoder.onnx',
  'onnx/vector_estimator.onnx',
  'onnx/vocoder.onnx',
  'onnx/tts.json',
  'onnx/unicode_indexer.json',
];
const AVAILABLE_LANGS = new Set([
  'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi',
  'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro',
  'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na',
]);

async function ensureFile(cacheDir, relativePath) {
  const filePath = path.join(cacheDir, relativePath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return filePath;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const url = `${HF_BASE}/${relativePath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Supertonic asset download failed (${response.status}): ${relativePath}`);
  }

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  if (response.body) {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpPath));
  } else {
    fs.writeFileSync(tmpPath, Buffer.from(await response.arrayBuffer()));
  }
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

async function ensureAssets(cacheDir, voices) {
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const asset of CORE_ASSETS) {
    await ensureFile(cacheDir, asset);
  }
  for (const voice of voices) {
    await ensureFile(cacheDir, `voice_styles/${voice.id}.json`);
  }
}

function flattenFloat32(value) {
  return Float32Array.from(value.flat(Infinity));
}

function lengthToMask(lengths, maxLen = Math.max(...lengths)) {
  return lengths.map((length) => [
    Array.from({ length: maxLen }, (_, index) => (index < length ? 1 : 0)),
  ]);
}

function arrayToTensor(array, dims) {
  return new ort.Tensor('float32', flattenFloat32(array), dims);
}

function intArrayToTensor(array, dims) {
  return new ort.Tensor('int64', BigInt64Array.from(array.flat(Infinity).map((value) => BigInt(value))), dims);
}

function getLatentMask(wavLengths, baseChunkSize, chunkCompressFactor) {
  const latentSize = baseChunkSize * chunkCompressFactor;
  const latentLengths = wavLengths.map((length) => Math.floor((length + latentSize - 1) / latentSize));
  return lengthToMask(latentLengths);
}

function concatAudio(chunks, sampleRate, silenceDuration) {
  const silenceLength = Math.floor(sampleRate * silenceDuration);
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + silenceLength * Math.max(0, chunks.length - 1);
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (let index = 0; index < chunks.length; index++) {
    if (index > 0) offset += silenceLength;
    output.set(chunks[index], offset);
    offset += chunks[index].length;
  }
  return output;
}

function chunkText(text, maxLen = 300) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const chunks = [];

  for (const sentence of sentences.length ? sentences : [normalized]) {
    if (sentence.length <= maxLen) {
      chunks.push(sentence);
      continue;
    }

    const words = sentence.split(/\s+/);
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxLen) {
        current = candidate;
      } else {
        if (current) chunks.push(current);
        current = word;
      }
    }
    if (current) chunks.push(current);
  }

  return chunks;
}

class UnicodeProcessor {
  constructor(unicodeIndexerJsonPath) {
    this.indexer = JSON.parse(fs.readFileSync(unicodeIndexerJsonPath, 'utf8'));
  }

  preprocessText(text, lang) {
    if (!AVAILABLE_LANGS.has(lang)) {
      throw new Error(`Invalid Supertonic language: ${lang}`);
    }

    let processed = String(text || '').normalize('NFKD');
    processed = processed.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');

    const replacements = {
      '–': '-',
      '‑': '-',
      '—': '-',
      '_': ' ',
      '\u201C': '"',
      '\u201D': '"',
      '\u2018': "'",
      '\u2019': "'",
      '´': "'",
      '`': "'",
      '[': ' ',
      ']': ' ',
      '|': ' ',
      '/': ' ',
      '#': ' ',
      '→': ' ',
      '←': ' ',
    };
    for (const [from, to] of Object.entries(replacements)) {
      processed = processed.replaceAll(from, to);
    }

    processed = processed
      .replace(/[♥☆♡©\\]/g, '')
      .replaceAll('@', ' at ')
      .replaceAll('e.g.,', 'for example, ')
      .replaceAll('i.e.,', 'that is, ')
      .replace(/ ,/g, ',')
      .replace(/ \./g, '.')
      .replace(/ !/g, '!')
      .replace(/ \?/g, '?')
      .replace(/ ;/g, ';')
      .replace(/ :/g, ':')
      .replace(/ '/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (!/[.!?;:,'")\]}…。」』〗〉》›»]$/.test(processed)) {
      processed += '.';
    }

    return `<${lang}>${processed}`;
  }

  call(textList, langList) {
    const processedTexts = textList.map((text, index) => this.preprocessText(text, langList[index]));
    const lengths = processedTexts.map((text) => text.length);
    const maxLen = Math.max(...lengths);

    const textIds = processedTexts.map((text) => {
      const row = new Array(maxLen).fill(0);
      Array.from(text).forEach((char, index) => {
        row[index] = this.indexer[char.charCodeAt(0)] ?? 0;
      });
      return row;
    });

    return {
      textIds,
      textMask: lengthToMask(lengths),
    };
  }
}

class Style {
  constructor(styleTtlOnnx, styleDpOnnx) {
    this.ttl = styleTtlOnnx;
    this.dp = styleDpOnnx;
  }
}

function loadVoiceStyle(voiceStylePath) {
  const style = JSON.parse(fs.readFileSync(voiceStylePath, 'utf8'));
  const ttlDims = style.style_ttl.dims;
  const dpDims = style.style_dp.dims;
  const ttlFlat = flattenFloat32([style.style_ttl.data]);
  const dpFlat = flattenFloat32([style.style_dp.data]);

  return new Style(
    new ort.Tensor('float32', ttlFlat, [1, ttlDims[1], ttlDims[2]]),
    new ort.Tensor('float32', dpFlat, [1, dpDims[1], dpDims[2]]),
  );
}

class TextToSpeech {
  constructor(cfgs, textProcessor, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt) {
    this.cfgs = cfgs;
    this.textProcessor = textProcessor;
    this.dpOrt = dpOrt;
    this.textEncOrt = textEncOrt;
    this.vectorEstOrt = vectorEstOrt;
    this.vocoderOrt = vocoderOrt;
    this.sampleRate = cfgs.ae.sample_rate;
    this.baseChunkSize = cfgs.ae.base_chunk_size;
    this.chunkCompressFactor = cfgs.ttl.chunk_compress_factor;
    this.ldim = cfgs.ttl.latent_dim;
  }

  sampleNoisyLatent(duration) {
    const wavLenMax = Math.max(...duration) * this.sampleRate;
    const wavLengths = duration.map((item) => Math.floor(item * this.sampleRate));
    const chunkSize = this.baseChunkSize * this.chunkCompressFactor;
    const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
    const latentDim = this.ldim * this.chunkCompressFactor;
    const latentMask = getLatentMask(wavLengths, this.baseChunkSize, this.chunkCompressFactor);
    const noisyLatent = [];

    for (let batch = 0; batch < duration.length; batch++) {
      const batchRows = [];
      for (let dim = 0; dim < latentDim; dim++) {
        const row = [];
        for (let step = 0; step < latentLen; step++) {
          const u1 = Math.max(1e-10, Math.random());
          const u2 = Math.random();
          row.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * latentMask[batch][0][step]);
        }
        batchRows.push(row);
      }
      noisyLatent.push(batchRows);
    }

    return { noisyLatent, latentMask };
  }

  async infer(textList, langList, style, totalStep, speed) {
    if (textList.length !== style.ttl.dims[0]) {
      throw new Error('Supertonic text count must match style batch size');
    }

    const batchSize = textList.length;
    const { textIds, textMask } = this.textProcessor.call(textList, langList);
    const textIdsShape = [batchSize, textIds[0].length];
    const textMaskShape = [batchSize, 1, textMask[0][0].length];
    const textMaskTensor = arrayToTensor(textMask, textMaskShape);

    const dpResult = await this.dpOrt.run({
      text_ids: intArrayToTensor(textIds, textIdsShape),
      style_dp: style.dp,
      text_mask: textMaskTensor,
    });
    const duration = Array.from(dpResult.duration.data).map((item) => item / speed);

    const textEncResult = await this.textEncOrt.run({
      text_ids: intArrayToTensor(textIds, textIdsShape),
      style_ttl: style.ttl,
      text_mask: textMaskTensor,
    });
    const textEmbTensor = textEncResult.text_emb;
    const { noisyLatent, latentMask } = this.sampleNoisyLatent(duration);
    const latentShape = [batchSize, noisyLatent[0].length, noisyLatent[0][0].length];
    const latentMaskShape = [batchSize, 1, latentMask[0][0].length];
    const latentMaskTensor = arrayToTensor(latentMask, latentMaskShape);
    const totalStepTensor = arrayToTensor(new Array(batchSize).fill(totalStep), [batchSize]);

    for (let step = 0; step < totalStep; step++) {
      const vectorEstResult = await this.vectorEstOrt.run({
        noisy_latent: arrayToTensor(noisyLatent, latentShape),
        text_emb: textEmbTensor,
        style_ttl: style.ttl,
        text_mask: textMaskTensor,
        latent_mask: latentMaskTensor,
        total_step: totalStepTensor,
        current_step: arrayToTensor(new Array(batchSize).fill(step), [batchSize]),
      });

      const denoisedLatent = vectorEstResult.denoised_latent.data;
      let offset = 0;
      for (let batch = 0; batch < noisyLatent.length; batch++) {
        for (let dim = 0; dim < noisyLatent[batch].length; dim++) {
          for (let item = 0; item < noisyLatent[batch][dim].length; item++) {
            noisyLatent[batch][dim][item] = denoisedLatent[offset++];
          }
        }
      }
    }

    const vocoderResult = await this.vocoderOrt.run({
      latent: arrayToTensor(noisyLatent, latentShape),
    });
    const outputKey = vocoderResult.wav_tts ? 'wav_tts' : Object.keys(vocoderResult)[0];
    const wav = vocoderResult[outputKey].data;
    return {
      wav: wav instanceof Float32Array ? wav : new Float32Array(wav),
      duration,
    };
  }

  async call(text, lang, style, totalStep, speed, silenceDuration = 0.3) {
    const maxLen = lang === 'ko' || lang === 'ja' ? 120 : 300;
    const chunks = chunkText(text, maxLen);
    if (chunks.length === 0) {
      return { wav: new Float32Array(), duration: [0] };
    }

    const audioChunks = [];
    let duration = 0;
    for (const chunk of chunks) {
      const result = await this.infer([chunk], [lang], style, totalStep, speed);
      audioChunks.push(result.wav);
      duration += result.duration[0];
    }
    duration += Math.max(0, chunks.length - 1) * silenceDuration;

    return {
      wav: concatAudio(audioChunks, this.sampleRate, silenceDuration),
      duration: [duration],
    };
  }
}

async function loadOnnxAll(onnxDir, sessionOptions) {
  const [dpOrt, textEncOrt, vectorEstOrt, vocoderOrt] = await Promise.all([
    ort.InferenceSession.create(path.join(onnxDir, 'duration_predictor.onnx'), sessionOptions),
    ort.InferenceSession.create(path.join(onnxDir, 'text_encoder.onnx'), sessionOptions),
    ort.InferenceSession.create(path.join(onnxDir, 'vector_estimator.onnx'), sessionOptions),
    ort.InferenceSession.create(path.join(onnxDir, 'vocoder.onnx'), sessionOptions),
  ]);

  return { dpOrt, textEncOrt, vectorEstOrt, vocoderOrt };
}

class SupertonicModel {
  constructor(textToSpeech, styles, metadata) {
    this.textToSpeech = textToSpeech;
    this.styles = styles;
    this.sampleRate = textToSpeech.sampleRate;
    Object.assign(this, metadata);
  }

  async generate(text, { voice = 'M1', lang = 'en', speed = 1.05, totalSteps = 8 } = {}) {
    const style = this.styles.get(voice);
    if (!style) {
      throw new Error(`Unsupported Supertonic voice style: ${voice}`);
    }

    return this.textToSpeech.call(text, lang, style, totalSteps, speed);
  }
}

export async function loadSupertonicModel({ cacheDir, numThreads, voices }) {
  await ensureAssets(cacheDir, voices);
  const { sessionOptions, threading } = createOnnxCpuSessionOptions(
    numThreads,
    'onnxruntime-node session intraOpNumThreads',
  );

  const onnxDir = path.join(cacheDir, 'onnx');
  const cfgs = JSON.parse(fs.readFileSync(path.join(onnxDir, 'tts.json'), 'utf8'));
  const textProcessor = new UnicodeProcessor(path.join(onnxDir, 'unicode_indexer.json'));
  const { dpOrt, textEncOrt, vectorEstOrt, vocoderOrt } = await loadOnnxAll(onnxDir, sessionOptions);
  const textToSpeech = new TextToSpeech(cfgs, textProcessor, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt);
  const styles = new Map();
  for (const voice of voices) {
    styles.set(voice.id, loadVoiceStyle(path.join(cacheDir, 'voice_styles', `${voice.id}.json`)));
  }

  return new SupertonicModel(textToSpeech, styles, {
    runtime: 'cpu',
    executionProviders: sessionOptions.executionProviders,
    threading,
  });
}
