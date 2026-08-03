import {
  Links,
  Meta,
  MetaFunction,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import "./tailwind.css";
import "./index.css";
import React from "react";
import { Toaster } from "react-hot-toast";
import { useInvitation } from "#/hooks/use-invitation";
import NimbusCompanion from "#/components/nimbus-companion/NimbusCompanion";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="nimbus-dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#05070E" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="alternate icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap"
        />
        <Meta />
        <Links />
      </head>
      <body className="nimbus-body">
        {children}
        <ScrollRestoration />
        <Scripts />
        <Toaster />
        <div id="modal-portal-exit" />
        {/* Nimbus pet mascot — floats over every page. Wrapper is `fixed` so the
            component's own `absolute inset-0` fills the viewport regardless of route. */}
        <div className="pointer-events-none fixed inset-0 z-[100] hidden md:block">
          <NimbusCompanion state="ready" />
        </div>
      </body>
    </html>
  );
}

export const meta: MetaFunction = () => [
  { title: "Nimbus Chat" },
  {
    name: "description",
    content:
      "Chat with every frontier AI model. Real projects, workspace folder binding, agent-style coding, skills library.",
  },
];

export default function App() {
  // Handle invitation token cleanup when invitation flow completes
  // This runs on all pages to catch redirects from auth callback
  useInvitation();

  return <Outlet />;
}
