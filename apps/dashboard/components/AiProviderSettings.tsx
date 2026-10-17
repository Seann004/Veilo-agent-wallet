"use client";

import { useId, useState } from "react";
import { api } from "../lib/api";
import { useAction, useResource } from "./hooks";
import { Select, type SelectOption } from "./Select";
import { useCapability } from "./Shell";
import { DeniedHint, ErrorNotice, Section } from "./ui";

type Provider = "openrouter" | "anthropic" | "openai" | "openai_compatible";

interface ProviderView {
  provider: Provider;
  baseUrl: string;
  model: string;
  keyHint: string;
  updatedAt: string;
}

const PROVIDERS: Array<SelectOption<Provider>> = [
  { value: "openrouter", label: "OpenRouter", hint: "One key for many models (DeepSeek, Claude, GPT, Llama…)" },
  { value: "anthropic", label: "Anthropic (Claude)", hint: "Your Anthropic API key" },
  { value: "openai", label: "OpenAI", hint: "Your OpenAI API key" },
  { value: "openai_compatible", label: "Other (OpenAI-compatible)", hint: "Any provider or local server with a chat completions API" },
];

const MODEL_EXAMPLE: Record<Provider, string> = {
  openrouter: "deepseek/deepseek-v4-flash",
  anthropic: "claude-sonnet-5-5",
  openai: "your OpenAI model id",
  openai_compatible: "the model id your server expects",
};

/**
 * The owner's own model provider. The key is sent once and never shown again: the page only
 * ever sees the provider, model and the key's last four characters.
 */
export function AiProviderSettings() {
  const configure = useCapability("configure");
  const current = useResource(() => api<{ provider: ProviderView | null }>("control", "/ai-provider"), "ai-provider");
  const [provider, setProvider] = useState<Provider>("openrouter");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [tested, setTested] = useState<string | null>(null);
  const save = useAction();
  const test = useAction();
  const ids = { provider: useId(), model: useId(), base: useId(), key: useId() };
  const view = current.data?.provider ?? null;
  const label = (p: Provider) => PROVIDERS.find((x) => x.value === p)?.label ?? p;

  return (
    <Section title="AI model" id="ai-model">
      <p className="hint flush">
        Your agents think and write with your own model key. You pay your provider directly; Veilo never resells AI and agents never see the key. USDC from your
        private pool is only spent on paid data, tools, swaps and marketplace hires.
      </p>
      {view ? (
        <div className="notice notice-row" role="status">
          <span>
            Using <strong>{label(view.provider)}</strong> · <span className="mono">{view.model}</span> · key <span className="mono">{view.keyHint}</span>
          </span>
          <span className="actions">
            <button
              type="button"
              className="btn btn-small"
              disabled={test.busy}
              onClick={() =>
                void test.run(async () => {
                  setTested(null);
                  const r = await api<{ ok: boolean; model: string }>("control", "/ai-provider/test", { method: "POST", body: {} });
                  setTested(`Working: ${r.model} answered.`);
                })
              }
            >
              {test.busy ? "Testing…" : "Test"}
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={save.busy || !configure.allowed}
              onClick={() =>
                void save.run(async () => {
                  await api("control", "/ai-provider", { method: "DELETE" });
                  setTested(null);
                  await current.reload();
                })
              }
            >
              Remove
            </button>
          </span>
        </div>
      ) : (
        <p className="notice notice-warn">No AI key yet. Agents use a small sponsored trial until you add one.</p>
      )}
      {tested ? <p role="status" className="small">{tested}</p> : null}
      <ErrorNotice error={test.error} what="the model provider test" />
      {configure.allowed ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save.run(async () => {
              await api("control", "/ai-provider", {
                method: "PUT",
                body: { provider, model: model.trim(), apiKey: apiKey.trim(), ...(provider === "openai_compatible" ? { baseUrl: baseUrl.trim() } : {}) },
              });
              setApiKey("");
              setTested(null);
              await current.reload();
            });
          }}
        >
          <div className="grid-2">
            <div className="field">
              <label htmlFor={ids.provider}>Provider</label>
              <Select id={ids.provider} label="Provider" value={provider} options={PROVIDERS} onChange={setProvider} />
            </div>
            <div className="field">
              <label htmlFor={ids.model}>Model</label>
              <input id={ids.model} required maxLength={200} value={model} placeholder={MODEL_EXAMPLE[provider]} onChange={(e) => setModel(e.target.value)} />
            </div>
          </div>
          {provider === "openai_compatible" ? (
            <div className="field">
              <label htmlFor={ids.base}>Base URL</label>
              <input id={ids.base} required type="url" maxLength={300} value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
              <span className="hint">https only. A model server on this machine (localhost) works only if the operator enabled local providers.</span>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor={ids.key}>API key</label>
            <input id={ids.key} required type="password" autoComplete="off" maxLength={400} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <span className="hint">Stored encrypted on this machine. It is never shown again.</span>
          </div>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={save.busy || !apiKey.trim() || !model.trim()}>
              {view ? "Replace key" : "Save key"}
            </button>
          </div>
        </form>
      ) : (
        <DeniedHint reason={configure.reason} />
      )}
      <ErrorNotice error={save.error ?? current.error} what="AI model settings" />
    </Section>
  );
}
