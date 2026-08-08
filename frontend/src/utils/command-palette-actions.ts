import type { SettingsNavRenderedItem } from "#/hooks/use-settings-nav-items";

export interface PaletteAction {
  id: string;
  /** An i18n KEY for nav actions, because that is what the nav stores. */
  labelKey: string;
  to: string;
  /** Rendered as "Settings" so a bare label like "Account" has context. */
  groupKey: string;
  disabled?: boolean;
}

/**
 * Palette actions derived from the settings nav, not from a hand-written list.
 *
 * WHY DERIVE. `useSettingsNavItems` already applies every rule about what this
 * user can reach: feature-flag hiding, billing hidden for team orgs, and items
 * greyed out while the active agent is ACP. A hand-maintained palette list
 * would silently drift from it, and the drift would be invisible — a palette
 * offering a destination the nav has hidden looks like a working feature right
 * up until it navigates somewhere blank. `/help` reads its command list at
 * render for exactly the same reason.
 *
 * Headers and dividers are dropped: they are reading structure for a sidebar
 * and mean nothing in a flat filtered list.
 */
export const paletteActionsFromNav = (
  items: SettingsNavRenderedItem[],
): PaletteAction[] =>
  items
    .filter(
      (entry): entry is Extract<SettingsNavRenderedItem, { type: "item" }> =>
        entry.type === "item",
    )
    .map((entry) => ({
      id: `nav:${entry.item.to}`,
      labelKey: entry.item.text,
      to: entry.item.to,
      groupKey: "COMMAND_PALETTE$GROUP_SETTINGS",
      // `disabled` is on the RENDERED WRAPPER, not on `item` — the nav computes
      // it per render from the active agent. Reading `entry.item.disabled`
      // compiles and is always undefined, which would silently mark every ACP
      // -disabled destination as usable.
      //
      // The nav greys these out rather than removing them and the palette
      // matches: a disabled row tells you the destination exists and why you
      // cannot use it, where a missing row reads as a broken search.
      disabled: entry.disabled,
    }));

/**
 * Filter by a query, matching the RESOLVED label rather than the i18n key.
 *
 * Matching keys would mean an English-shaped query filters a Japanese UI, and
 * a query like "nav" would match every key at once.
 */
export const filterPaletteActions = (
  actions: PaletteAction[],
  query: string,
  resolve: (key: string) => string,
): PaletteAction[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return actions;
  return actions.filter((action) =>
    resolve(action.labelKey).toLowerCase().includes(needle),
  );
};

/**
 * Move the selection, skipping disabled rows and wrapping at the ends.
 *
 * Wrapping because a list that goes dead at the bottom reads as broken, and
 * skipping because landing on a row Enter cannot activate looks like the key
 * has stopped working. Returns the same index when nothing is selectable, so a
 * list of only-disabled rows cannot loop forever.
 */
export const moveSelection = (
  actions: PaletteAction[],
  current: number,
  delta: 1 | -1,
): number => {
  if (actions.length === 0) return 0;
  let next = current;
  for (let step = 0; step < actions.length; step += 1) {
    next = (next + delta + actions.length) % actions.length;
    if (!actions[next].disabled) return next;
  }
  return current;
};

/** The first row Enter could actually activate. */
export const firstSelectableIndex = (actions: PaletteAction[]): number => {
  const index = actions.findIndex((action) => !action.disabled);
  return index === -1 ? 0 : index;
};
