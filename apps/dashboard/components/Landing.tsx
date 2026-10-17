import Link from "next/link";
import { AVATARS, ROLE_AVATAR } from "../lib/avatar-options";
import { ROLE_LABEL } from "../lib/labels";
import { ROLE_ORDER, ROLE_TAGLINE } from "../lib/roles";
import { SitePage } from "./Site";

const FEATURES: Array<[string, string]> = [
  ["Hard limits", "Per-purchase, per-task and 24-hour caps are checked before anything is signed. Enforced by your wallet service, not on-chain."],
  ["Private payments", "Agents pay through a zero-knowledge pool. It hides which deposit paid; amount, merchant and timing stay public."],
  ["Stop any time", "Pause one agent or stop them all. Your recovery and exit paths keep working."],
];

const FAQ: Array<[string, string]> = [
  ["Is this real money?", "No. Veilo runs on Solana devnet with test-USDC and refuses to start against mainnet."],
  ["What does the private pool hide?", "Which deposit paid for a withdrawal. Deposits, payouts, amounts, merchant, fees and timing are public. A small pool gives weak privacy."],
  ["Can an agent overspend?", "Every purchase must fit all limits at once. The limits are enforced by your owner wallet service, so a compromised owner machine is outside what they protect."],
  ["Who pays for model calls?", "The operator, through OpenRouter. They show as demo credits."],
];


export function Landing() {
  return (
    <SitePage>
      <section className="hero" id="product">
        <p className="eyebrow">Solana devnet · test-USDC</p>
        <h1>Agents with budgets, not blank cheques</h1>
        <p className="lede">Give each agent a job and a spending limit. Stop them whenever you want.</p>
        <div className="hero-actions">
          <Link href="/workspace" className="btn btn-primary btn-large">
            Open workspace
          </Link>
          <Link href="/market" className="btn btn-large">
            Browse agents
          </Link>
        </div>
        <p className="hero-note">Devnet only. No real funds move.</p>
      </section>

      <figure className="shot">
        <img src="/marketing/hero-placeholder.svg" alt="Veilo workspace: agents in a sidebar, a task thread and the agent's limits" width={1600} height={900} />
      </figure>

      <section className="site-section">
        <h2>How it works</h2>
        <div className="feature-grid">
          {FEATURES.map(([title, body]) => (
            <article key={title} className="feature">
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="site-section">
        <div className="section-row">
          <h2>Meet the agents</h2>
          <Link href="/market">View all</Link>
        </div>
        <div className="roster">
          {ROLE_ORDER.map((role) => {
            const avatar = AVATARS.find((a) => a.id === ROLE_AVATAR[role]) ?? AVATARS[0]!;
            return (
              <Link key={role} href={`/market#${role}`} className="roster-card">
                <img className="avatar" src={avatar.src} alt="" width={56} height={56} />
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
