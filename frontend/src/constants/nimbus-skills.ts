/**
 * Nimbus Skills — 9 curated presets exposed via the Skills Panel and the
 * /skill slash command. Each skill maps to a recommended chat-completions
 * model on api.nimbusapi.net and a system prompt injected into the next turn
 * of the conversation.
 *
 * NOTE: Model ids are the user-visible Nimbus catalog names. The gateway
 * translates them to the appropriate upstream deployment. Never surface
 * upstream vendor plumbing in the customer UI.
 */

export type NimbusSkillAccent = "violet" | "cyan" | "amber" | "rose" | "emerald";

export interface NimbusSkill {
  /** Stable id used by /skill slash command and store key. */
  id: string;
  /** Card title. */
  name: string;
  /** One-line tagline shown under the title on the card. */
  tagline: string;
  /** Model id sent to /v1/chat/completions when the skill is activated. */
  recommendedModel: string;
  /** Marketing label for the model shown as a badge on the card. */
  modelLabel: string;
  /** Full system prompt injected at activation time. */
  systemPrompt: string;
  /** Emoji or short glyph used inside the card icon disc. */
  glyph: string;
  /** Accent colour token that maps to CSS variables in the panel stylesheet. */
  accent: NimbusSkillAccent;
  /** True when the skill benefits from browser + fetch tools. */
  usesBrowserTools?: boolean;
}

export const NIMBUS_SKILLS: NimbusSkill[] = [
  {
    id: "scroll-designer",
    name: "Scroll Designer",
    tagline: "Scroll-triggered heroes, parallax layers, reveal-on-scroll.",
    recommendedModel: "anthropic/claude-sonnet-5",
    modelLabel: "Sonnet 5",
    glyph: "S",
    accent: "violet",
    systemPrompt:
      "You are Nimbus's scroll-design specialist. Every layout uses Intersection Observer for reveal-on-scroll, sticky positioning for anchored heroes, transform+translate for parallax layers (max 3 depths), CSS scroll-linked animations where supported, prefers-reduced-motion fallbacks. Never scroll-jacking. Animations 300-800ms easeOut. Ship real code.",
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    tagline: "Adversarial line-by-line audit with concrete failure scenarios.",
    recommendedModel: "anthropic/claude-opus-4.8",
    modelLabel: "Opus 4.8",
    glyph: "R",
    accent: "cyan",
    systemPrompt:
      "You are Nimbus's code reviewer. Read every changed line. Flag: (1) bugs with concrete failure scenario, (2) security (auth/SSRF/XSS/SQLi/secrets), (3) perf smells with big-O, (4) readability with specific rewrite. NEVER approve without reading. Cite file:line.",
  },
  {
    id: "instant-concept",
    name: "Instant Concept",
    tagline: "Awwwards-style visual concepts with clarify chips.",
    recommendedModel: "anthropic/claude-sonnet-5",
    modelLabel: "Sonnet 5",
    glyph: "I",
    accent: "violet",
    systemPrompt:
      "You are Nimbus's Instant Concept specialist. If ambiguous, ask 2-4 targeted questions with chip options. Otherwise ship complete opinionated best-in-class: real content, specific palette/typography, 1-2 signature interactions, real responsive breakpoints. Full file, not snippet.",
  },
  {
    id: "deep-research",
    name: "Deep Research",
    tagline: "Multi-source cited synthesis using fetch + browser tools.",
    recommendedModel: "google/gemini-3.1-pro-preview",
    modelLabel: "Gemini 3.1 Pro",
    glyph: "D",
    accent: "emerald",
    usesBrowserTools: true,
    systemPrompt:
      "You are Nimbus's deep-research specialist. Break every request into 3-5 sub-questions, use fetch+browser tools to pull primary sources, cross-reference ≥3 sources per claim, cite every fact [source: URL], synthesize Executive Summary → Key Findings → Evidence → Gaps → Next Steps.",
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    tagline: "Python + pandas + charts with 3 non-obvious insights.",
    recommendedModel: "openai/gpt-5.4-mini",
    modelLabel: "GPT-5.4-mini",
    glyph: "A",
    accent: "amber",
    systemPrompt:
      "You are Nimbus's data analyst. State analytical goal, write clean Python (pandas/numpy/matplotlib/seaborn), explain each step, surface 3 non-obvious insights, produce chart/table per key finding. Always validate types + handle NaN.",
  },
  {
    id: "full-stack-builder",
    name: "Full-Stack Builder",
    tagline: "Next.js + Postgres + Auth + API in one clean scaffold.",
    recommendedModel: "anthropic/claude-opus-4.8",
    modelLabel: "Opus 4.8",
    glyph: "F",
    accent: "cyan",
    systemPrompt:
      "You are Nimbus's full-stack architect. Clarify scope in ≤3 questions if ambiguous. Design data model first (ERD+schema), scaffold Next.js App Router w/ server components+actions, wire NextAuth, implement CRUD w/ Prisma+Postgres, add Zod validation, ship full directory tree — no TODO stubs. Always add .env.example.",
  },
  {
    id: "security-auditor",
    name: "Security Auditor",
    tagline: "OWASP audit with concrete PoC exploits and remediation diffs.",
    recommendedModel: "anthropic/claude-opus-4.8",
    modelLabel: "Opus 4.8",
    glyph: "S",
    accent: "rose",
    systemPrompt:
      "You are Nimbus's adversarial security auditor. Check OWASP Top 10 per every code review, write concrete PoC exploit for each finding, rate CRITICAL/HIGH/MEDIUM/LOW, provide remediation diff. Never false positives — if you can't write a PoC, it's not a finding.",
  },
  {
    id: "product-strategist",
    name: "Product Strategist",
    tagline: "PRDs, personas, roadmaps, competitive positioning.",
    recommendedModel: "openai/gpt-5.1",
    modelLabel: "GPT-5.1",
    glyph: "P",
    accent: "amber",
    systemPrompt:
      "You are Nimbus's product strategist. Produce: (1) one-sentence north star, (2) target persona + #1 pain, (3) problem vs alternatives, (4) 3-tier feature set MoSCoW, (5) metrics DAU/NPS/rev/retention, (6) 90-day roadmap in 2-week sprints, (7) competitive positioning matrix. Never vague.",
  },
  {
    id: "debug-wizard",
    name: "Debug Wizard",
    tagline: "Root-cause commitment, minimal repro, before/after fix diff.",
    recommendedModel: "anthropic/claude-sonnet-5",
    modelLabel: "Sonnet 5",
    glyph: "W",
    accent: "rose",
    systemPrompt:
      "You are Nimbus's debug specialist. State most likely root cause in one sentence, list top 3 alternatives ranked by probability, write minimal repro, give exact fix w/ before/after diff, explain what invariant was violated. Never 'could be many things' — commit to root cause.",
  },
];

