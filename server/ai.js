import Anthropic from '@anthropic-ai/sdk';
import { getSetting, setSetting } from './db.js';
import { HttpError } from './http.js';

export const PROVIDERS = ['anthropic', 'openai', 'gemini'];

// `suggested` maps the models offered up front to the name shown in Settings.
export const PROVIDER_INFO = {
  anthropic: {
    label: 'Claude',
    defaultModel: 'claude-opus-5-5',
    suggested: {
      'claude-opus-5-5': 'Claude Opus 5.5 · most accurate',
      'claude-sonnet-5-5': 'Claude Sonnet 5.5 · faster, cheaper',
      'claude-haiku-5-5': 'Claude Haiku 5.5 · fastest, cheapest',
    },
    keyEnv: ['ANTHROPIC_API_KEY'],
    modelEnv: 'ANTHROPIC_MODEL',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5.4',
    suggested: { 'gpt-5.4': 'GPT-5.4' },
    keyEnv: ['OPENAI_API_KEY'],
    modelEnv: 'OPENAI_MODEL',
  },
  gemini: {
    label: 'Gemini',
    // Google keeps these aliases pointed at its current models, so they do not go stale.
    defaultModel: 'gemini-flash-latest',
    suggested: {
      'gemini-flash-latest': 'Gemini Flash · fast, has a free tier',
      'gemini-pro-latest': 'Gemini Pro · most accurate',
    },
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    modelEnv: 'GEMINI_MODEL',
  },
};

const REQUEST_TIMEOUT_MS = 75_000;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// ---- configuration -----------------------------------------------------------------------

function envKey(provider) {
  for (const name of PROVIDER_INFO[provider].keyEnv) {
    if (process.env[name]?.trim()) return process.env[name].trim();
  }
  return '';
}

/** Saved settings merged with environment variables. Keys saved in the app win over the environment. */
export function aiConfig() {
  const saved = getSetting('ai', {}) || {};
  const keys = {};
  const models = {};
  const keySource = {};
  for (const provider of PROVIDERS) {
    const savedKey = saved.keys?.[provider] || '';
    keys[provider] = savedKey || envKey(provider);
    keySource[provider] = savedKey ? 'app' : keys[provider] ? 'env' : null;
    models[provider] =
      saved.models?.[provider] || process.env[PROVIDER_INFO[provider].modelEnv]?.trim() || PROVIDER_INFO[provider].defaultModel;
  }
  // Claude can also authenticate with ANTHROPIC_AUTH_TOKEN, which the SDK reads by itself.
  const ready = (p) => Boolean(keys[p]) || (p === 'anthropic' && Boolean(process.env.ANTHROPIC_AUTH_TOKEN));

  let provider = saved.provider || process.env.AI_PROVIDER?.trim().toLowerCase() || '';
  if (provider === 'claude') provider = 'anthropic';
  if (provider === 'google') provider = 'gemini';
  if (provider !== 'mock' && !PROVIDERS.includes(provider)) provider = PROVIDERS.find(ready) || 'anthropic';

  return { provider, keys, models, keySource, ready: provider === 'mock' || ready(provider) };
}

export function saveAiConfig({ provider, model, apiKey }) {
  const saved = getSetting('ai', {}) || {};
  const next = { provider: saved.provider, keys: { ...saved.keys }, models: { ...saved.models } };
  if (provider) {
    if (!PROVIDERS.includes(provider)) throw new HttpError(400, 'Unknown AI provider.');
    next.provider = provider;
  }
  const target = provider || aiConfig().provider;
  if (typeof model === 'string') {
    const clean = model.trim().slice(0, 100);
    if (clean && !/^[\w.:\/-]+$/.test(clean)) throw new HttpError(400, 'That model name does not look right.');
    if (clean) next.models[target] = clean;
    else delete next.models[target];
  }
  if (typeof apiKey === 'string') {
    const clean = apiKey.trim().slice(0, 400);
    if (clean) next.keys[target] = clean;
    else delete next.keys[target];
  }
  setSetting('ai', next);
}

