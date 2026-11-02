import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// The semantic tokens and the base layer, once for the whole app (design.md S0).
import "@a2h/ui/tokens.css";
import "@a2h/ui/base.css";

// No title here: each screen sets its own <title> (React 19 hoists it), the
// home page sets "A2H" through its metadata.
export const metadata: Metadata = {
  description: "Agent-to-Human: a protocol that lets AI agents reach consenting humans.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
