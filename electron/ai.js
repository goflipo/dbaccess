const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

// Lazy — computed inside functions so app.getPath is never called before app.ready
const getAiConfigFile = () => path.join(app.getPath('userData'), 'ai-config.json');

// ── Provider registry ──────────────────────────────────────────────────────────
// 'anthropic' and 'gemini' have their own native request/response shapes.
// Everything else speaks the OpenAI chat-completions format (most providers do),
// so they share one code path — only the base URL and default model differ.
// 'custom' lets a user point at literally any OpenAI-compatible endpoint
// (Together AI, Fireworks, Azure OpenAI's OpenAI-compat route, a local
// Ollama/LM Studio server, anything not explicitly listed here).
const PROVIDERS = {
  claude:     { label: 'Claude (Anthropic)', kind: 'anthropic', defaultModel: 'claude-3-5-sonnet-20241022' },
  openai:     { label: 'OpenAI',             kind: 'openai-compat', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  gemini:     { label: 'Google Gemini',      kind: 'gemini',    defaultModel: 'gemini-1.5-flash' },
  groq:       { label: 'Groq',               kind: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile' },
  mistral:    { label: 'Mistral',            kind: 'openai-compat', baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest' },
  deepseek:   { label: 'DeepSeek',           kind: 'openai-compat', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
  xai:        { label: 'xAI (Grok)',         kind: 'openai-compat', baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-2-latest' },
  openrouter: { label: 'OpenRouter',         kind: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini' },
  perplexity: { label: 'Perplexity',         kind: 'openai-compat', baseUrl: 'https://api.perplexity.ai', defaultModel: 'llama-3.1-sonar-large-128k-online' },
  // NVIDIA's NIM catalog hosts many different vendors' models (Meta, Mistral,
  // DeepSeek, Microsoft, etc.) behind one endpoint — there's no single sane
  // default, so the model field is left blank and must be typed in, matching
  // the model id shown on the model's page at build.nvidia.com.
  nvidia:     { label: 'NVIDIA NIM',         kind: 'openai-compat', baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModel: null },
  custom:     { label: 'Custom (OpenAI-compatible)', kind: 'openai-compat', baseUrl: null, defaultModel: null },
};

const FIXED_ENDPOINT = {
  claude: 'api.anthropic.com',
  gemini: 'generativelanguage.googleapis.com',
};

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, label: p.label, kind: p.kind,
    needsBaseUrl: id === 'custom',
    defaultModel: p.defaultModel,
    // Shown in Settings so it's obvious which server a key is sent to —
    // e.g. a NVIDIA NIM key hosting a "deepseek" model must go through
    // Custom with NVIDIA's endpoint, not the "DeepSeek" quick-pick, which
    // only talks to DeepSeek's own api.deepseek.com.
    endpoint: id === 'custom' ? null : (FIXED_ENDPOINT[id] || (p.baseUrl ? new URL(p.baseUrl).host : null)),
  }));
}

// ── Config storage (API key encrypted at rest via OS keychain/DPAPI) ──────────

function saveAiConfig(provider, apiKey, options = {}) {
  if (!PROVIDERS[provider]) return { success: false, error: 'Unknown provider' };
  // No new key typed: keep the one already saved for this provider (e.g. only the model changed)
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    const existing = loadAiConfig();
    if (existing?.provider === provider && existing.apiKey) apiKey = existing.apiKey;
    else return { success: false, error: 'API key is required' };
  }
  const baseUrl = (options.baseUrl || '').trim();
  const model = (options.model || '').trim();
  if (provider === 'custom' && !baseUrl) {
    return { success: false, error: 'Base URL is required for a custom provider' };
  }
  if (!PROVIDERS[provider].defaultModel && !model) {
    return { success: false, error: 'Model is required for this provider' };
  }
  try {
    const encrypted = safeStorage.isEncryptionAvailable();
    const key = encrypted
      ? safeStorage.encryptString(apiKey.trim()).toString('base64')
      : Buffer.from(apiKey.trim()).toString('base64');
    fs.writeFileSync(getAiConfigFile(), JSON.stringify({ provider, key, encrypted, baseUrl, model }), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function loadAiConfig() {
  try {
    const file = getAiConfigFile();
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data?.provider || !data?.key || !PROVIDERS[data.provider]) return null;
    const apiKey = data.encrypted
      ? safeStorage.decryptString(Buffer.from(data.key, 'base64'))
      : Buffer.from(data.key, 'base64').toString('utf-8');
    return { provider: data.provider, apiKey, baseUrl: data.baseUrl || '', model: data.model || '' };
  } catch (err) {
    console.error('[ai] Could not load saved AI config:', err.message);
    return null;
  }
}

// ── Model lists ─────────────────────────────────────────────────────────────────
// Live list from the provider when a key is available; otherwise (or if the
// provider has no /models endpoint) a short suggested list.
const SUGGESTED_MODELS = {
  claude:     ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
  openai:     ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini'],
  gemini:     ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
  groq:       ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  mistral:    ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
  deepseek:   ['deepseek-chat', 'deepseek-reasoner'],
  xai:        ['grok-2-latest', 'grok-beta'],
  openrouter: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'meta-llama/llama-3.3-70b-instruct'],
  perplexity: ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online'],
  nvidia:     [], // only models verified against the user's key are shown
  custom:     [],
};

// NVIDIA's /models lists retired and not-enabled models too, so for NVIDIA
// each chat model is probed once with a 1-token request and only the ones that
// answer are kept (cached on disk until the user hits Refresh again).
const getModelCacheFile = () => path.join(app.getPath('userData'), 'ai-verified-models.json');
const NON_CHAT_MODEL = /embed|rerank|guard|safety|topic-control|vision|vlm|vila|neva|clip|parse|video|detector|reward|deplot|fuyu|kosmos|riva|translate|calibration|diffusion|cosmos|retriev|-base\b|starcoder|codellama|recurrentgemma|gemma-2b/i;

function readModelCache() {
  try { return JSON.parse(fs.readFileSync(getModelCacheFile(), 'utf-8')); } catch { return {}; }
}
function writeModelCache(provider, models) {
  try {
    const all = readModelCache();
    all[provider] = { models, checkedAt: new Date().toISOString() };
    fs.writeFileSync(getModelCacheFile(), JSON.stringify(all), 'utf-8');
  } catch (err) { console.error('[ai] Could not write model cache:', err.message); }
}

async function probeChatModels(base, key, ids) {
  const working = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      try {
        const res = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST', signal: ctl.signal,
          headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        });
        // 429 = model exists but we are rate limited right now
        if (res.ok || res.status === 429) working.push(id);
      } catch { /* timeout / network: treat as not usable */ }
      finally { clearTimeout(timer); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return working.sort();
}

async function listModels({ provider, apiKey, baseUrl, verify } = {}) {
  const def = PROVIDERS[provider];
  if (!def) return { success: false, error: 'Unknown provider', models: [] };
  const suggested = SUGGESTED_MODELS[provider] || [];
  const saved = loadAiConfig();
  const key = apiKey || (saved?.provider === provider ? saved.apiKey : '');
  const base = provider === 'custom' ? (baseUrl || (saved?.provider === 'custom' ? saved.baseUrl : '')) : def.baseUrl;
  if (!key || (def.kind === 'openai-compat' && !base)) {
    return { success: true, models: suggested, source: 'suggested' };
  }
  if (provider === 'nvidia' && !verify) {
    const cached = readModelCache().nvidia;
    if (cached?.models?.length) return { success: true, models: cached.models, source: 'verified' };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    let res, ids;
    if (def.kind === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
        signal: ctl.signal, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      ids = (data.data || []).map(m => m.id);
    } else if (def.kind === 'gemini') {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`, { signal: ctl.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      ids = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => String(m.name).replace(/^models\//, ''));
    } else {
      res = await fetch(`${base.replace(/\/+$/, '')}/models`, {
        signal: ctl.signal, headers: { Authorization: `Bearer ${key}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
      ids = (Array.isArray(data) ? data : data.data || []).map(m => m.id);
    }
    ids = [...new Set(ids.filter(Boolean))].sort();
    // Reached only when forced (verify) or when nothing is cached yet
    if (provider === 'nvidia') {
      const candidates = ids.filter(id => !NON_CHAT_MODEL.test(id));
      const working = await probeChatModels(base, key, candidates);
      writeModelCache('nvidia', working);
      return { success: true, models: working, source: 'verified', warning: working.length === 0 ? 'No model answered — check the key' : undefined };
    }
    if (ids.length === 0) return { success: true, models: suggested, source: 'suggested' };
    return { success: true, models: ids, source: 'live' };
  } catch (err) {
    return { success: true, models: suggested, source: 'suggested', warning: err.name === 'AbortError' ? 'Timed out fetching models' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Sends a 1-token request so a model can be verified against the user's key
// before they rely on it (catalogs list retired / not-enabled models).
async function testModel({ provider, apiKey, baseUrl, model } = {}) {
  const def = PROVIDERS[provider];
  if (!def) return { success: false, error: 'Unknown provider' };
  const saved = loadAiConfig();
  const key = apiKey || (saved?.provider === provider ? saved.apiKey : '');
  const mdl = model || def.defaultModel;
  if (!key) return { success: false, error: 'Enter or save an API key first' };
  if (!mdl) return { success: false, error: 'Select a model first' };
  const base = provider === 'custom' ? (baseUrl || (saved?.provider === 'custom' ? saved.baseUrl : '')) : def.baseUrl;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    let res;
    if (def.kind === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctl.signal,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: mdl, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
    } else if (def.kind === 'gemini') {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
      });
    } else {
      if (!base) return { success: false, error: 'Base URL is required' };
      res = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal: ctl.signal,
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: mdl, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
    }
    if (res.ok) return { success: true };
    const data = await res.json().catch(() => ({}));
    const detail = data?.error?.message || data?.detail || data?.message || ''
    return { success: false, error: `HTTP ${res.status}${detail ? ': ' + detail : ''}` };
  } catch (err) {
    return { success: false, error: err.name === 'AbortError' ? 'Timed out after 30s' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function getAiConfigStatus() {
  const cfg = loadAiConfig();
  return {
    provider: cfg?.provider || 'none',
    hasKey: !!cfg?.apiKey,
    baseUrl: cfg?.baseUrl || '',
    model: cfg?.model || '',
  };
}

function clearAiConfig() {
  try {
    const file = getAiConfigFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Logging ──────────────────────────────────────────────────────────────────
// Every generate call gets a small step-by-step log — printed to the main
// process console (visible in the dev terminal / packaged app logs) and
// returned to the renderer alongside the result, so "what is AI doing" is
// visible right in the Ask AI panel without needing DevTools.

function makeLogger() {
  const lines = []
  return {
    log(msg) {
      const entry = `${new Date().toLocaleTimeString()}  ${msg}`
      lines.push(entry)
      console.log('[ai]', entry)
    },
    lines,
  }
}

// ── Prompt construction ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a SQL generation assistant embedded in a database client. Given a database schema and a natural-language request, respond with ONLY a single valid SQL query for the given SQL dialect — no explanation, no comments, no markdown code fences, just the raw SQL statement.

The schema below is the complete, authoritative list of tables and columns that exist. You MUST only reference table and column names that literally appear in it, spelled exactly as given — never invent, guess, pluralize/singularize, or "correct" a name that seems plausible but isn't listed. If the request doesn't clearly map to any table/column in the schema, pick the closest real match from the schema rather than fabricating a new one. If the request is otherwise ambiguous, make a reasonable assumption and still produce a query.`;

// 12,000 chars (~3k tokens) was too aggressive — with a few dozen tables it
// could silently cut off tables later in the list, causing the model to
// hallucinate a plausible-but-wrong column name for whatever got dropped.
// 100k chars (~25k tokens) comfortably fits within every model we support
// while still guarding against a truly enormous schema ballooning the request.
const SCHEMA_TEXT_LIMIT = 100_000

function buildSchemaText(schema, logger) {
  if (!schema || typeof schema !== 'object') return '(schema unavailable)'
  const lines = Object.entries(schema)
    .map(([table, cols]) => `${table}(${(cols || []).join(', ')})`)
  const text = lines.join('\n')
  if (text.length > SCHEMA_TEXT_LIMIT) {
    logger?.log(`WARNING: schema text is ${text.length} chars, truncating to ${SCHEMA_TEXT_LIMIT} — some tables/columns won't be visible to the model`)
    return text.slice(0, SCHEMA_TEXT_LIMIT) + '\n…'
  }
  return text
}

function stripCodeFence(text) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:sql)?\s*([\s\S]*?)\s*```$/i)
  return (fenced ? fenced[1] : trimmed).trim()
}

// ── Provider calls ──────────────────────────────────────────────────────────────

async function callAnthropic(apiKey, model, userPrompt, signal, logger) {
  logger.log(`POST https://api.anthropic.com/v1/messages (model=${model})`)
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })
  logger.log(`Response status: ${res.status}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic API error (${res.status})`)
  const text = data?.content?.[0]?.text
  if (!text) throw new Error('Claude returned an empty response')
  logger.log(`Received ${text.length} chars`)
  return text
}

