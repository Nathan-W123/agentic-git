const orchestrationSteps = [
  "Plan with full repository context before touching the canonical codebase.",
  "Spin up isolated workspaces for humans and coding agents to execute safely.",
  "Score conflicts across files, symbols, dependencies, APIs, schemas, and tests.",
  "Promote validated changes atomically instead of relying on raw branch rituals.",
];

const platformHighlights = [
  {
    title: "Agent-neutral execution",
    body: "Run Codex, Claude, Gemini, or a generic JSONL agent through one governed coordination layer.",
  },
  {
    title: "Canonical repository safety",
    body: "Every promotion flows through validation, approval, and compare-and-swap integration rather than direct resets or merges.",
  },
  {
    title: "Human and AI collaboration",
    body: "Developers, reviewers, operators, and agents all work against the same source of truth without trampling each other.",
  },
  {
    title: "Deployment-ready control room",
    body: "Track tasks, approvals, diffs, history, workers, settings, rollback, and live replans from one web surface.",
  },
];

const proofPoints = [
  "Monorepo architecture spanning apps, services, adapters, and shared packages.",
  "Implemented support for isolated Git worktrees and optional Docker sandboxing.",
  "Durable queueing and audit history with SQLite and PostgreSQL support.",
  "Responsive web control room plus CLI tooling for real operational flows.",
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[var(--page-bg)] text-[var(--ink)]">
      <section className="hero-shell">
        <div className="hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">AI-native development coordination</p>
            <h1>
              Lattice turns many developers and agents into one reliable release
              system.
            </h1>
            <p className="lede">
              Built from this repository, Lattice is the orchestration layer
              between planning, isolated execution, safety checks, approvals,
              and atomic promotion into the canonical codebase.
            </p>
            <div className="hero-actions">
              <a className="primary-cta" href="#platform">
                Explore the platform
              </a>
              <a className="secondary-cta" href="#workflow">
                See the workflow
              </a>
            </div>
          </div>
          <div className="hero-panel" aria-label="Platform summary">
            <div className="signal-card">
              <span className="signal-label">What this repo delivers</span>
              <div className="metric-row">
                <strong>4 surfaces</strong>
                <span>apps, services, packages, adapters</span>
              </div>
              <div className="metric-row">
                <strong>1 canonical path</strong>
                <span>plan, validate, approve, promote</span>
              </div>
              <div className="metric-row">
                <strong>0 blind merges</strong>
                <span>coordination replaces unmanaged branch chaos</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section-band" id="platform">
        <div className="section-heading">
          <p className="section-kicker">Platform</p>
          <h2>Designed for teams that need more than a single coding agent.</h2>
        </div>
        <div className="card-grid">
          {platformHighlights.map((item) => (
            <article className="feature-card" key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section-band alt-band" id="workflow">
        <div className="section-heading narrow">
          <p className="section-kicker">Workflow</p>
          <h2>Every change moves through a lattice of evidence instead of hope.</h2>
        </div>
        <div className="timeline">
          {orchestrationSteps.map((step, index) => (
            <div className="timeline-step" key={step}>
              <div className="timeline-index">{String(index + 1).padStart(2, "0")}</div>
              <p>{step}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section-band">
        <div className="two-column">
          <div>
            <p className="section-kicker">Proof of depth</p>
            <h2>Not a mock concept. A real coordination stack with real boundaries.</h2>
          </div>
          <div className="proof-list" aria-label="Repository proof points">
            {proofPoints.map((item) => (
              <div className="proof-item" key={item}>
                <span className="proof-dot" aria-hidden="true" />
                <p>{item}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section-band closing-band">
        <div className="closing-card">
          <p className="section-kicker">Public site</p>
          <h2>Lattice is published for open access.</h2>
          <p>
            This deployment is configured for direct visiting so people can open
            the URL without needing to sign in through ChatGPT first.
          </p>
        </div>
      </section>
    </main>
  );
}
