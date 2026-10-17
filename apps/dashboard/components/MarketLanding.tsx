import Link from "next/link";
import { AVATARS, ROLE_AVATAR } from "../lib/avatar-options";
import { ROLE_LABEL } from "../lib/labels";
import { ROLE_ORDER, ROLE_TAGLINE } from "../lib/roles";
import { SitePage } from "./Site";

const STEPS: Array<[string, string]> = [
  ["Pick an agent", "Choose a role. Each one does a single job well."],
  ["Set its limits", "Decide how much it can spend per purchase, per task and per day."],
  ["Turn it on", "It buys only what the job needs. Pause or stop it any time."],
];

export function MarketLanding() {
  return (
    <SitePage current="marketplace">
      <section className="hero">
        <p className="eyebrow">Marketplace</p>
        <h1>Hire agents that pay their own way</h1>
        <p className="lede">Each agent comes with a job, a budget you set, and a price list you can see.</p>
        <div className="hero-actions">
          <Link href="/market" className="btn btn-primary btn-large">
            Open marketplace
          </Link>
        </div>
        <p className="hero-note">Devnet only. No real funds move.</p>
      </section>

      <div className="featured-grid">
        {ROLE_ORDER.map((role) => {
          const avatar = AVATARS.find((a) => a.id === ROLE_AVATAR[role]) ?? AVATARS[0]!;
          return (
            <Link key={role} href={`/agents/new?role=${role}`} className={`featured featured-${role}`} id={role}>
              <img className="featured-avatar" src={avatar.src} alt="" width={84} height={84} />
              <span className="featured-text">
                <span className="featured-name">{ROLE_LABEL[role]}</span>
                <span className="featured-sub">{ROLE_TAGLINE[role]}</span>
              </span>
            </Link>
          );
        })}
      </div>

      <section className="site-section">
        <h2>How hiring works</h2>
        <ol className="steps">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="feature">
              <span className="step-num">{i + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="cta-band">
        <h2>Find your first agent</h2>
        <Link href="/market" className="btn btn-large">
          Open marketplace
        </Link>
      </section>
    </SitePage>
  );
}