export function maskKey(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

// ---- the task ----------------------------------------------------------------------------

const SYSTEM_PROMPT = `You estimate the nutrition of meals for a personal food diary, from a photo, a short note, or both.

How to estimate:
- Identify each distinct food and drink. Judge each portion from what you can see: plate and bowl size (a dinner plate is about 27 cm across), cutlery, hands, packaging, and how full the container is.
- For each item, estimate the weight in grams (millilitres for drinks), then calories, protein, carbohydrate and fat using typical values for that food as it was prepared. Include cooking oil, butter, sauces, dressings and cheese that are visible or normal for the dish; these are the calories people most often miss.
- The user's note is the best information you have. When it gives weights, brands, ingredients, the cooking method or how much was actually eaten, use it over what the picture suggests. The note can be in any language.
- If a nutrition label is readable in the photo, use its numbers.
- Commit to one best estimate for every number rather than a range, and keep each item's calories consistent with its macros (4 kcal per gram of protein and carbohydrate, 9 per gram of fat, 7 per gram of alcohol).
- If there is no food or drink in the photo and the note does not describe any, set is_food to false and return an empty items list.

What to return:
- name: a short natural title for the whole meal, two to six words, in the language of the user's note (English when there is no note).
- items: one entry per food. Use short specific names such as "Grilled chicken breast" rather than "Protein". portion is a friendly amount a person would say, such as "1 cup", "2 slices" or "150 g".
- confidence: "high" when the foods and portions are clear, "medium" when the portions are uncertain, "low" when the food itself is hard to identify.
- notes: one short sentence, under 140 characters, with the main assumption you made or the one detail that would most improve the estimate. Use an empty string when there is nothing worth saying.`;

const MEAL_SCHEMA = {
  type: 'object',
  properties: {
    is_food: { type: 'boolean' },
    name: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          portion: { type: 'string' },
          grams: { type: 'number' },
          calories: { type: 'number' },
          protein: { type: 'number' },
          carbs: { type: 'number' },
          fat: { type: 'number' },
        },
        required: ['name', 'portion', 'grams', 'calories', 'protein', 'carbs', 'fat'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    notes: { type: 'string' },
  },
  required: ['is_food', 'name', 'items', 'confidence', 'notes'],
  additionalProperties: false,
};

function buildUserText({ hasImage, note, previous, correction }) {
  const parts = [];
  if (hasImage) parts.push('Estimate the nutrition of the meal in this photo.');
  else parts.push('There is no photo. Estimate the nutrition from the description alone.');
  parts.push(note ? `Note from the user:\n"""\n${note}\n"""` : 'The user did not add a note.');
  if (previous && correction) {
    parts.push(
      `Your earlier estimate for this meal was:\n${JSON.stringify(previous)}`,
      `The user says it needs correcting:\n"""\n${correction}\n"""`,
      'Return the full corrected estimate.',
    );
  }
  return parts.join('\n\n');
}

const round1 = (n) => Math.round(n * 10) / 10;
const cleanText = (value, max) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f<>]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const cleanNumber = (value, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
};

/** Turn whatever the model returned into the exact shape the app stores. */
export function normalizeEstimate(raw) {
  if (!raw || typeof raw !== 'object') throw new HttpError(502, 'The AI returned something unreadable. Try again.');
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .slice(0, 25)
    .map((item) => {
      const protein = round1(cleanNumber(item?.protein, 500));
      const carbs = round1(cleanNumber(item?.carbs, 800));
      const fat = round1(cleanNumber(item?.fat, 500));
      const calories = Math.round(cleanNumber(item?.calories, 6000)) || Math.round(protein * 4 + carbs * 4 + fat * 9);
      return {
        name: cleanText(item?.name, 80) || 'Food',
        portion: cleanText(item?.portion, 40),
        grams: Math.round(cleanNumber(item?.grams, 5000)),
        calories,
        protein,
        carbs,
        fat,
      };
    })
    .filter((item) => item.calories > 0 || item.grams > 0);

  if (raw.is_food === false || items.length === 0) {
    throw new HttpError(422, "I couldn't find any food in that. Try another photo, or add a note saying what it is.", {
      code: 'not_food',
    });
  }
  const sum = (field) => items.reduce((total, item) => total + item[field], 0);
  return {
    name: cleanText(raw.name, 60) || items[0].name,
    items,
    calories: Math.round(sum('calories')),
    protein: round1(sum('protein')),
    carbs: round1(sum('carbs')),
    fat: round1(sum('fat')),
    confidence: ['low', 'medium', 'high'].includes(raw.confidence) ? raw.confidence : 'medium',
    notes: cleanText(raw.notes, 200),
  };
}

