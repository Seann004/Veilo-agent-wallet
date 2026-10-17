"use client";

import { useId, useState } from "react";
import { api } from "../lib/api";
import { BRANDS, NEEDS_SIGN_IN } from "../lib/brands";
import type { Agent } from "../lib/types";
import { BrandLogo } from "./ConnectorFlows";
import { useAction, useResource } from "./hooks";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { ErrorNotice, Loading } from "./ui";

export type ChannelKind = "telegram" | "slack" | "discord";

export interface Channel {
  id: string;
  kind: ChannelKind;
  label: string;
  hint: string;
  createdAt: string;
  agentIds: string[];
}

const KINDS: Array<{ kind: ChannelKind; summary: string }> = [
  { kind: "telegram", summary: "Message you from your own bot" },
  { kind: "slack", summary: "Post to a channel" },
  { kind: "discord", summary: "Post to a channel" },
];

export function useChannels(enabled = true) {
  return useResource(() => (enabled ? api<{ channels: Channel[] }>("control", "/channels") : Promise.resolve({ channels: [] as Channel[] })), `channels-${enabled}`);
}

function AppCard({ kind, title, summary, by, status, onAdd, disabled }: { kind: keyof typeof BRANDS; title: string; summary: string; by?: string; status: "added" | "add" | "soon"; onAdd?: () => void; disabled?: boolean }) {
  return (
    <li className={`app-card${status === "soon" ? " app-card-soon" : ""}`}>
      <BrandLogo brand={BRANDS[kind]} size={44} />
      <span className="app-card-text">
        <strong>{title}</strong>
        <span className="small">{summary}</span>
        {by ? <span className="small muted">{by}</span> : null}
      </span>
      {status === "soon" ? (
        <span className="pill pill-muted">Soon</span>
      ) : status === "added" ? (
        <button type="button" className="icon-btn app-card-state" aria-label={`Add another ${title} destination`} disabled={disabled} onClick={onAdd} title="Connected · add another">
          <Icon name="check" size={18} />
        </button>
      ) : (
        <button type="button" className="icon-btn app-card-add" aria-label={`Add ${title}`} disabled={disabled} onClick={onAdd}>
          <Icon name="plus" size={18} />
        </button>
      )}
    </li>
  );
}

