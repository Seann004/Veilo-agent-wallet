import Link from "next/link";
import { AVATARS, ROLE_AVATAR } from "../lib/avatar-options";
import { ROLE_LABEL } from "../lib/labels";
import type { AgentRole } from "../lib/types";
import { Icon } from "./Icon";
import { SitePage } from "./Site";

const FEATURES: Array<[string, string]> = [
  ["A real role", "Shawn keeps inference credits topped up, Prince researches, Mira drafts campaigns. Each agent has one job, not a general-purpose wallet."],
  ["Hard limits on every purchase", "Per-purchase, per-task, per-agent and workspace 24-hour caps are checked together before anything is signed. Your wallet service enforces them; they are not on-chain caps."],
  ["Paid from a private pool", "Agents pay through a zero-knowledge pool on Solana devnet. The proof hides which of your deposits funded a payment; amounts, merchant and timing stay public."],
  ["Standard x402 payments", "Services are bought with ordinary x402 payments to approved merchants, each bound to an origin, SKU, network, mint and recipient."],
  ["Stop any time", "Pause or revoke one agent, or stop every agent at once. Payments already released stay visible, and your recovery and exit paths keep working."],
  ["Honest states", "“Paid; result unavailable” and “Waiting for confirmation” are shown as they are. An uncertain outcome is never reported as a failure or a success."],
];

const FAQ: Array<[string, string]> = [
  ["Is this real money?", "No. Veilo runs on Solana devnet with test-USDC. It refuses to start against mainnet, and test tokens do not buy real provider credits."],
  ["What does the private pool hide?", "It hides which deposit (note) paid for a withdrawal. Deposits, payouts, amounts, the mint, the merchant, the fresh wallet, fees and timing are public. A small pool or a distinctive amount gives weak privacy, and the privacy page says so."],
  ["Can an agent spend more than I allow?", "Every purchase must fit all applicable limits at once, inside one atomic reservation. These limits are enforced by your owner wallet service, not by the chain, so a compromised owner machine is outside what they protect."],
  ["Who pays for the model calls?", "Inference is operator-funded through OpenRouter and shown as demo credits. The label stays on screen wherever credits appear."],
  ["What happens when I stop an agent?", "It loses new spending authority immediately. A payment proof that was already released may still settle before it expires; it stays visible as live exposure, and recovery remains available."],
];

const ROSTER: AgentRole[] = ["credit_manager", "research", "content"];
const ROSTER_COPY: Record<AgentRole, string> = {
  credit_manager: "Watches shared inference credits and buys one pack when they run low, within cooldown and caps.",
  research: "Turns a question into a sourced brief, buying approved data services and marking incomplete claims.",
  content: "Drafts three channel posts and a seven-day calendar. Nothing is published for you.",
};

export function Landing() {
  return (
    <SitePage>
      <section className="hero" id="product">
        <p className="eyebrow">Solana devnet · test-USDC</p>
        <h1>Agents with budgets, not blank cheques</h1>
        <p className="lede">Give each agent a role and hard spending limits. They buy what the job needs with x402, paid from your private pool, and you can stop them at any moment.</p>
        <div className="hero-actions">
          <Link href="/workspace" className="btn btn-primary btn-large">
            Open workspace
          </Link>
          <Link href="/marketplace" className="btn btn-large">
            Browse the marketplace
          </Link>
        </div>
        <p className="hero-note">Devnet only. No real funds move.</p>
      </section>

      <figure className="shot">
        <img src="/marketing/hero-placeholder.svg" alt="Veilo workspace: agents in a sidebar, a task thread and the agent's limits" width={1600} height={900} />
      </figure>

      <section className="site-section">
        <h2>What makes a Veilo agent</h2>
        <p className="lede">Spending authority is the product. Everything an agent does is bounded, recorded and stoppable.</p>
        <div className="feature-grid">
          {FEATURES.map(([title, body]) => (
            <article key={title} className="feature">
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="site-section" id="privacy">
        <h2>A shared card versus a Veilo agent</h2>
        <p className="lede">Handing an agent a funded wallet works until it doesn't. Veilo puts the limits in front of the money.</p>
        <div className="contrast">
          <div className="contrast-card">
            <p className="eyebrow">Agent with a funded wallet</p>
            <h3>Spends whatever it holds.</h3>
            <ul>
              <li>One balance for every task</li>
              <li>Limits live in the prompt</li>
              <li>Every payment traces back to you</li>
              <li>Stopping means moving the money</li>
            </ul>
          </div>
          <div className="contrast-card">
            <p className="eyebrow">Veilo agent</p>
            <h3>Spends what its policy allows.</h3>
            <ul>
              <li>Per-purchase, task, agent and 24-hour caps</li>
              <li>Limits enforced outside the model</li>
              <li>Pays from a private pool; amounts and merchant stay public</li>
              <li>Pause, revoke or stop everything instantly</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="site-section">
        <h2>Meet the roster</h2>
        <p className="lede">Three roles ship today. Hire one from the marketplace and review its policy before it can spend.</p>
        <div className="roster">
          {ROSTER.map((role) => {
            const avatar = AVATARS.find((a) => a.id === ROLE_AVATAR[role]) ?? AVATARS[0]!;
            return (
              <Link key={role} href={`/marketplace#${role}`} className="roster-card">
                <img className="avatar" src={avatar.src} alt="" width={56} height={56} />
                <h3>{ROLE_LABEL[role]}</h3>
                <p>{ROSTER_COPY[role]}</p>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="site-section" id="faq">
        <h2>Good to know</h2>
        <div className="faq">
          {FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="site-section">
        <h2>Keep reading</h2>
        <ul className="link-list">
          <li>
            <Link href="/marketplace">
              Browse agents and services <Icon name="arrow" size={16} />
            </Link>
          </li>
          <li>
            <Link href="/workspace">
              Sign in to your workspace <Icon name="arrow" size={16} />
            </Link>
          </li>
          <li>
            <Link href="/agents/new">
              Create your first agent <Icon name="arrow" size={16} />
            </Link>
          </li>
        </ul>
      </section>

      <section className="cta-band">
        <h2>Create an agent and give it its first budget</h2>
        <Link href="/agents/new" className="btn btn-large">
          Create agent
        </Link>
      </section>
    </SitePage>
  );
}