function parseModelJson(text) {
  const trimmed = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new HttpError(502, 'The AI returned something unreadable. Try again.');
  }
}

// ---- Claude ------------------------------------------------------------------------------

// Models that can hand a declined request to a fallback model on the server side.
const supportsFallbacks = (model) => /^claude-(opus-5|opus-5-5|fable-5-1|sonnet-5-5)$/.test(model);

function anthropicClient(apiKey) {
  // With no key saved in the app, the SDK resolves credentials from the environment by itself.
  return new Anthropic({ ...(apiKey ? { apiKey } : {}), timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
}

function anthropicFailure(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new HttpError(502, 'Claude rejected the API key. Check it in Settings.', { code: 'ai_auth' });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new HttpError(502, 'That Claude model is not available for this key. Pick another in Settings.', { code: 'ai_model' });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new HttpError(503, 'Claude is rate-limiting this key right now. Try again in a minute.', { code: 'ai_busy' });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new HttpError(502, `Claude did not accept the request: ${err.message}`, { code: 'ai_request' });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new HttpError(504, 'Could not reach Claude. Check the server has internet and try again.', { code: 'ai_network' });
  }
  if (err instanceof Anthropic.APIError) {
    if (err.type === 'billing_error') {
      return new HttpError(502, 'The Claude account is out of credit. Add credit in the Anthropic console.', { code: 'ai_billing' });
    }
    return new HttpError(503, 'Claude is having trouble right now. Try again in a moment.', { code: 'ai_busy' });
  }
  return err;
}

async function askAnthropic({ apiKey, model, userText, imageBase64, structured }) {
  const content = [];
  if (imageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } });
  }
  content.push({ type: 'text', text: userText });

  const params = {
    model,
    max_tokens: 16000,
    // Low effort keeps the wait short; the model still reasons about portions before it answers.
    output_config: structured
      ? { effort: 'low', format: { type: 'json_schema', schema: MEAL_SCHEMA } }
      : { effort: 'low' },
    messages: [{ role: 'user', content }],
  };
  if (structured) params.system = SYSTEM_PROMPT;

  const client = anthropicClient(apiKey);
  let message;
  try {
    message = supportsFallbacks(model)
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(params);
  } catch (err) {
    throw anthropicFailure(err);
  }

  if (message.stop_reason === 'refusal') {
    throw new HttpError(422, 'Claude declined to analyse that. Try a different photo or describe the meal in words.', {
      code: 'ai_refusal',
    });
  }
  if (message.stop_reason === 'max_tokens') {
    throw new HttpError(502, 'The answer was cut off. Try again.', { code: 'ai_truncated' });
  }
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

// ---- OpenAI and Gemini (plain HTTPS) -----------------------------------------------------

async function postJson(url, headers, body, label) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new HttpError(504, `${label} took too long to answer. Try again.`, { code: 'ai_timeout' });
    throw new HttpError(504, `Could not reach ${label}. Check the server has internet and try again.`, { code: 'ai_network' });
  }
  const data = await res.json().catch(() => null);
  if (res.ok && data) return data;

  const detail = data?.error?.message ? String(data.error.message).slice(0, 240) : `HTTP ${res.status}`;
  // Providers put the machine-readable reason in different places; look at the whole error object.
  const everything = `${detail} ${JSON.stringify(data?.error ?? '')}`;
  if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|invalid_api_key|API key not valid/i.test(everything)) {
    throw new HttpError(502, `${label} rejected the API key. Check it in Settings.`, { code: 'ai_auth' });
  }
  if (res.status === 404) {
    throw new HttpError(502, `That ${label} model is not available for this key. Pick another in Settings.`, { code: 'ai_model' });
  }
  if (res.status === 429) {
    const quota = /quota|billing|credit/i.test(everything);
    throw new HttpError(
      503,
      quota
        ? `The ${label} account has run out of quota or credit.`
        : `${label} is rate-limiting this key right now. Try again in a minute.`,
      { code: quota ? 'ai_billing' : 'ai_busy' },
    );
  }
  if (res.status >= 500) {
    throw new HttpError(503, `${label} is having trouble right now. Try again in a moment.`, { code: 'ai_busy' });
  }
  throw new HttpError(502, `${label} did not accept the request: ${detail}`, { code: 'ai_request' });
}

