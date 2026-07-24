import React from "react";

type NavItem = { label: string; href: string; active?: boolean };

const ITEMS: NavItem[] = [
  { label: "Home", href: "https://nimbusapi.net" },
  { label: "Chat", href: "/", active: true },
  { label: "Builder", href: "https://build.nimbusapi.net" },
  { label: "Image", href: "https://nimbusapi.net/image" },
  { label: "Video", href: "https://nimbusapi.net/video" },
  { label: "Docs", href: "https://docs.nimbusapi.net" },
  { label: "Dashboard", href: "https://nimbusapi.net/dashboard" },
];

/**
 * Nimbus horizontal top-nav — appears above the chat outlet, links
 * across the Nimbus surface. Kept flat / minimal so it does not
 * fight the sidebar.
 */
export function NimbusTopNav() {
  return (
    <nav
      aria-label="Nimbus"
      className="nimbus-top-nav flex items-center justify-center gap-1 h-[42px] px-3 mx-0 md:mx-0 rounded-none md:rounded-[12px] backdrop-blur-md"
    >
      <ul className="flex items-center gap-1 overflow-x-auto no-scrollbar">
        {ITEMS.map((item) => (
          <li key={item.label}>
            <a
              href={item.href}
              target={item.href.startsWith("http") ? "_blank" : undefined}
              rel={item.href.startsWith("http") ? "noopener noreferrer" : undefined}
              className={
                "px-3 py-1.5 rounded-[8px] text-[13px] font-[500] font-[Inter,sans-serif] transition-colors " +
                (item.active
                  ? "text-white bg-[rgba(139,92,246,0.18)] border border-[rgba(139,92,246,0.35)]"
                  : "text-[#94A3B8] hover:text-white hover:bg-[rgba(255,255,255,0.04)] border border-transparent")
              }
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
