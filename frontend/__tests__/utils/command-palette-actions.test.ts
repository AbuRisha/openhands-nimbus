import { describe, it, expect } from "vitest";
import {
  paletteActionsFromNav,
  filterPaletteActions,
  moveSelection,
  firstSelectableIndex,
  type PaletteAction,
} from "#/utils/command-palette-actions";
import type { SettingsNavRenderedItem } from "#/hooks/use-settings-nav-items";

const item = (
  to: string,
  text: string,
  disabled?: boolean,
): SettingsNavRenderedItem =>
  ({
    type: "item",
    item: { icon: null, to, text },
    ...(disabled === undefined ? {} : { disabled }),
  }) as unknown as SettingsNavRenderedItem;

const header = (text: string): SettingsNavRenderedItem =>
  ({ type: "header", text }) as unknown as SettingsNavRenderedItem;

const divider = (): SettingsNavRenderedItem =>
  ({ type: "divider" }) as unknown as SettingsNavRenderedItem;

const action = (id: string, labelKey: string, disabled?: boolean) =>
  ({ id, labelKey, to: `/${id}`, groupKey: "G", disabled }) as PaletteAction;

/** Resolver stub: strips the KEY$ prefix so tests read as labels. */
const resolve = (key: string) => key.replace(/^KEY\$/, "");

describe("paletteActionsFromNav", () => {
  it("derives one action per nav item", () => {
    const actions = paletteActionsFromNav([
      item("/settings/app", "KEY$General"),
      item("/settings/user", "KEY$Account"),
    ]);

    expect(actions.map((a) => a.to)).toEqual([
      "/settings/app",
      "/settings/user",
    ]);
  });

  it("drops headers and dividers", () => {
    // Reading structure for a sidebar; meaningless in a flat filtered list.
    const actions = paletteActionsFromNav([
      header("KEY$SETTINGS"),
      item("/settings/app", "KEY$General"),
      divider(),
    ]);

    expect(actions).toHaveLength(1);
  });

  /**
   * THE ONE-LEVEL-OFF BUG THIS PINS. `disabled` lives on the rendered WRAPPER,
   * not on `item` — the nav computes it per render from the active agent.
   * `entry.item.disabled` compiles and is always undefined, which would mark
   * every ACP-disabled destination as usable and send the user somewhere blank.
   */
  it("reads disabled from the wrapper, not from item", () => {
    const actions = paletteActionsFromNav([
      item("/settings/llm", "KEY$Model", true),
    ]);

    expect(actions[0].disabled).toBe(true);
  });

  it("leaves enabled items undisabled", () => {
    const actions = paletteActionsFromNav([
      item("/settings/app", "KEY$General"),
    ]);
    expect(actions[0].disabled).toBeUndefined();
  });

  it("gives every action a stable unique id", () => {
    const actions = paletteActionsFromNav([
      item("/a", "KEY$A"),
      item("/b", "KEY$B"),
    ]);
    expect(new Set(actions.map((a) => a.id)).size).toBe(2);
  });
});

describe("filterPaletteActions", () => {
  const actions = [
    action("a", "KEY$General"),
    action("b", "KEY$Account"),
    action("c", "KEY$Memory"),
  ];

  it("returns everything for an empty query", () => {
    expect(filterPaletteActions(actions, "", resolve)).toHaveLength(3);
    expect(filterPaletteActions(actions, "   ", resolve)).toHaveLength(3);
  });

  it("matches a substring, case-insensitively", () => {
    expect(
      filterPaletteActions(actions, "mem", resolve).map((a) => a.id),
    ).toEqual(["c"]);
    expect(
      filterPaletteActions(actions, "ACCOUNT", resolve).map((a) => a.id),
    ).toEqual(["b"]);
  });

  /**
   * Matches the RESOLVED label, not the i18n key. Matching keys would mean an
   * English-shaped query filters a Japanese UI, and "KEY" would match all.
   */
  it("does not match the i18n key itself", () => {
    expect(filterPaletteActions(actions, "KEY$", resolve)).toHaveLength(0);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterPaletteActions(actions, "zzz", resolve)).toHaveLength(0);
  });
});

describe("moveSelection", () => {
  const three = [action("a", "A"), action("b", "B"), action("c", "C")];

  it("moves down and wraps", () => {
    expect(moveSelection(three, 0, 1)).toBe(1);
    expect(moveSelection(three, 2, 1)).toBe(0);
  });

  it("moves up and wraps", () => {
    expect(moveSelection(three, 2, -1)).toBe(1);
    expect(moveSelection(three, 0, -1)).toBe(2);
  });

  it("skips disabled rows", () => {
    // Landing on a row Enter cannot activate reads as the key not working.
    const withDisabled = [
      action("a", "A"),
      action("b", "B", true),
      action("c", "C"),
    ];
    expect(moveSelection(withDisabled, 0, 1)).toBe(2);
    expect(moveSelection(withDisabled, 2, -1)).toBe(0);
  });

  it("stays put when every row is disabled", () => {
    // Must terminate. A naive skip-loop spins forever here.
    const allDisabled = [action("a", "A", true), action("b", "B", true)];
    expect(moveSelection(allDisabled, 0, 1)).toBe(0);
  });

  it("handles an empty list", () => {
    expect(moveSelection([], 0, 1)).toBe(0);
  });
});

describe("firstSelectableIndex", () => {
  it("skips leading disabled rows", () => {
    expect(
      firstSelectableIndex([action("a", "A", true), action("b", "B")]),
    ).toBe(1);
  });

  it("returns 0 when nothing is selectable", () => {
    expect(firstSelectableIndex([action("a", "A", true)])).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(firstSelectableIndex([])).toBe(0);
  });
});