/** Chat apps that receive agents' finished results; these work today. */
export function SendResultsTo({ channels, canEdit, onChanged }: { channels: Channel[]; canEdit: boolean; onChanged: () => Promise<void> }) {
  const [adding, setAdding] = useState<ChannelKind | null>(null);
  return (
    <section className="connector-section" aria-labelledby="send-results">
      <h2 id="send-results" className="section-title">
        Send results to
      </h2>
      <p className="small muted">Get each finished job in your chat.</p>
      <ul className="app-grid" aria-label="Result destinations">
        {KINDS.map((k) => (
          <AppCard
            key={k.kind}
            kind={k.kind}
            title={BRANDS[k.kind].name}
            summary={k.summary}

            status={channels.some((c) => c.kind === k.kind) ? "added" : "add"}
            disabled={!canEdit}
            onAdd={() => setAdding(k.kind)}
          />
        ))}
      </ul>
      {adding ? (
        <ChannelDialog
          kind={adding}
          onClose={() => setAdding(null)}
          onSaved={async () => {
            setAdding(null);
            await onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

/** Popular apps that need an account sign-in. Listed so owners know where they stand; none can be added. */
export function ComingSoonApps() {
  return (
    <section className="connector-section" aria-labelledby="coming-soon">
      <h2 id="coming-soon" className="section-title">
        Coming soon
      </h2>

      <ul className="app-grid" aria-label="Apps that are not available yet">
        {NEEDS_SIGN_IN.map((a) => (
          <AppCard key={a.id} kind={a.id} title={BRANDS[a.id].name} summary={a.summary} status="soon" />
        ))}
      </ul>
    </section>
  );
}

function ChannelDialog({ kind, onClose, onSaved }: { kind: ChannelKind; onClose: () => void; onSaved: () => Promise<void> }) {
  const save = useAction();
  const find = useAction();
  const ids = { label: useId(), token: useId(), chat: useId(), hook: useId() };
  const [label, setLabel] = useState(kind === "telegram" ? "My Telegram" : `${BRANDS[kind].name} channel`);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [chats, setChats] = useState<Array<{ chatId: string; title: string }> | null>(null);
  const body = kind === "telegram" ? { kind, label: label.trim(), botToken: botToken.trim(), chatId: chatId.trim() } : { kind, label: label.trim(), webhookUrl: webhookUrl.trim() };
  const ready = label.trim() !== "" && (kind === "telegram" ? botToken.trim() !== "" && chatId.trim() !== "" : webhookUrl.trim() !== "");
  return (
    <Modal
      title={`Add ${BRANDS[kind].name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="channel-form"
            className="btn btn-primary"
            disabled={save.busy || !ready}
          >
            {save.busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form
        id="channel-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run(async () => {
            await api("control", "/channels", { method: "POST", body });
            await onSaved();
          });
        }}
      >
        {kind === "telegram" ? (
          <ol className="small steps-list">
            <li>
              In Telegram, message <strong>@BotFather</strong>, send <span className="mono">/newbot</span> and copy the token it gives you.
            </li>
            <li>Open your new bot and send it any message, so it can see your chat.</li>
            <li>Paste the token below and press Find my chat.</li>
          </ol>
        ) : (
          <p className="small muted">
            {kind === "slack"
              ? "In Slack, create an app with Incoming Webhooks turned on, add a webhook to the channel you want, and paste its URL (https://hooks.slack.com/services/…)."
              : "In Discord, open the channel's settings → Integrations → Webhooks, create one and paste its URL (https://discord.com/api/webhooks/…)."}
          </p>
        )}
        <div className="field">
          <label htmlFor={ids.label}>Name</label>
          <input id={ids.label} required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        {kind === "telegram" ? (
          <>
            <div className="field">
              <label htmlFor={ids.token}>Bot token</label>
              <input id={ids.token} required type="password" autoComplete="off" maxLength={100} value={botToken} onChange={(e) => setBotToken(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={ids.chat}>Chat</label>
              {chats && chats.length > 0 ? (
                <Select id={ids.chat} label="Chat" value={chatId} onChange={setChatId} options={[{ value: "", label: "Choose your chat" }, ...chats.map((c) => ({ value: c.chatId, label: `${c.title} (${c.chatId})` }))]} />
              ) : (
                <input id={ids.chat} required inputMode="numeric" maxLength={30} value={chatId} placeholder="Chat ID" onChange={(e) => setChatId(e.target.value)} />
              )}
              <span className="actions">
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={find.busy || botToken.trim() === ""}
                  onClick={() =>
                    void find.run(async () => {
                      const r = await api<{ chats: Array<{ chatId: string; title: string }> }>("control", "/channels/telegram/chats", { method: "POST", body: { botToken: botToken.trim() } });
                      setChats(r.chats);
                      if (r.chats.length === 1) setChatId(r.chats[0]!.chatId);
                    })
                  }
                >
                  {find.busy ? "Looking…" : "Find my chat"}
                </button>
              </span>
              {chats && chats.length === 0 ? <span className="hint">No chats yet. Send your bot a message in Telegram, then try again.</span> : null}
            </div>
            <ErrorNotice error={find.error} what="finding your chat" />
          </>
        ) : (
          <div className="field">
            <label htmlFor={ids.hook}>Webhook URL</label>
            <input id={ids.hook} required type="password" autoComplete="off" maxLength={300} value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
            <span className="hint">The URL works like a password, so it is stored encrypted and never shown again.</span>
          </div>
        )}
        <ErrorNotice error={save.error} what="saving the destination" />
      </form>
    </Modal>
  );
}

/** The owner's saved destinations, with which agents use each. */
export function YourChannels({ channels, agents, canEdit, onChanged }: { channels: Channel[]; agents: Agent[]; canEdit: boolean; onChanged: () => Promise<void> }) {
  const act = useAction();
  const [tested, setTested] = useState<string | null>(null);
  return (
    <section className="connector-section" aria-labelledby="your-destinations">
      <h2 id="your-destinations" className="section-title">
        Where results go
      </h2>
      {channels.length === 0 ? (
        <p className="small muted">No destinations yet. Add Telegram, Slack or Discord in Discover.</p>
      ) : (
        <ul className="connector-rows">
          {channels.map((c) => {
            const users = agents.filter((a) => c.agentIds.includes(a.id)).map((a) => a.name);
            return (
              <li key={c.id} className="connector-row">
                <BrandLogo brand={BRANDS[c.kind]} size={36} />
                <span className="connector-row-text">
                  <strong className="inline-text">{c.label}</strong>
                  <span className="small muted">
                    {BRANDS[c.kind].name} · {c.hint} · {users.length > 0 ? `Used by ${users.join(", ")}` : "No agent uses it yet"}
                  </span>
                  {tested === c.id ? <span className="small">Test message sent. Check {BRANDS[c.kind].name}.</span> : null}
                </span>
                <span className="actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={act.busy || !canEdit}
                    onClick={() =>
                      void act.run(async () => {
                        setTested(null);
                        await api("control", `/channels/${c.id}/test`, { method: "POST", body: {} });
                        setTested(c.id);
                      })
                    }
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={act.busy || !canEdit}
                    onClick={() =>
                      void act.run(async () => {
                        await api("control", `/channels/${c.id}`, { method: "DELETE" });
                        await onChanged();
                      })
                    }
                  >
                    Remove
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <ErrorNotice error={act.error} what="the destination" />
    </section>
  );
}

/** On an agent's page: where its finished results are sent. */
export function AgentDelivery({ agent, canEdit }: { agent: Agent; canEdit: boolean }) {
  const channels = useChannels(canEdit);
  const act = useAction();
  const id = useId();
  if (!canEdit) return null;
  if (channels.loading && !channels.data) return <Loading label="result destinations" />;
  const list = channels.data?.channels ?? [];
  const current = list.find((c) => c.agentIds.includes(agent.id))?.id ?? "";
  return (
    <div className="field">
      <label htmlFor={id}>Send finished results to</label>
      {list.length === 0 ? (
        <p className="small muted flush">
          Nowhere yet. Add Telegram, Slack or Discord under <a href="/connectors">Connectors</a>.
        </p>
      ) : (
        <Select
          id={id}
          label="Send finished results to"
          value={current}
          onChange={(v) =>
            void act.run(async () => {
              await api("control", `/agents/${agent.id}/delivery`, { method: "PUT", body: { channelId: v || null } });
              await channels.reload();
            })
          }
          options={[{ value: "", label: "Only keep them in Outputs" }, ...list.map((c) => ({ value: c.id, label: `${c.label} (${BRANDS[c.kind].name})` }))]}
        />
      )}
      <ErrorNotice error={act.error ?? channels.error} what="the result destination" />
    </div>
  );
}
