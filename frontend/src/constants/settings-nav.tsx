import {
  FiUsers,
  FiBriefcase,
  FiBarChart2,
  FiDollarSign,
} from "react-icons/fi";
import CreditCardIcon from "#/icons/credit-card.svg?react";
import KeyIcon from "#/icons/key.svg?react";
import LightbulbIcon from "#/icons/lightbulb.svg?react";
import LockIcon from "#/icons/lock.svg?react";
import MemoryIcon from "#/icons/memory_icon.svg?react";
import RobotIcon from "#/icons/u-robot.svg?react";
import ServerProcessIcon from "#/icons/server-process.svg?react";
import SettingsGearIcon from "#/icons/settings-gear.svg?react";
import CircuitIcon from "#/icons/u-circuit.svg?react";
import PuzzlePieceIcon from "#/icons/u-puzzle-piece.svg?react";
import UserIcon from "#/icons/user.svg?react";

export type SettingsNavSection =
  | "org"
  | "personal"
  | "user"
  | "billing"
  | "other"
  // Claude's settings shape: a "Settings" group of things about your account
  // and how the product behaves, then a "Customize" group of things you add to
  // it (skills, connectors, and — once P7/P5 land — plugins and extensions).
  // A flat list of ten items had no such reading order; these two do.
  | "workspace"
  | "customize";

export interface SettingsNavItem {
  icon: React.ReactElement;
  to: string;
  text: string;
  section?: SettingsNavSection;
  // When true, this item is greyed out (and its route redirects to
  // ``/settings/agent``) while the personal-scope active agent is ACP.
  // The ACP sub-agent manages its own LLM and condenser, so those
  // OpenHands-side surfaces have no useful content. (MCP is intentionally
  // NOT flagged: MCP servers configured here are forwarded to the ACP
  // subprocess at session creation, so the page is meaningful under ACP.)
  // Drives both the navigation disable in ``use-settings-nav-items.ts``
  // and the server-side redirect in ``routes/settings.tsx`` from one source.
  disabledByAcp?: boolean;
}

export const SAAS_NAV_ITEMS: SettingsNavItem[] = [
  {
    icon: <FiBriefcase size={22} />,
    to: "/settings/org",
    text: "SETTINGS$NAV_ORGANIZATION",
    section: "org",
  },
  {
    icon: <FiUsers size={22} />,
    to: "/settings/org-members",
    text: "SETTINGS$NAV_ORG_MEMBERS",
    section: "org",
  },
  {
    icon: <FiBarChart2 size={22} />,
    to: "/settings/usage-monitoring",
    text: "SETTINGS$NAV_ADMIN_DASHBOARD",
    section: "org",
  },
  {
    icon: <FiDollarSign size={22} />,
    to: "/settings/budgets",
    text: "SETTINGS$NAV_BUDGETS",
    section: "org",
  },
  {
    icon: <CircuitIcon width={22} height={22} />,
    to: "/settings/org-defaults",
    text: "COMMON$LANGUAGE_MODEL_LLM",
    section: "org",
  },
  {
    icon: <MemoryIcon width={22} height={22} />,
    to: "/settings/org-defaults/condenser",
    text: "SETTINGS$NAV_CONDENSER",
    section: "org",
  },
  {
    icon: <LockIcon width={22} height={22} />,
    to: "/settings/org-defaults/verification",
    text: "SETTINGS$NAV_VERIFICATION",
    section: "org",
  },
  {
    icon: <RobotIcon width={22} height={22} />,
    to: "/settings/agent",
    text: "SETTINGS$AGENT",
    section: "personal",
  },
  {
    icon: <CircuitIcon width={22} height={22} />,
    to: "/settings",
    text: "COMMON$LANGUAGE_MODEL_LLM",
    section: "personal",
    disabledByAcp: true,
  },
  {
    icon: <MemoryIcon width={22} height={22} />,
    to: "/settings/condenser",
    text: "SETTINGS$NAV_CONDENSER",
    section: "personal",
    disabledByAcp: true,
  },
  {
    icon: <LockIcon width={22} height={22} />,
    to: "/settings/verification",
    text: "SETTINGS$NAV_VERIFICATION",
    section: "personal",
  },
  {
    icon: <KeyIcon width={22} height={22} />,
    to: "/settings/api-keys",
    text: "SETTINGS$NAV_API_KEYS",
    section: "personal",
  },
  {
    icon: <KeyIcon width={22} height={22} />,
    to: "/settings/secrets",
    text: "SETTINGS$NAV_SECRETS",
    section: "personal",
  },
  {
    icon: <ServerProcessIcon width={22} height={22} />,
    to: "/settings/mcp",
    text: "SETTINGS$NAV_MCP",
    section: "personal",
  },
  {
    icon: <UserIcon width={22} height={22} />,
    to: "/settings/user",
    text: "SETTINGS$NAV_USER",
    section: "user",
  },
  {
    icon: <SettingsGearIcon width={22} height={22} />,
    to: "/settings/app",
    text: "SETTINGS$NAV_APPLICATION",
    section: "user",
  },
  {
    icon: <CreditCardIcon width={22} height={22} />,
    to: "/settings/billing",
    text: "SETTINGS$NAV_BILLING",
    section: "billing",
  },
  {
    icon: <PuzzlePieceIcon width={22} height={22} />,
    to: "/settings/integrations",
    text: "SETTINGS$NAV_INTEGRATIONS",
    section: "other",
  },
  {
    icon: <LightbulbIcon width={22} height={22} />,
    to: "/settings/skills",
    text: "SETTINGS$NAV_SKILLS",
    section: "other",
  },
];