async function askOpenAI({ apiKey, model, userText, imageBase64, structured }) {
  const content = [{ type: 'text', text: userText }];
  if (imageBase64) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } });

  const body = {
    model,
    messages: [...(structured ? [{ role: 'system', content: SYSTEM_PROMPT }] : []), { role: 'user', content }],
    max_completion_tokens: 6000,
  };
  if (structured) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'meal_estimate', strict: true, schema: MEAL_SCHEMA } };
  }
  const data = await postJson(`${OPENAI_BASE_URL}/chat/completions`, { Authorization: `Bearer ${apiKey}` }, body, 'OpenAI');

  const choice = data.choices?.[0];
  if (choice?.message?.refusal) {
    throw new HttpError(422, 'OpenAI declined to analyse that. Try a different photo or describe the meal in words.', {
      code: 'ai_refusal',
    });
  }
  if (choice?.finish_reason === 'length') throw new HttpError(502, 'The answer was cut off. Try again.', { code: 'ai_truncated' });
  const text = choice?.message?.content;
  return typeof text === 'string' ? text : Array.isArray(text) ? text.map((part) => part.text || '').join('') : '';
}

/** Gemini takes an OpenAPI-style schema: upper-case type names and no additionalProperties. */
function toGeminiSchema(schema) {
  const out = { type: schema.type.toUpperCase() };
  if (schema.enum) out.enum = schema.enum;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.required = schema.required;
    out.propertyOrdering = Object.keys(schema.properties);
  }
  return out;
}

