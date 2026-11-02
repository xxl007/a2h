"use client";
// Client wrappers around the presentational screens of @a2h/ui: they hold
// the form state (React 19 useActionState) so the screens can show pending,
// error and offline states. Nothing here formats data or calls the server
// except through the server actions in app/actions.ts.
import { startTransition, useActionState, useState } from "react";
import {
  CheckEmailScreen,
  ConnectedClientsScreen,
  ConsentScreen,
  SignInScreen,
  copy,
  fill,
  type ClientSummary,
  type ConnectedClient,
  type ScopeName,
} from "@a2h/ui";
import type { ConsentActionState, ResendActionState, SignInActionState } from "../actions";

type Action<S> = (prev: S, form: FormData) => Promise<S>;

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function SignInForm(props: { action: Action<SignInActionState>; next?: string; stageName?: string }) {
  const [state, dispatch, pending] = useActionState(props.action, { state: "idle" });
  const [offlineEmail, setOfflineEmail] = useState<string | undefined>(undefined);
  const submit = (form: FormData) => {
    if (!online()) {
      const typed = form.get("email");
      setOfflineEmail(typeof typed === "string" ? typed : "");
      return;
    }
    setOfflineEmail(undefined);
    startTransition(() => dispatch(form));
  };
  const screenState = pending ? "submitting" : offlineEmail !== undefined ? "offline" : state.state;
  const email = offlineEmail ?? state.email;
  return (
    <>
    <title>{copy.signIn.documentTitle}</title>
    <SignInScreen
      action={submit}
      state={screenState}
      {...(email !== undefined ? { email } : {})}
      {...(props.next !== undefined ? { next: props.next } : {})}
      {...(state.reference !== undefined ? { reference: state.reference } : {})}
      {...(state.invalidReason !== undefined ? { invalidReason: state.invalidReason } : {})}
      {...(props.stageName !== undefined ? { stageName: props.stageName } : {})}
    />
    </>
  );
}

export function CheckEmailForm(props: {
  action: Action<ResendActionState>;
  email?: string;
  next?: string;
  signInHref: string;
  stageName?: string;
}) {
  const [state, dispatch, pending] = useActionState(props.action, { state: "sent" });
  const [offline, setOffline] = useState(false);
  const submit = (form: FormData) => {
    if (!online()) {
      setOffline(true);
      return;
    }
    setOffline(false);
    startTransition(() => dispatch(form));
  };
  return (
    <>
    <title>{copy.checkEmail.documentTitle}</title>
    <CheckEmailScreen
      resendAction={submit}
      state={pending ? "resending" : offline ? "offline" : state.state}
      signInHref={props.signInHref}
      {...(props.email !== undefined ? { email: props.email } : {})}
      {...(props.next !== undefined ? { next: props.next } : {})}
      {...(state.reference !== undefined ? { reference: state.reference } : {})}
      {...(props.stageName !== undefined ? { stageName: props.stageName } : {})}
    />
    </>
  );
}

export function ConsentForm(props: {
  action: Action<ConsentActionState>;
  signOutAction: () => Promise<void>;
  client: ClientSummary;
  scopes: ScopeName[];
  returnOrigin: string;
  email: string;
  oauthQuery: string;
  stageName?: string;
}) {
  const [state, dispatch, pending] = useActionState(props.action, { state: "ready" });
  const [choice, setChoice] = useState<"accept" | "decline" | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const submit = (form: FormData) => {
    if (!online()) {
      setOffline(true);
      return;
    }
    setOffline(false);
    setChoice(form.get("accept") === "true" ? "accept" : "decline");
    startTransition(() => dispatch(form));
  };
  const screenState = pending
    ? choice === "decline"
      ? "declining"
      : "accepting"
    : offline
      ? "offline"
      : state.state === "expired"
        ? "expired"
        : state.state;
  return (
    <>
    <title>{fill(copy.consent.documentTitle, { client: props.client.name })}</title>
    <ConsentScreen
      client={props.client}
      scopes={props.scopes}
      returnOrigin={props.returnOrigin}
      email={props.email}
      action={submit}
      signOutAction={props.signOutAction}
      hiddenFields={{ oauth_query: props.oauthQuery }}
      state={screenState}
      {...(state.reference !== undefined ? { reference: state.reference } : {})}
      {...(props.stageName !== undefined ? { stageName: props.stageName } : {})}
    />
    </>
  );
}

export function ConnectedClientsView(props: {
  email: string;
  clients: ConnectedClient[];
  state: "ready" | "error";
  reference?: string;
  onRevoke: (clientId: string) => Promise<void>;
  signOutAction: () => Promise<void>;
  stageName?: string;
}) {
  const [offline] = useState(() => !online());
  return (
    <>
    <title>{copy.clients.documentTitle}</title>
    <ConnectedClientsScreen
      email={props.email}
      clients={props.clients}
      state={props.state === "ready" && offline ? "offline" : props.state}
      onRevoke={props.onRevoke}
      signOutAction={props.signOutAction}
      {...(props.reference !== undefined ? { reference: props.reference } : {})}
      {...(props.stageName !== undefined ? { stageName: props.stageName } : {})}
    />
    </>
  );
}
