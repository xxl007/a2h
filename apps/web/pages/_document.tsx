// Pages Router document, for the home page only: the language on <html>, as
// app/layout.tsx sets it for the App Router screens. NextScript renders
// nothing on a page with `unstable_runtimeJS: false`.
import { Head, Html, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head />
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