async function askGemini({ apiKey, model, userText, imageBase64, structured }) {
  const parts = [];
  if (imageBase64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
  parts.push({ text: userText });

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { maxOutputTokens: 8192 },
  };
  if (structured) {
    body.systemInstruction = { parts: [{ text: SYSTEM_PROMPT }] };
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = toGeminiSchema(MEAL_SCHEMA);
  }
  const data = await postJson(
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': apiKey },
    body,
    'Gemini',
  );

  const candidate = data.candidates?.[0];
  if (data.promptFeedback?.blockReason || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(candidate?.finishReason)) {
    throw new HttpError(422, 'Gemini declined to analyse that. Try a different photo or describe the meal in words.', {
      code: 'ai_refusal',
    });
  }
  if (candidate?.finishReason === 'MAX_TOKENS') throw new HttpError(502, 'The answer was cut off. Try again.', { code: 'ai_truncated' });
  return (candidate?.content?.parts || [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

// ---- a stand-in used by the automated tests (AI_PROVIDER=mock) ---------------------------

async function askMock({ userText, structured }) {
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (!structured) return 'OK';
  if (/not food/i.test(userText)) return JSON.stringify({ is_food: false, name: '', items: [], confidence: 'low', notes: '' });
  const scale = /double/i.test(userText) ? 2 : 1;
  return JSON.stringify({
    is_food: true,
    name: 'Chicken rice bowl',
    items: [
      { name: 'Grilled chicken breast', portion: '150 g', grams: 150 * scale, calories: 248 * scale, protein: 46.5 * scale, carbs: 0, fat: 5.4 * scale },
      { name: 'Steamed white rice', portion: '1 cup', grams: 160 * scale, calories: 208 * scale, protein: 4.3 * scale, carbs: 45 * scale, fat: 0.4 * scale },
      { name: 'Mixed salad with olive oil', portion: '1 small bowl', grams: 120 * scale, calories: 95 * scale, protein: 1.5 * scale, carbs: 6 * scale, fat: 7.5 * scale },
    ],
    confidence: 'medium',
    notes: 'Assumed about a teaspoon of olive oil on the salad.',
  });
}

const ASK = { anthropic: askAnthropic, openai: askOpenAI, gemini: askGemini, mock: askMock };

function resolve(config) {
  if (!config.ready) {
    throw new HttpError(503, 'No AI is connected yet. The owner can add an API key in Settings.', { code: 'ai_not_configured' });
  }
  const { provider } = config;
  return { ask: ASK[provider], apiKey: config.keys[provider] || '', model: config.models[provider] || 'mock' };
}

// ---- public API --------------------------------------------------------------------------

/** Estimate a meal from a JPEG (base64, optional), a note, and optionally a correction to an earlier estimate. */
export async function estimateMeal({ imageBase64, note, previous, correction }) {
  const { ask, apiKey, model } = resolve(aiConfig());
  const userText = buildUserText({ hasImage: Boolean(imageBase64), note, previous, correction });
  const text = await ask({ apiKey, model, userText, imageBase64, structured: true });
  return normalizeEstimate(parseModelJson(text));
}

/** One tiny request to prove the key and model work. Returns how long it took. */
export async function testConnection() {
  const config = aiConfig();
  const { ask, apiKey, model } = resolve(config);
  const started = Date.now();
  const text = await ask({ apiKey, model, userText: 'Reply with the single word: OK', imageBase64: null, structured: false });
  if (!text.trim()) throw new HttpError(502, 'The AI answered with nothing. Try a different model.');
  return { provider: config.provider, model, ms: Date.now() - started };
}

async function getJson(url, headers, label) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new HttpError(504, `Could not reach ${label}.`);
  }
  if (res.status === 401 || res.status === 403 || res.status === 400) throw new HttpError(502, `${label} rejected the API key.`);
  if (!res.ok) throw new HttpError(502, `${label} could not list its models (HTTP ${res.status}).`);
  return res.json();
}

/** Models the configured key can use for this provider, newest first, limited to ones that can read a photo. */
export async function listModels(provider) {
  const config = aiConfig();
  if (!PROVIDERS.includes(provider)) throw new HttpError(400, 'Unknown AI provider.');
  const apiKey = config.keys[provider];
  const found = [];

  if (provider === 'anthropic') {
    if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN) throw new HttpError(400, 'Add an API key first.');
    try {
      for await (const model of anthropicClient(apiKey).models.list({ limit: 100 })) {
        found.push({ id: model.id, label: model.display_name || model.id, created: Date.parse(model.created_at) || 0 });
      }
    } catch (err) {
      throw anthropicFailure(err);
    }
  } else if (!apiKey) {
    throw new HttpError(400, 'Add an API key first.');
  } else if (provider === 'openai') {
    const data = await getJson(`${OPENAI_BASE_URL}/models`, { Authorization: `Bearer ${apiKey}` }, 'OpenAI');
    for (const model of data.data || []) {
      if (!/^(gpt-|chatgpt-|o\d)/.test(model.id)) continue;
      if (/audio|realtime|tts|transcribe|image|search|embedding|instruct|codex|moderation|whisper|dall/.test(model.id)) continue;
      found.push({ id: model.id, label: model.id, created: (model.created || 0) * 1000 });
    }
  } else {
    const data = await getJson(`${GEMINI_BASE_URL}/models?pageSize=1000`, { 'x-goog-api-key': apiKey }, 'Gemini');
    for (const model of data.models || []) {
      const id = String(model.name || '').replace(/^models\//, '');
      if (!id.startsWith('gemini') || !model.supportedGenerationMethods?.includes('generateContent')) continue;
      if (/image|tts|audio|embedding|live|robotics|computer-use/.test(id)) continue;
      found.push({ id, label: model.displayName || id, created: 0 });
    }
  }

  found.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  const suggested = PROVIDER_INFO[provider].suggested;
  return { models: found.map((m) => ({ id: m.id, label: suggested[m.id] || m.label })) };
}
