import { SettingsNavRenderedItem } from "#/hooks/use-settings-nav-items";

/**
 * Filter the settings nav to items matching a query.
 *
 * Pure, so it can be tested without mounting a nav — which matters because the
 * interesting behaviour is not "does it match" but what happens to the
 * STRUCTURE around a match.
 *
 * TWO RULES THAT ARE EASY TO GET WRONG
 * ------------------------------------
 * A header whose whole section was filtered out must go too, otherwise
 * searching leaves a column of captions with nothing underneath — the nav looks
 * broken rather than filtered. Same for dividers, which separate sections that
 * may no longer exist.
 *
 * Matching is on the TRANSLATED label the user can see, not on the i18n key or
 * the route. Matching a key would let "SETTINGS$NAV_MCP" be found by typing
 * "nav", which is a string the user has never been shown.
 */
export function filterSettingsNavItems(
  items: SettingsNavRenderedItem[],
  query: string,
  translate: (key: string) => string,
): SettingsNavRenderedItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;

  const matched = items.filter(
    (entry) =>
      entry.type === "item" &&
      translate(entry.item.text).toLowerCase().includes(needle),
  );

  // Headers and dividers are dropped entirely rather than kept for the
  // sections that survived: with a filter active the groups no longer carry
  // meaning, and a lone caption over one result reads as a rendering bug.
  return matched;
}
