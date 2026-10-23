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

const SYSTEM_PROMPT = `You are a SQL generation assistant embedded in a database client. Given a database schema and a natural-language request, respond in exactly this format:
1. A single valid SQL query for the given SQL dialect inside one \`\`\`sql fenced code block (raw SQL only inside the block, no comments).
2. After the block, one or two short sentences explaining what the query does, written in the same language the user's request was written in. Do not repeat the SQL and do not add any other text.

The schema below is the complete, authoritative list of tables and columns that exist. You MUST only reference table and column names that literally appear in it, spelled exactly as given — never invent, guess, pluralize/singularize, or "correct" a name that seems plausible but isn't listed. If the request doesn't clearly map to any table/column in the schema, pick the closest real match from the schema rather than fabricating a new one. If the request is otherwise ambiguous, make a reasonable assumption and still produce a query.`;

const MULTI_SYSTEM_PROMPT = `You are a SQL generation assistant embedded in a database client that is connected to SEVERAL databases at once (possibly on different servers). One SQL statement can only run on ONE database and can never join or reference another database, so a request that spans databases must be split into one query per database. Respond in exactly this format:
1. One fenced \`\`\`sql code block for every database the request needs. The first line inside each block must be a comment of the form "-- db: <label>" using the exact label from the database list, followed by one valid SQL query for that database's dialect (no other comments).
2. If the request asks to compare data across databases (for example "values in A that are not in B"), each block must select the values to compare as its FIRST column, and right after the blocks add one line: "COMPARE: <n> NOT IN <m>" (values from block n that do not appear in block m) or "COMPARE: <n> IN <m>" (values present in both). n and m are block numbers starting at 1. Leave this line out when no comparison is requested.
3. Then one or two short sentences explaining what you did, in the same language the user's request was written in. No other text.
If the request does not mention a specific database, it is about the default database named in the request: write exactly one block for it and do not touch the others.
Only use tables and columns that literally appear in the schema of the database a block is written for, spelled exactly as listed.`;

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

// Splits a reply into the SQL (from the first fenced block, or the whole text if
// the model ignored the format) and the explanation that follows it.
function parseReply(text) {
  const fenced = text.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  if (!fenced) {
    // Model ignored the fence: keep leading paragraphs that look like SQL, the rest is the explanation
    const SQL_START = /^\s*(?:(?:select|with|insert|update|delete|create|alter|drop|truncate|explain|show|describe|set|begin|commit|rollback|grant|revoke|merge|call|values|from|where|group|order|limit|having|union|join|left|right|inner|returning)\b|--)/i
    const paras = text.trim().split(/\n\s*\n/)
    let n = 1
    // "Truncated both tables." starts with a keyword too: prose ends with a period, SQL doesn't
    const looksSql = (para) => SQL_START.test(para) && !/[.!?:]\s*$/.test(para)
    while (n < paras.length && looksSql(paras[n])) n++
    const joinBlank = (list) => list.join('\n\n')
    return {
      sql: stripCodeFence(joinBlank(paras.slice(0, n))),
      explanation: joinBlank(paras.slice(n)).replace(/^\s*(?:explanation|explain)\s*:\s*/i, '').trim(),
    }
  }
  const explanation = text.slice(fenced.index + fenced[0].length).replace(/^\s*(?:explanation|explain)\s*:\s*/i, '').trim()
  return { sql: fenced[1].trim(), explanation }
}

// Multi-database reply: several fenced blocks tagged "-- db: <label>", an optional
// "COMPARE: n NOT IN m" line, then an explanation.
function parseMultiReply(text) {
  // "COMPARE: n NOT IN m" can appear anywhere; pull it out first
  let compare = null
  const cmp = text.match(/COMPARE\s*:\s*(\d+)\s+(NOT\s+IN|IN)\s+(\d+)/i)
  if (cmp) {
    compare = { left: parseInt(cmp[1], 10), op: /not/i.test(cmp[2]) ? 'NOT IN' : 'IN', right: parseInt(cmp[3], 10) }
    text = text.replace(cmp[0], '')
  }

  const queries = []
  // Split a body at every "-- db: <label>" line: models often put several databases in one block
  const addSegments = (body) => {
    body.split(/^(?=[ \t]*--[ \t]*db[ \t]*:)/im).forEach(part => {
      const tag = part.match(/^[ \t]*--[ \t]*db[ \t]*:[ \t]*(.+)$/im)
      const sql = (tag ? part.replace(tag[0], '') : part).trim()
      if (sql) queries.push({ db: tag ? tag[1].trim() : null, sql })
    })
  }
  const cleanExplanation = (t) => t.replace(/^\s*(?:explanation|explain)\s*:\s*/i, '').replace(/\n{3,}/g, '\n\n').trim()

  const fenceRe = /```(?:sql)?\s*([\s\S]*?)```/gi
  let m
  while ((m = fenceRe.exec(text)) !== null) addSegments(m[1])
  if (queries.length > 0) {
    return { queries, compare, explanation: cleanExplanation(text.replace(/```(?:sql)?\s*[\s\S]*?```/gi, '')) }
  }

  // No fences at all: everything from the first "-- db:" line on is SQL (plus maybe trailing prose)
  const marker = text.match(/^[ \t]*--[ \t]*db[ \t]*:/im)
  if (marker) {
    const before = text.slice(0, marker.index)
    addSegments(text.slice(marker.index))
    const last = queries[queries.length - 1]
    const tail = parseReply(last.sql)
    last.sql = tail.sql
    return { queries, compare, explanation: cleanExplanation([before, tail.explanation].filter(Boolean).join('\n\n')) }
  }

  const single = parseReply(text)
  return { queries: [{ db: null, sql: single.sql }], compare, explanation: single.explanation }
}

