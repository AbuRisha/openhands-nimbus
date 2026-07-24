import { NavLink } from "react-router";

/**
 * Nimbus brand mark button — replaces the historical OpenHands mark.
 * Component name preserved for import stability across the tree.
 */
export function OpenHandsLogoButton() {
  return (
    <NavLink to="/" aria-label="Nimbus Chat home" title="Nimbus Chat">
      <img
        src="/favicon.svg"
        alt="Nimbus"
        width={34}
        height={34}
        className="rounded-[8px]"
      />
    </NavLink>
  );
}
