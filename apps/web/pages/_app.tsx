// Pages Router root, for the home page only (pages/index.tsx). The same
// semantic tokens and base layer as the App Router's app/layout.tsx, once.
import type { AppProps } from "next/app";
import "@a2h/ui/tokens.css";
import "@a2h/ui/base.css";

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
