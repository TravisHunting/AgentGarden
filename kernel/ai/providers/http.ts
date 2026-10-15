// Inference-API providers. API keys are read from environment variables only
// and are never stored in the game database.

import type { AgentProvider, ProviderSettings } from './types.ts';

async function postJson(url: string, headers: Record<string, string>, body: unknown, s: ProviderSettings, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(s.timeoutSeconds * 1000);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

export const anthropicApi: AgentProvider = {
  info: {
    id: 'anthropic-api',
    name: 'Anthropic API',
    kind: 'http',
    description: 'Calls the Claude Messages API directly. Reads ANTHROPIC_API_KEY from the environment.',
    modelSuggestions: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    defaultModel: 'claude-haiku-5-5',
    configHint: 'Set ANTHROPIC_API_KEY before starting the server.',
  },
  async available() {
    return process.env.ANTHROPIC_API_KEY ? { ok: true, detail: 'ANTHROPIC_API_KEY is set' } : { ok: false, detail: 'ANTHROPIC_API_KEY is not set' };
  },
  async complete(req, s) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
    const base = (s.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const data = await postJson(
      `${base}/v1/messages`,
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model: s.model, max_tokens: 16000, system: req.system, messages: [{ role: 'user', content: req.prompt }] },
      s,
      req.signal,
    );
    return (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('');
  },
};

export const openAiCompatible: AgentProvider = {
  info: {
    id: 'openai-compatible',
    name: 'OpenAI-compatible API',
    kind: 'http',
    description: 'Any /v1/chat/completions endpoint (OpenAI, OpenRouter, Ollama, LM Studio...). Reads OPENAI_API_KEY if set.',
    modelSuggestions: [],
    defaultModel: '',
    configHint: 'Set the base URL (e.g. http://localhost:11434/v1) and optionally OPENAI_API_KEY.',
  },
  async available(s) {
    return s.baseUrl ? { ok: true, detail: `endpoint ${s.baseUrl}` } : { ok: false, detail: 'no base URL configured' };
  },
  async complete(req, s) {
    if (!s.baseUrl) throw new Error('no base URL configured');
    const key = process.env.OPENAI_API_KEY;
    const data = await postJson(
      `${s.baseUrl.replace(/\/$/, '')}/chat/completions`,
      key ? { authorization: `Bearer ${key}` } : {},
      {
        model: s.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      },
      s,
      req.signal,
    );
    return data.choices?.[0]?.message?.content ?? '';
  },
};