function stripCodeFence(text) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:sql)?\s*([\s\S]*?)\s*```$/i)
  return (fenced ? fenced[1] : trimmed).trim()
}

// ── Provider calls ──────────────────────────────────────────────────────────────

async function callAnthropic(apiKey, model, userPrompt, signal, logger, systemPrompt = SYSTEM_PROMPT) {
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
      system: systemPrompt,
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

async function callGemini(apiKey, model, userPrompt, signal, logger, systemPrompt = SYSTEM_PROMPT) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
  logger.log(`POST generativelanguage.googleapis.com (model=${model})`)
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
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

async function callOpenAiCompatible(baseUrl, apiKey, model, userPrompt, signal, logger, systemPrompt = SYSTEM_PROMPT) {
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
        { role: 'system', content: systemPrompt },
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

async function generateSql({ prompt, schema, dialect, requestId, databases, defaultDatabase }) {
  const multi = Array.isArray(databases) && databases.length > 1
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

  let userPrompt
  let systemPrompt = SYSTEM_PROMPT
  if (multi) {
    systemPrompt = MULTI_SYSTEM_PROMPT
    const sections = databases.map(d => {
      const text = buildSchemaText(d.schema, logger)
      logger.log(`Database "${d.label}": ${Object.keys(d.schema || {}).length} table(s), ${text.length} chars`)
      return `### ${d.label} (dialect: ${d.dialect || 'sql'})\n${text}`
    })
    const defaultLine = defaultDatabase ? `Default database (use it when the request names none): ${defaultDatabase}\n\n` : ''
    userPrompt = `Databases:\n\n${sections.join('\n\n')}\n\n${defaultLine}Request: ${prompt.trim()}`
    logger.log(`Multi-database mode: ${databases.length} databases, ${userPrompt.length} chars sent`)
  } else {
    const schemaText = buildSchemaText(schema, logger)
    logger.log(`Schema text sent to model: ${schemaText.length} chars`)
    userPrompt = `Dialect: ${dialect || 'sql'}\n\nSchema:\n${schemaText}\n\nRequest: ${prompt.trim()}`
  }

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
      raw = await callAnthropic(cfg.apiKey, model, userPrompt, controller.signal, logger, systemPrompt)
    } else if (def.kind === 'gemini') {
      raw = await callGemini(cfg.apiKey, model, userPrompt, controller.signal, logger, systemPrompt)
    } else {
      const baseUrl = cfg.provider === 'custom' ? cfg.baseUrl : def.baseUrl
      if (!baseUrl) throw new Error('No base URL configured for this provider')
      if (!model) throw new Error('No model configured for this provider')
      raw = await callOpenAiCompatible(baseUrl, cfg.apiKey, model, userPrompt, controller.signal, logger, systemPrompt)
    }
    logger.log('Done')
    if (multi) {
      const parsed = parseMultiReply(raw)
      return { success: true, sql: parsed.queries[0]?.sql || '', ...parsed, logs: logger.lines }
    }
    const { sql, explanation } = parseReply(raw)
    return { success: true, sql, explanation, logs: logger.lines }
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

