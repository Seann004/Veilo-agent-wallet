import Link from "next/link";
import { AVATARS, ROLE_AVATAR } from "../lib/avatar-options";
import { ROLE_LABEL } from "../lib/labels";
import { ROLE_ORDER, ROLE_TAGLINE } from "../lib/roles";
import { AvatarImage, BotMark, BotRow, type BotSpec } from "./Avatar";
import { SitePage } from "./Site";

export const HERO_BOTS: BotSpec[] = [
  { type: "droid", colour: "#8b5cf6", label: "Droid" },
  { type: "ghost", colour: "#14a38b", label: "Ghost" },
  { type: "star", colour: "#f5a524", label: "Star" },
  { type: "cat", colour: "#e8457f", label: "Cat" },
  { type: "mech", colour: "#3b82f6", label: "Mech" },
  { type: "drop", colour: "#22a565", label: "Drop" },
  { type: "alien", colour: "#f97316", label: "Alien" },
];

export const FEATURES: Array<{ title: string; body: string; bot: BotSpec }> = [
  { title: "Private pool payments", body: "Agents pay through a zero-knowledge pool. It hides which deposit paid; amount, merchant and timing stay public.", bot: HERO_BOTS[1]! },
  { title: "Per-agent limits", body: "Per-purchase, per-task and 24-hour caps are checked before anything is signed. Pause one agent or stop them all.", bot: HERO_BOTS[2]! },
  { title: "Hire and run workflows", body: "Hire specialists or run a ready-made workflow, and see each step and payment.", bot: HERO_BOTS[4]! },
];

export const STEPS: Array<[string, string]> = [
  ["Add an agent", "Pick a starter and set its budget."],
  ["Give it a job", "Ask in chat. It spends only within its limits."],
  ["Review the result", "Outputs and payments stay on record."],
];

const FAQ: Array<[string, string]> = [
  ["Is this real money?", "No. Veilo runs on Solana devnet with devnet USDC and refuses to start against mainnet."],
  ["What does the private pool hide?", "Which deposit paid for a withdrawal. Deposits, payouts, amounts, merchant, fees and timing are public. A small pool gives weak privacy."],
  ["Can an agent overspend?", "Every purchase must fit all limits at once. The limits are enforced by your owner wallet service, so a compromised owner machine is outside what they protect."],
  ["Who pays for model calls?", "The operator, through OpenRouter. They show as demo credits."],
];


export function Landing() {
  return (
    <SitePage>
      <section className="hero" id="product">
        <BotRow bots={HERO_BOTS} />
        <p className="eyebrow">Solana devnet · USDC</p>
        <h1>Agents with budgets, not blank cheques</h1>
        <p className="lede">Give each agent a job and a spending limit. Stop them whenever you want.</p>
        <div className="hero-actions">
          <Link href="/workspace" className="btn btn-primary btn-large">
            Open workspace
          </Link>
          <Link href="/marketplace/templates" className="btn btn-large">
            Browse agents
          </Link>
        </div>
        <p className="hero-note">Devnet only. No real funds move.</p>
      </section>

      <figure className="shot">
        <img src="/marketing/hero-placeholder.svg" alt="Veilo workspace: agents in a sidebar, a task thread and the agent's limits" width={1600} height={900} />
      </figure>

      <section className="site-section">
        <h2>Built for small budgets</h2>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <article key={f.title} className="feature">
              <BotMark bot={f.bot} size={48} />
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="site-section">
        <h2>How it works</h2>
        <ol className="steps">
          {STEPS.map(([title, body], i) => (
            <li key={title}>
              <span className="step-num" aria-hidden="true">{i + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="site-section">
        <div className="section-row">
          <h2>Meet the agents</h2>
          <Link href="/marketplace/templates">View all</Link>
        </div>
        <div className="roster">
          {ROLE_ORDER.map((role) => {
            const avatar = AVATARS.find((a) => a.id === ROLE_AVATAR[role]) ?? AVATARS[0]!;
            return (
              <Link key={role} href={`/market#${role}`} className="roster-card">
                <AvatarImage avatar={avatar} size={56} />
                <h3>{ROLE_LABEL[role]}</h3>
                <p>{ROLE_TAGLINE[role]}</p>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="site-section" id="faq">
        <h2>FAQ</h2>
        <div className="faq">
          {FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="cta-band">
        <h2>Hire your first agent</h2>
        <Link href="/agents/new" className="btn btn-large">
          Create agent
        </Link>
      </section>
    </SitePage>
  );
}
