import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { I18nKey } from "#/i18n/declaration";
import { useShortcut } from "#/hooks/use-shortcut";
import { ShortcutLayer } from "#/utils/shortcut-registry";
import { ModalBackdrop } from "#/components/shared/modals/modal-backdrop";
import { useSettingsNavItems } from "#/hooks/use-settings-nav-items";
import {
  paletteActionsFromNav,
  filterPaletteActions,
  moveSelection,
  firstSelectableIndex,
} from "#/utils/command-palette-actions";

/**
 * Cmd/Ctrl+K — jump to anywhere in settings by typing.
 *
 * The third and last part of roadmap #15. The registry built for that item is
 * this one's natural consumer: Cmd+K is a global chord, so unlike the composer's
 * Up/Down recall it genuinely belongs there.
 *
 * ACTIONS ARE DERIVED FROM THE NAV, never hand-listed — see
 * `command-palette-actions.ts`. `useSettingsNavItems` already applies every
 * rule about what this user can reach, and a palette offering a destination the
 * nav has hidden looks like a working feature right up until it navigates
 * somewhere blank.
 */
export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navItems = useSettingsNavItems();

  const [isOpen, setIsOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const allActions = React.useMemo(
    () => paletteActionsFromNav(navItems),
    [navItems],
  );

  const actions = React.useMemo(
    () => filterPaletteActions(allActions, query, (key) => t(key as I18nKey)),
    [allActions, query, t],
  );

  // Clamp on every result change. Typing narrows the list, and a selection left
  // past the end renders nothing highlighted while Enter does nothing.
  React.useEffect(() => {
    setSelected(firstSelectableIndex(actions));
  }, [actions]);

  const close = React.useCallback(() => {
    setIsOpen(false);
    setQuery("");
  }, []);

  const open = React.useCallback(() => {
    setIsOpen(true);
    setQuery("");
  }, []);

  React.useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // GLOBAL priority, `allowInInput` so it opens while the composer has focus —
  // which is where focus normally sits. `preventDefault` stops the browser's
  // own Cmd+K (search-bar focus in some browsers).
  useShortcut({ key: "k", mod: true }, open, {
    priority: ShortcutLayer.GLOBAL,
    allowInInput: true,
    when: () => !isOpen,
  });

  // NO Escape registration here on purpose. `ModalBackdrop` already registers
  // Escape at MODAL priority through the same registry, so adding one would put
  // two owners on a single chord — precisely the collision the registry was
  // built to make impossible. Reusing the primitive is also what gives the
  // backdrop click and the dialog semantics.

  if (!isOpen) return null;

  const run = (index: number) => {
    const action = actions[index];
    if (!action || action.disabled) return;
    close();
    navigate(action.to);
  };

  return (
    <ModalBackdrop
      onClose={close}
      aria-label={t(I18nKey.COMMAND_PALETTE$TITLE)}
    >
      <div
        data-testid="command-palette"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[#4B505F] bg-[#25272D] shadow-2xl"
      >
        <input
          ref={inputRef}
          type="text"
          data-testid="command-palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Arrow keys and Enter are handled HERE rather than in the registry:
            // they only mean anything while this input has focus, and a global
            // ArrowDown would fight every list in the app.
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((prev) => moveSelection(actions, prev, 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((prev) => moveSelection(actions, prev, -1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(selected);
            }
          }}
          placeholder={t(I18nKey.COMMAND_PALETTE$PLACEHOLDER)}
          aria-label={t(I18nKey.COMMAND_PALETTE$PLACEHOLDER)}
          className="w-full bg-transparent px-4 py-3 text-sm text-white outline-none placeholder:text-[#8A8F9C]"
        />

        <ul
          data-testid="command-palette-list"
          role="listbox"
          aria-label={t(I18nKey.COMMAND_PALETTE$TITLE)}
          className="max-h-[50vh] overflow-y-auto border-t border-[#3A3E48]"
        >
          {actions.length === 0 && (
            <li
              data-testid="command-palette-empty"
              className="px-4 py-3 text-sm text-[#8A8F9C]"
            >
              {t(I18nKey.COMMAND_PALETTE$NO_RESULTS)}
            </li>
          )}

          {actions.map((action, index) => (
            <li key={action.id} role="none">
              <button
                type="button"
                role="option"
                aria-selected={index === selected}
                disabled={action.disabled}
                data-testid={`command-palette-option-${action.to}`}
                onClick={() => run(index)}
                onMouseEnter={() => !action.disabled && setSelected(index)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${
                  index === selected ? "bg-[#4A67BD]" : ""
                } ${
                  action.disabled
                    ? "cursor-not-allowed text-[#6B7280]"
                    : "text-white"
                }`}
              >
                <span>{t(action.labelKey as I18nKey)}</span>
                <span className="text-xs text-[#8A8F9C]">
                  {t(action.groupKey as I18nKey)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </ModalBackdrop>
  );
}