// ── ER diagram assistant ────────────────────────────────────────────────────
const ER_SYSTEM_PROMPT = `You are a database design assistant embedded in an ER-diagram viewer. You get the tables (with columns) and the declared foreign keys of one database, then a question. Reply with ONE JSON object and nothing else (no markdown fence), in exactly this shape:
{"answer": "<short, helpful answer in the same language as the question>", "tables": ["<schema.table>", ...], "relations": [{"sourceTable": "<schema.table>", "sourceColumn": "<column>", "targetTable": "<schema.table>", "targetColumn": "<column>", "reason": "<one short sentence>"}]}
Rules:
- "tables": the tables the answer is about (shown highlighted on the diagram), spelled exactly as in the schema. Use [] if none.
- "relations": ONLY foreign-key relationships that are probably missing, i.e. NOT already in the declared foreign keys. Use [] unless the question asks about missing/implicit/inferred relations. Infer from column names (user_id -> users.id), types and naming conventions. Every table and column must literally exist in the schema; sourceColumn is the referencing (child) column.
- Keep "answer" concise; use plain text, short lines or "-" bullets.`

function buildErText(tables, foreignKeys, withTypes) {
  const lines = tables.map(t => {
    const cols = (t.columns || []).map(c => withTypes && c.type ? `${c.name} ${c.type}` : c.name).join(', ')
    return `${t.fullName}(${cols})`
  })
  const fks = (foreignKeys || []).map(f => `${f.sourceTable}.${f.sourceColumn} -> ${f.targetTable}.${f.targetColumn}`)
  return `Tables:\n${lines.join('\n')}\n\nDeclared foreign keys (${fks.length}):\n${fks.join('\n') || '(none)'}`
}

function parseErReply(raw) {
  const text = String(raw || '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1))
      return {
        answer: typeof obj.answer === 'string' ? obj.answer : '',
        tables: Array.isArray(obj.tables) ? obj.tables.filter(t => typeof t === 'string') : [],
        relations: Array.isArray(obj.relations) ? obj.relations.filter(r => r && r.sourceTable && r.sourceColumn && r.targetTable && r.targetColumn) : [],
      }
    } catch { /* fall through: treat as plain text */ }
  }
  return { answer: text, tables: [], relations: [] }
}

async function askEr({ question, tables, foreignKeys, requestId }) {
  const logger = makeLogger()
  if (!question || !question.trim()) return { success: false, error: 'Enter a question first', logs: logger.lines }
  if (!Array.isArray(tables) || tables.length === 0) return { success: false, error: 'No tables loaded', logs: logger.lines }

  const cfg = loadAiConfig()
  if (!cfg) return { success: false, error: 'No AI provider configured. Add an API key in Settings → AI Assistant.', logs: logger.lines }
  const def = PROVIDERS[cfg.provider]
  const model = cfg.model || def.defaultModel

  // Large schemas: drop column types first, then cap the table list, to stay inside the context window
  const MAX_CHARS = 60000
  let text = buildErText(tables, foreignKeys, true)
  if (text.length > MAX_CHARS) text = buildErText(tables, foreignKeys, false)
  let truncated = false
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true }
  logger.log(`ER ask via ${def.label}/${model}: ${tables.length} tables, ${(foreignKeys || []).length} FKs, ${text.length} chars${truncated ? ' (truncated)' : ''}`)
  const userPrompt = `${text}\n\nQuestion: ${question.trim()}`

  const controller = new AbortController()
  if (requestId) activeRequests.set(requestId, controller)
  let timedOut = false
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort() }, 90_000)
  try {
    let raw
    if (def.kind === 'anthropic') {
      raw = await callAnthropic(cfg.apiKey, model, userPrompt, controller.signal, logger, ER_SYSTEM_PROMPT)
    } else if (def.kind === 'gemini') {
      raw = await callGemini(cfg.apiKey, model, userPrompt, controller.signal, logger, ER_SYSTEM_PROMPT)
    } else {
      const baseUrl = cfg.provider === 'custom' ? cfg.baseUrl : def.baseUrl
      if (!baseUrl) throw new Error('No base URL configured for this provider')
      if (!model) throw new Error('No model configured for this provider')
      raw = await callOpenAiCompatible(baseUrl, cfg.apiKey, model, userPrompt, controller.signal, logger, ER_SYSTEM_PROMPT)
    }
    return { success: true, ...parseErReply(raw), truncated, logs: logger.lines }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (timedOut) return { success: false, error: 'No response after 90s — the provider may be overloaded or unreachable.', logs: logger.lines }
      return { success: false, cancelled: true, error: 'Cancelled', logs: logger.lines }
    }
    const cause = err.cause?.code || err.cause?.message || err.cause?.cause?.message
    return { success: false, error: cause ? `${err.message}: ${cause}` : (err.message || 'AI request failed'), logs: logger.lines }
  } finally {
    clearTimeout(timeoutId)
    if (requestId) activeRequests.delete(requestId)
  }
}

module.exports = { testModel, listModels, listProviders, saveAiConfig, getAiConfigStatus, clearAiConfig, generateSql, cancelGenerate, askEr }