async function callGemini(apiKey, model, userPrompt, signal, logger) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
  logger.log(`POST generativelanguage.googleapis.com (model=${model})`)
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0 },
    }),
  })
  logger.log(`Response status: ${res.status}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API error (${res.status})`)
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('')
  if (!text) throw new Error('Gemini returned an empty response')
  logger.log(`Received ${text.length} chars`)
  return text
}

// Reads an OpenAI-style SSE stream ("data: {json}\n\n", terminated by
// "data: [DONE]") off the response body and concatenates the delta text.
// Some providers/models — reasoning models especially — are slower or
// flat-out unsupported in non-streaming mode, so streaming is the more
// broadly-compatible way to talk to an arbitrary OpenAI-compatible endpoint.
async function readSseText(res, logger) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let chunkCount = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload)
        const delta = json?.choices?.[0]?.delta?.content
        if (delta) { full += delta; chunkCount++ }
      } catch {
        // Ignore a fragment that isn't valid JSON on its own — SSE lines can
        // arrive split across chunk boundaries; the buffer above re-joins them.
      }
    }
  }
  logger.log(`Streamed ${chunkCount} chunk(s), ${full.length} chars total`)
  return full
}

async function callOpenAiCompatible(baseUrl, apiKey, model, userPrompt, signal, logger) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
  logger.log(`POST ${url} (model=${model}, streaming)`)
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  })
  logger.log(`Response status: ${res.status}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const detail = data?.error?.message || data?.detail || data?.message || ''
    const hint = res.status === 404 ? ` — model "${model}" was not found on this provider. Pick a model from the dropdown in Settings → AI Assistant (use Refresh to load the live list).` : ''
    throw new Error(`API error (${res.status})${detail ? ': ' + detail : ''}${hint}`)
  }
  const text = await readSseText(res, logger)
  if (!text) throw new Error('The provider returned an empty response')
  return text
}

// ── Public API ────────────────────────────────────────────────────────────────

// Tracks in-flight requests by id so the renderer can cancel one via
// ai:cancel-generate — the "Ask AI" panel's Stop button.
const activeRequests = new Map()

function cancelGenerate(requestId) {
  const controller = activeRequests.get(requestId)
  if (!controller) return { success: false, error: 'No matching in-flight request' }
  controller.abort()
  return { success: true }
}

async function generateSql({ prompt, schema, dialect, requestId }) {
  const logger = makeLogger()

  if (!prompt || !prompt.trim()) return { success: false, error: 'Enter a request first', logs: logger.lines }

  const cfg = loadAiConfig()
  if (!cfg) {
    logger.log('No AI provider configured')
    return { success: false, error: 'No AI provider configured. Add an API key in Settings → AI Assistant.', logs: logger.lines }
  }

  const def = PROVIDERS[cfg.provider]
  const model = cfg.model || def.defaultModel
  const tableCount = schema && typeof schema === 'object' ? Object.keys(schema).length : 0
  logger.log(`Provider: ${def.label} (${cfg.provider}), model: ${model || '(none)'}`)
  logger.log(`Dialect: ${dialect || 'sql'}, schema: ${tableCount} table(s), prompt: "${prompt.trim().slice(0, 120)}"`)

  const schemaText = buildSchemaText(schema, logger)
  logger.log(`Schema text sent to model: ${schemaText.length} chars`)
  const userPrompt = `Dialect: ${dialect || 'sql'}\n\nSchema:\n${schemaText}\n\nRequest: ${prompt.trim()}`

  const controller = new AbortController()
  if (requestId) activeRequests.set(requestId, controller)

  // Some models (especially "reasoning" models with a high effort/thinking
  // budget) can take a long time or, on rare provider hiccups, never respond
  // at all — without a hard cap the renderer's loading spinner would spin
  // forever with no way out other than the user's own Stop click.
  let timedOut = false
  const REQUEST_TIMEOUT_MS = 90_000
  const timeoutId = setTimeout(() => { timedOut = true; logger.log(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`); controller.abort() }, REQUEST_TIMEOUT_MS)

  try {
    let raw
    if (def.kind === 'anthropic') {
      raw = await callAnthropic(cfg.apiKey, model, userPrompt, controller.signal, logger)
    } else if (def.kind === 'gemini') {
      raw = await callGemini(cfg.apiKey, model, userPrompt, controller.signal, logger)
    } else {
      const baseUrl = cfg.provider === 'custom' ? cfg.baseUrl : def.baseUrl
      if (!baseUrl) throw new Error('No base URL configured for this provider')
      if (!model) throw new Error('No model configured for this provider')
      raw = await callOpenAiCompatible(baseUrl, cfg.apiKey, model, userPrompt, controller.signal, logger)
    }
    logger.log('Done')
    return { success: true, sql: stripCodeFence(raw), logs: logger.lines }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (timedOut) {
        return { success: false, error: `No response after ${REQUEST_TIMEOUT_MS / 1000}s — the provider may be overloaded or unreachable.`, logs: logger.lines }
      }
      logger.log('Cancelled by user')
      return { success: false, cancelled: true, error: 'Cancelled', logs: logger.lines }
    }
    // Node's fetch() throws a bare "fetch failed" TypeError for anything below
    // the HTTP layer (DNS, TLS, connection refused, no route/proxy needed) —
    // the actually-useful detail is nested one level down in `.cause`.
    const cause = err.cause?.code || err.cause?.message || err.cause?.cause?.message
    const detail = cause ? `${err.message}: ${cause}` : (err.message || 'AI request failed')
    logger.log(`Error: ${detail}`)
    return { success: false, error: detail, logs: logger.lines }
  } finally {
    clearTimeout(timeoutId)
    if (requestId) activeRequests.delete(requestId)
  }
}

module.exports = { testModel, listModels, listProviders, saveAiConfig, getAiConfigStatus, clearAiConfig, generateSql, cancelGenerate }
