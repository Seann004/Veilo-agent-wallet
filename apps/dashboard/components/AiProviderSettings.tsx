"use client";

import { useId, useState } from "react";
import { api } from "../lib/api";
import { useAction, useResource } from "./hooks";
import { Select, type SelectOption } from "./Select";
import { useCapability } from "./Shell";
import { DeniedHint, ErrorNotice, Section } from "./ui";

type Provider = "openrouter" | "anthropic" | "openai" | "openai_compatible";
/** What the owner picks; Z.ai is an OpenAI-compatible provider with known base URLs. */
type Preset = "openrouter" | "anthropic" | "openai" | "zai" | "custom";

interface ProviderView {
  provider: Provider;
  baseUrl: string;
  model: string;
  keyHint: string;
  updatedAt: string;
}

const ZAI_GENERAL = "https://api.z.ai/api/paas/v4";
const ZAI_CODING = "https://api.z.ai/api/coding/paas/v4";

const PRESETS: Array<SelectOption<Preset>> = [
  { value: "openrouter", label: "OpenRouter", hint: "One key for many models (DeepSeek, GLM, Claude, GPT…)" },
  { value: "anthropic", label: "Anthropic (Claude)", hint: "Your Anthropic API key" },
  { value: "openai", label: "OpenAI (GPT, Codex)", hint: "Your OpenAI API key" },
  { value: "zai", label: "Z.ai (GLM)", hint: "Your Z.ai API key or GLM Coding Plan key" },
  { value: "custom", label: "Other (OpenAI-compatible)", hint: "Any provider or server with a chat completions API" },
];

/** Starting points only; "Load models" asks the provider for its real list. */
const SUGGESTED: Record<Preset, string[]> = {
  openrouter: ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash"],
  anthropic: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
  openai: [],
  zai: ["glm-5.3-flash", "glm-5.3"],
  custom: [],
};

function presetOf(v: ProviderView): Preset {
  if (v.provider !== "openai_compatible") return v.provider;
  return v.baseUrl === ZAI_GENERAL || v.baseUrl === ZAI_CODING ? "zai" : "custom";
}

/**
 * The owner's own model provider. The key is sent to control and never shown again: the page
 * only ever sees the provider, model and the key's last four characters.
 */
export function AiProviderSettings() {
  const configure = useCapability("configure");
  const current = useResource(() => api<{ provider: ProviderView | null }>("control", "/ai-provider"), "ai-provider");
  const [preset, setPreset] = useState<Preset>("openrouter");
  const [codingPlan, setCodingPlan] = useState(false);
  const [model, setModel] = useState("");
  const [typing, setTyping] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loaded, setLoaded] = useState<string[] | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const save = useAction();
  const test = useAction();
  const load = useAction();
  const ids = { preset: useId(), model: useId(), base: useId(), key: useId(), coding: useId() };
  const view = current.data?.provider ?? null;

  const provider: Provider = preset === "zai" || preset === "custom" ? "openai_compatible" : preset;
  const url = preset === "zai" ? (codingPlan ? ZAI_CODING : ZAI_GENERAL) : preset === "custom" ? baseUrl.trim() : undefined;
  const choices = [...new Set([...(loaded ?? []), ...SUGGESTED[preset]])];
  const modelOptions: Array<SelectOption<string>> = [{ value: "", label: "Choose a model" }, ...choices.map((m) => ({ value: m, label: m }))];
  const label = (v: ProviderView) => PRESETS.find((x) => x.value === presetOf(v))?.label ?? v.provider;

  const pick = (p: Preset) => {
    setPreset(p);
    setModel("");
    setLoaded(null);
    setTyping(false);
  };

  return (
    <Section title="AI model" id="ai-model">
      <p className="hint flush">
        Your agents think and write with your own model key. You pay your provider directly; Veilo never resells AI and agents never see the key. USDC from your
        private pool is only spent on paid data, tools, swaps and marketplace hires.
      </p>
      {view ? (
        <div className="notice notice-row" role="status">
          <span>
            Using <strong>{label(view)}</strong> · <span className="mono">{view.model}</span> · key <span className="mono">{view.keyHint}</span>
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
                body: { provider, model: model.trim(), apiKey: apiKey.trim(), ...(url !== undefined ? { baseUrl: url } : {}) },
              });
              setApiKey("");
              setTested(null);
              await current.reload();
            });
          }}
        >
          <div className="field">
            <label htmlFor={ids.preset}>Provider</label>
            <Select id={ids.preset} label="Provider" value={preset} options={PRESETS} onChange={pick} />
          </div>
          {preset === "zai" ? (
            <div className="field inline">
              <input id={ids.coding} type="checkbox" checked={codingPlan} onChange={(e) => setCodingPlan(e.target.checked)} />
              <label htmlFor={ids.coding}>This is a GLM Coding Plan key</label>
            </div>
          ) : null}
          {preset === "custom" ? (
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
          <div className="field">
            <label htmlFor={ids.model}>Model</label>
            {typing ? (
              <input id={ids.model} required maxLength={200} value={model} placeholder="Model id, exactly as your provider names it" onChange={(e) => setModel(e.target.value)} />
            ) : (
              <Select id={ids.model} label="Model" value={choices.includes(model) ? model : ""} options={modelOptions} onChange={setModel} />
            )}
            <span className="actions">
              <button
                type="button"
                className="btn btn-small"
                disabled={load.busy || (!apiKey.trim() && !view) || (preset === "custom" && !url)}
                onClick={() =>
                  void load.run(async () => {
                    const r = await api<{ models: string[] }>("control", "/ai-provider/models", {
                      method: "POST",
                      body: { provider, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(url !== undefined ? { baseUrl: url } : {}) },
                    });
                    setLoaded(r.models);
                    setTyping(false);
                  })
                }
              >
                {load.busy ? "Loading…" : "Load models"}
              </button>
              <button type="button" className="btn btn-small" onClick={() => setTyping(!typing)}>
                {typing ? "Pick from the list" : "Type a model id instead"}
              </button>
            </span>
            {loaded !== null ? <span className="hint">{loaded.length > 0 ? `${loaded.length} models from your provider.` : "Your provider returned no model list; pick a suggestion or type an id."}</span> : null}
          </div>
          <ErrorNotice error={load.error} what="loading models (you can still type a model id)" />
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