/**
 * URL hosted on nimbusapi.net that renders the atmospheric hero background
 * of the Skills Panel. Kept as a constant so a design refresh can be shipped
 * without touching component code.
 */
export const NIMBUS_SKILLS_PANEL_HERO_URL =
  "https://nimbusapi.net/brand/skills-panel-hero.png";

const SLUG_ALIASES: Record<string, string> = {
  scroll: "scroll-designer",
  design: "scroll-designer",
  review: "code-reviewer",
  reviewer: "code-reviewer",
  concept: "instant-concept",
  instant: "instant-concept",
  research: "deep-research",
  deep: "deep-research",
  data: "data-analyst",
  analyst: "data-analyst",
  fullstack: "full-stack-builder",
  builder: "full-stack-builder",
  security: "security-auditor",
  audit: "security-auditor",
  auditor: "security-auditor",
  strategy: "product-strategist",
  strategist: "product-strategist",
  product: "product-strategist",
  debug: "debug-wizard",
  wizard: "debug-wizard",
};

/**
 * Resolve a free-form user token (from `/skill <name>`, or a card click) to a
 * `NimbusSkill`. Accepts full ids, single-word aliases, and case-insensitive
 * display names ("Deep Research", "code-reviewer", "debug").
 */
export function resolveNimbusSkill(token: string): NimbusSkill | null {
  if (!token) return null;
  const t = token.trim().toLowerCase();
  const direct = NIMBUS_SKILLS.find(
    (s) => s.id === t || s.name.toLowerCase() === t,
  );
  if (direct) return direct;
  const aliasHit = SLUG_ALIASES[t];
  if (aliasHit) {
    return NIMBUS_SKILLS.find((s) => s.id === aliasHit) ?? null;
  }
  // last-ditch: contains-match on skill id
  return NIMBUS_SKILLS.find((s) => s.id.replace(/-/g, "").includes(t)) ?? null;
}

export function nimbusSkillById(id: string): NimbusSkill | null {
  return NIMBUS_SKILLS.find((s) => s.id === id) ?? null;
}
