"use client";
// Screens without form state. @a2h/ui is built on React Aria (client
// components), and its copy module is reached from here, so server pages
// never import @a2h/ui themselves. React 19 hoists <title> into the head.
import { ConsentScreen, LinkExpiredScreen, SignedOutScreen, copy } from "@a2h/ui";

export function ExpiredView(props: { signInHref: string; stageName?: string }) {
  return (
    <>
      <title>{copy.linkExpired.documentTitle}</title>
      <LinkExpiredScreen signInHref={props.signInHref} {...(props.stageName !== undefined ? { stageName: props.stageName } : {})} />
    </>
  );
}

export function SignedOutView(props: { stageName?: string }) {
  return (
    <>
      <title>{copy.signedOut.documentTitle}</title>
      <SignedOutScreen {...(props.stageName !== undefined ? { stageName: props.stageName } : {})} />
    </>
  );
}

/** Consent request that cannot be shown: expired or invalid (no client name). */
export function ConsentRefusedView(props: { email: string; state: "invalid" | "expired"; signOutAction: () => Promise<void>; stageName?: string }) {
  return (
    <>
      <title>{props.state === "expired" ? copy.consent.expiredTitle : copy.consent.invalidTitle} · A2H</title>
      <ConsentScreen
        email={props.email}
        state={props.state}
        signOutAction={props.signOutAction}
        {...(props.stageName !== undefined ? { stageName: props.stageName } : {})}
      />
    </>
  );
}
