// Magic-link sign-in email (m1-hosted-connector, spec principal-identity
// "Sign-in by magic link to an allow-listed address"). It carries the link,
// its validity and nothing else: no address, no name, no client, no image.
//
// Styling: system font stack, spacing from the 4/8/12/16/24/32 scale, no
// colour at all. packages/ui has no tokens yet (m2-design-foundations), and
// no hex value may be written outside packages/ui, so the link keeps the mail
// client's default link colour (a plain <a>: @react-email/link injects its
// own colour). When tokens land, the accent button replaces
// the plain link (a2h-design §3.1: one primary button, link colour).
//
// Written with createElement, not JSX, so that `node --test` (type
// stripping, no JSX transform) runs the tests against the sources.
import { createElement as h } from "react";
import { Body } from "@react-email/body";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Heading } from "@react-email/heading";
import { Html } from "@react-email/html";
import { Preview } from "@react-email/preview";
import { render } from "@react-email/render";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";

/** The longest validity the spec allows ("valid for at most 15 minutes"). */
export const MAGIC_LINK_MAX_MINUTES = 15;

export interface MagicLinkInput {
  /** The single-use sign-in URL. https only. */
  link: string;
  /** Whole minutes the link stays valid, 1 to 15. */
  expiresInMinutes: number;
  /** "A2H". */
  productName: string;
  /**
   * Non-production label from `stageLabel()`: "development" or
   * "preview pr-<n>". Leave undefined on prod; prod shows no label.
   */
  stage?: string | undefined;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const font =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const body = { fontFamily: font, margin: 0, padding: "16px" };
const container = { maxWidth: "560px" };
const p = { fontSize: "16px", lineHeight: "24px", margin: "0 0 16px" };
const small = { fontSize: "14px", lineHeight: "20px", margin: "0 0 16px" };
const heading = { fontSize: "24px", lineHeight: "32px", fontWeight: 600, margin: "0 0 16px" };
const button = { fontSize: "16px", lineHeight: "24px", fontWeight: 600, textDecoration: "underline" };

function validate(input: MagicLinkInput): void {
  const m = input.expiresInMinutes;
  if (!Number.isInteger(m) || m < 1 || m > MAGIC_LINK_MAX_MINUTES) {
    throw new RangeError(`expiresInMinutes must be a whole number from 1 to ${MAGIC_LINK_MAX_MINUTES}.`);
  }
  let url: URL;
  try {
    url = new URL(input.link);
  } catch {
    throw new TypeError("link is not a URL.");
  }
  if (url.protocol !== "https:") throw new TypeError("link must be https.");
}

// Sentence case in the text version too (a2h-design §2.5): html-to-text
// uppercases headings by default.
const plainText = {
  selectors: [{ selector: "h1", options: { uppercase: false } }],
};

function minutes(n: number): string {
  return n === 1 ? "1 minute" : `${n} minutes`;
}

function MagicLinkEmail(input: MagicLinkInput) {
  const { link, productName, stage } = input;
  const validity = `It works for ${minutes(input.expiresInMinutes)} and only once.`;
  return h(
    Html,
    { lang: "en" },
    h(Head, null),
    h(Preview, null, `Sign in to ${productName}. ${validity}`),
    h(
      Body,
      { style: body },
      h(
        Container,
        { style: container },
        stage ? h(Text, { style: small }, `This email comes from the ${stage} stage of ${productName}.`) : null,
        h(Heading, { as: "h1", style: heading }, `Sign in to ${productName}`),
        h(Text, { style: p }, `Use this link to sign in. ${validity}`),
        h(Section, { style: { margin: "0 0 24px" } }, h("a", { href: link, target: "_blank", style: button }, `Sign in to ${productName}`)),
        h(Text, { style: small }, "If the link does not open, copy this address into your browser:"),
        h(Text, { style: { ...small, wordBreak: "break-all" } }, link),
        h(
          Text,
          { style: small },
          "If you did not ask to sign in, ignore this email. Nobody can sign in without this link.",
        ),
      ),
    ),
  );
}

/** Renders the subject, the HTML and the plain-text fallback. */
export async function renderMagicLink(input: MagicLinkInput): Promise<RenderedEmail> {
  validate(input);
  const element = h(MagicLinkEmail, input);
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true, htmlToTextOptions: plainText })]);
  const subject = `${input.stage ? `[${input.stage}] ` : ""}Your ${input.productName} sign-in link`;
  return { subject, html, text };
}
