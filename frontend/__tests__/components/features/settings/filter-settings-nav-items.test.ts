import { describe, it, expect } from "vitest";
import { filterSettingsNavItems } from "#/components/features/settings/filter-settings-nav-items";
import { SettingsNavRenderedItem } from "#/hooks/use-settings-nav-items";
import { I18nKey } from "#/i18n/declaration";

/**
 * Settings is the one place people arrive knowing WHAT they want and not WHERE
 * it lives. The filter has to answer that without leaving the nav looking
 * broken — which is mostly about the structure around a match, not the match.
 */

const item = (text: string, to: string): SettingsNavRenderedItem => ({
  type: "item",
  item: { icon: null as never, to, text },
});

const header = (text: string): SettingsNavRenderedItem => ({
  type: "header",
  text: text as I18nKey,
});

const divider = (): SettingsNavRenderedItem => ({ type: "divider" });

// Stands in for i18n: the key IS the label here, except where a test needs
// them to differ.
const identity = (key: string) => key;

const NAV: SettingsNavRenderedItem[] = [
  header("Settings"),
  item("Application", "/settings/app"),
  item("API Keys", "/settings/api-keys"),
  divider(),
  header("Customize"),
  item("Skills", "/settings/skills"),
  item("Connectors", "/settings/integrations"),
];

describe("filterSettingsNavItems", () => {
  it("returns everything untouched for an empty query", () => {
    expect(filterSettingsNavItems(NAV, "", identity)).toEqual(NAV);
    expect(filterSettingsNavItems(NAV, "   ", identity)).toEqual(NAV);
  });

  it("keeps only the matching items", () => {
    const out = filterSettingsNavItems(NAV, "conn", identity);

    expect(out).toHaveLength(1);
    expect(out[0].type === "item" && out[0].item.to).toBe(
      "/settings/integrations",
    );
  });

  it("is case insensitive", () => {
    expect(filterSettingsNavItems(NAV, "API KEYS", identity)).toHaveLength(1);
    expect(filterSettingsNavItems(NAV, "api keys", identity)).toHaveLength(1);
  });

  it("drops headers and dividers, so no caption is left with nothing under it", () => {
    // A column of section captions over an empty list reads as a rendering
    // bug rather than as a filter.
    const out = filterSettingsNavItems(NAV, "s", identity);

    expect(out.every((entry) => entry.type === "item")).toBe(true);
  });

  it("returns nothing when nothing matches, rather than falling back to everything", () => {
    // Silently showing the full list would tell the user their search
    // succeeded and every setting matched.
    expect(filterSettingsNavItems(NAV, "zzzz", identity)).toEqual([]);
  });

  it("matches the label the user can see, not the i18n key", () => {
    // Matching keys would let "SETTINGS$NAV_MCP" be found by typing "nav" — a
    // string the user has never been shown.
    const keyed: SettingsNavRenderedItem[] = [
      item("SETTINGS$NAV_MCP", "/settings/mcp"),
    ];
    const translate = (key: string) =>
      key === "SETTINGS$NAV_MCP" ? "MCP" : key;

    expect(filterSettingsNavItems(keyed, "nav", translate)).toHaveLength(0);
    expect(filterSettingsNavItems(keyed, "mcp", translate)).toHaveLength(1);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(filterSettingsNavItems(NAV, "  skills  ", identity)).toHaveLength(1);
  });
});