export const OSS_NAV_ITEMS: SettingsNavItem[] = [
  /*
   * API Keys was reachable only by hand-typing the URL: the page is built but
   * lived in SAAS_NAV_ITEMS only, and this deployment runs app_mode "oss", so
   * nothing linked to it and a customer could not manage their own keys from
   * inside the product. It is a per-user surface, so it belongs here.
   *
   * Usage-monitoring and Budgets are deliberately NOT added. They are also
   * listed in ADMIN_ONLY_SETTINGS_PATHS — usage-monitoring's own label is
   * SETTINGS$NAV_ADMIN_DASHBOARD — so they are org-admin views, and surfacing
   * them to every customer risks showing one customer another's usage. Per-
   * customer spend belongs on a per-customer page, not by un-gating an admin
   * dashboard.
   */
  // ── Settings ──────────────────────────────────────────────────────────
  {
    icon: <SettingsGearIcon width={22} height={22} />,
    to: "/settings/app",
    text: "SETTINGS$NAV_APPLICATION",
    section: "workspace",
  },
  {
    icon: <RobotIcon width={22} height={22} />,
    to: "/settings/agent",
    text: "SETTINGS$AGENT",
    section: "workspace",
  },
  {
    icon: <CircuitIcon width={22} height={22} />,
    to: "/settings",
    text: "SETTINGS$NAV_LLM",
    section: "workspace",
    disabledByAcp: true,
  },
  {
    icon: <MemoryIcon width={22} height={22} />,
    to: "/settings/condenser",
    text: "SETTINGS$NAV_CONDENSER",
    section: "workspace",
    disabledByAcp: true,
  },
  {
    icon: <LockIcon width={22} height={22} />,
    to: "/settings/verification",
    text: "SETTINGS$NAV_VERIFICATION",
    section: "workspace",
  },
  {
    icon: <KeyIcon width={22} height={22} />,
    to: "/settings/api-keys",
    text: "SETTINGS$NAV_API_KEYS",
    section: "workspace",
  },
  {
    icon: <KeyIcon width={22} height={22} />,
    to: "/settings/secrets",
    text: "SETTINGS$NAV_SECRETS",
    section: "workspace",
  },

  // ── Customize ─────────────────────────────────────────────────────────
  // What you ADD to the product, as opposed to how it already behaves.
  {
    icon: <LightbulbIcon width={22} height={22} />,
    to: "/settings/skills",
    text: "SETTINGS$NAV_SKILLS",
    section: "customize",
  },
  {
    icon: <PuzzlePieceIcon width={22} height={22} />,
    to: "/settings/integrations",
    // "Connectors" is what this is called everywhere else in the market, and
    // what customers arrive looking for. "Integrations" is the same page.
    text: "SETTINGS$NAV_CONNECTORS",
    section: "customize",
  },
  {
    icon: <ServerProcessIcon width={22} height={22} />,
    to: "/settings/mcp",
    text: "SETTINGS$NAV_MCP",
    section: "customize",
  },
];
