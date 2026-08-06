import { useConfig } from "#/hooks/query/use-config";
import {
  SAAS_NAV_ITEMS,
  OSS_NAV_ITEMS,
  SettingsNavItem,
  SettingsNavSection,
} from "#/constants/settings-nav";
import { OrganizationUserRole } from "#/types/org";
import { isBillingHidden } from "#/utils/org/billing-visibility";
import {
  ADMIN_ONLY_SETTINGS_PATHS,
  isSettingsPageHidden,
} from "#/utils/settings-utils";
import { useMe } from "./query/use-me";
import { usePermission } from "./organizations/use-permissions";
import { useOrgTypeAndAccess } from "./use-org-type-and-access";
import { useSettings } from "./query/use-settings";
import { I18nKey } from "#/i18n/declaration";

// Rendered navigation item types
export type SettingsNavRenderedItem =
  | {
      type: "item";
      item: SettingsNavItem;
      disabled?: boolean;
      disabledAgentName?: string;
    }
  | { type: "header"; text: I18nKey }
  | { type: "divider" };

// Section header text mapping
const SECTION_HEADERS: Partial<Record<SettingsNavSection, I18nKey>> = {
  org: I18nKey.SETTINGS$ORG_SETTINGS_HEADER,
  personal: I18nKey.SETTINGS$PERSONAL_SETTINGS_HEADER,
  workspace: I18nKey.SETTINGS$NAV_WORKSPACE_HEADER,
  customize: I18nKey.SETTINGS$NAV_CUSTOMIZE_HEADER,
  developer: I18nKey.SETTINGS$NAV_DEVELOPER_HEADER,
};

/**
 * Insert section headers and dividers into an ordered item list.
 *
 * Shared by both app modes rather than duplicated: OSS grew the same grouped
 * shape SaaS had, and two copies of this loop would drift the moment one gained
 * a section the other did not.
 *
 * `showSectionHeaders` is separate from the grouping itself because SaaS hides
 * the org/personal captions for members and personal orgs while still wanting
 * the dividers — the caption is a permission-dependent detail, the grouping is
 * not.
 */
function buildSectionedItems(
  items: SettingsNavItem[],
  buildRenderedItem: (item: SettingsNavItem) => SettingsNavRenderedItem,
  showSectionHeaders: boolean,
): SettingsNavRenderedItem[] {
  const renderedItems: SettingsNavRenderedItem[] = [];
  let currentSection: SettingsNavSection | undefined;
  let isFirstSection = true;

  for (const item of items) {
    const itemSection = item.section;

    if (itemSection && itemSection !== currentSection) {
      // For personal orgs or members, "org" and "personal" read as one group
      // (LLM is the only org item visible and should flow with personal items).
      const isOrgToPersonalWithoutHeaders =
        !showSectionHeaders &&
        currentSection === "org" &&
        itemSection === "personal";

      if (!isFirstSection && !isOrgToPersonalWithoutHeaders) {
        renderedItems.push({ type: "divider" });
      }

      if (showSectionHeaders && SECTION_HEADERS[itemSection]) {
        renderedItems.push({
          type: "header",
          text: SECTION_HEADERS[itemSection]!,
        });
      }

      currentSection = itemSection;
      isFirstSection = false;
    }

    renderedItems.push(buildRenderedItem(item));
  }

  return renderedItems;
}

/**
 * Build Settings navigation items based on:
 * - app mode (saas / oss)
 * - feature flags
 * - active user's role
 * - org type (personal vs team)
 * @returns Settings Nav Rendered Items (items, headers, dividers)
 */
export function useSettingsNavItems(): SettingsNavRenderedItem[] {
  const { data: config } = useConfig();
  const { data: user } = useMe();
  const { data: settings } = useSettings();
  const userRole: OrganizationUserRole = user?.role ?? "member";
  const { hasPermission } = usePermission(userRole);
  const { isPersonalOrg, isTeamOrg, organizationId } = useOrgTypeAndAccess();

  const shouldHideBilling = isBillingHidden(
    config,
    hasPermission("view_billing"),
  );
  const isSaasMode = config?.app_mode === "saas";
  const featureFlags = config?.feature_flags;
  const isAdminOrOwner = userRole === "admin" || userRole === "owner";
  const isAcpAgent = settings?.agent_settings?.agent_kind === "acp";
  const acpServerName = isAcpAgent
    ? (config?.acp_providers?.find(
        ({ key }) => key === settings?.agent_settings?.acp_server,
      )?.display_name ?? "ACP Agent")
    : null;

  let items = isSaasMode ? [...SAAS_NAV_ITEMS] : [...OSS_NAV_ITEMS];

  // First apply feature flag-based hiding
  items = items.filter((item) => !isSettingsPageHidden(item.to, featureFlags));

  // Hide billing when billing is not accessible OR when in team org
  if (shouldHideBilling || isTeamOrg) {
    items = items.filter((item) => item.to !== "/settings/billing");
  }

  // Hide org routes for personal orgs, missing permissions, or no org selected
  if (!hasPermission("view_billing") || !organizationId || isPersonalOrg) {
    items = items.filter((item) => item.to !== "/settings/org");
  }

  if (
    !hasPermission("invite_user_to_organization") ||
    !organizationId ||
    isPersonalOrg
  ) {
    items = items.filter((item) => item.to !== "/settings/org-members");
  }

  if (!organizationId) {
    items = items.filter(
      (item) => !item.to.startsWith("/settings/org-defaults"),
    );
  }

  // Hide admin-only settings pages for non-admins/owners or personal orgs
  if (!isAdminOrOwner || !organizationId || isPersonalOrg) {
    items = items.filter((item) => !ADMIN_ONLY_SETTINGS_PATHS.has(item.to));
  }

  const PERSONAL_LLM_PATHS = new Set([
    "/settings",
    "/settings/condenser",
    "/settings/verification",
  ]);
  if (isSaasMode) {
    items = items.filter((item) => !PERSONAL_LLM_PATHS.has(item.to));
  }

  const buildRenderedItem = (
    item: SettingsNavItem,
  ): SettingsNavRenderedItem => {
    if (isAcpAgent && item.disabledByAcp) {
      return {
        type: "item",
        item,
        disabled: true,
        disabledAgentName: acpServerName ?? undefined,
      };
    }
    return { type: "item", item };
  };

  // OSS used to return a flat list of ten items with no reading order at all.
  // It now carries the same two groups the SaaS nav has always had headers
  // for — Settings, then Customize — because this is the deployment customers
  // actually use, and "everything in one undifferentiated column" was the
  // thing being complained about.
  if (!isSaasMode) {
    return buildSectionedItems(items, buildRenderedItem, true);
  }

  // Section headers show only for admins/owners in team orgs; the dividers
  // are unconditional.
  return buildSectionedItems(
    items,
    buildRenderedItem,
    isTeamOrg && isAdminOrOwner,
  );
}
