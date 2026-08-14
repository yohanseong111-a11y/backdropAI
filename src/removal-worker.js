import {
  AutoModel,
  AutoProcessor,
  RawImage,
} from "@huggingface/transformers";
import { removeBackground as imglyRemoveBackground } from "@imgly/background-removal";

const MODEL_ID = "briaai/RMBG-1.4";

const PROCESSOR_CONFIG = {
  do_normalize: true,
  do_pad: false,
  do_rescale: true,
  do_resize: true,
  image_mean: [0.5, 0.5, 0.5],
  feature_extractor_type: "ImageFeatureExtractor",
  image_std: [1, 1, 1],
  resample: 2,
  rescale_factor: 0.00392156862745098,
  size: { width: 1024, height: 1024 },
};

let modelPromise = null;
let processorPromise = null;

function resetRMBG() {
  modelPromise = null;
  processorPromise = null;
}

async function loadRMBG(id) {
  modelPromise ??= AutoModel.from_pretrained(MODEL_ID, {
    config: { model_type: "custom" },
    progress_callback(info) {
      if (Number.isFinite(info?.progress)) {
        self.postMessage({
          type: "progress",
          id,
          stage: "load",
          progress: Number(info.progress),
        });
      }
    },
  });

  processorPromise ??= AutoProcessor.from_pretrained(MODEL_ID, {
    config: PROCESSOR_CONFIG,
  });

  try {
    return await Promise.all([modelPromise, processorPromise]);
  } catch (error) {
    resetRMBG();
    throw error;
  }
}

async function getOfficialRMBGMask(file, id) {
  const [model, processor] = await loadRMBG(id);
  self.postMessage({ type: "progress", id, stage: "remove" });

  const image = await RawImage.fromBlob(file);
  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });

  if (!output?.[0]) throw new Error("RMBG returned no foreground alpha output.");

  const mask = await RawImage.fromTensor(
    output[0].mul(255).to("uint8")
  ).resize(image.width, image.height);

  if (!mask?.data?.length) throw new Error("RMBG returned an empty foreground mask.");

  const pixels = image.width * image.height;
  let source = mask.data;
  if (!(source instanceof Uint8Array) && !(source instanceof Uint8ClampedArray)) {
    source = new Uint8Array(source);
  }

  let alpha;
  if (source.length === pixels) {
    alpha = new Uint8Array(source);
  } else {
    const channels = Math.max(1, Math.floor(source.length / pixels));
    alpha = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) alpha[i] = source[i * channels];
  }

  self.postMessage(
    {
      type: "mask",
      id,
      width: image.width,
      height: image.height,
      maskBuffer: alpha.buffer,
      engine: "rmbg",
    },
    [alpha.buffer],
  );
}

async function runImglyFallback(file, id) {
  self.postMessage({
    type: "progress",
    id,
    stage: "fallback",
    message: "Using compatibility remover…",
  });

  const blob = await imglyRemoveBackground(file, {
    model: "isnet_fp16",
    device: "cpu",
    proxyToWorker: false,
    output: { format: "image/png", quality: 1 },
  });

  if (!(blob instanceof Blob) || !blob.size) {
    throw new Error("Compatibility remover returned an empty image.");
  }

  self.postMessage({ type: "done", id, blob, engine: "imgly" });
}

self.onmessage = async event => {
  const { type, id, file } = event.data || {};

  if (type === "warm") {
    try {
      await loadRMBG(id);
      self.postMessage({ type: "ready", id, acceleration: "wasm" });
    } catch (error) {
      resetRMBG();
      console.warn("RMBG warmup failed; removal can retry later.", error);
      self.postMessage({ type: "ready", id, acceleration: "fallback" });
    }
    return;
  }

  if (type !== "remove" || !file) return;

  try {
    await getOfficialRMBGMask(file, id);
  } catch (primaryError) {
    console.error("RMBG failed; trying compatibility remover.", primaryError);
    resetRMBG();
    try {
      await runImglyFallback(file, id);
    } catch (fallbackError) {
      self.postMessage({
        type: "error",
        id,
        error:
          `Primary remover: ${primaryError?.message || primaryError}. ` +
          `Compatibility remover: ${fallbackError?.message || fallbackError}.`,
      });
    }
  }
};
