import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "A2H",
  description: "Agent-to-Human: a protocol that lets AI agents reach consenting humans.",
};

// `color-scheme: light dark` lets the browser use its own default colours in
// either theme; no palette is defined here.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "16px" }}>
        {children}
      </body>
    </html>
  );
}
