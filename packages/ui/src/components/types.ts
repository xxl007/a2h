/** What a screen's <form action> accepts: a URL or a React 19 / Next.js server action. */
export type FormAction = string | ((formData: FormData) => void | Promise<void>);

/** A date already formatted by the app (dates are formatted at the edge), with its ISO value for <time>. */
export interface DisplayDate {
  iso: string;
  label: string;
}

/** How the authorization server knows the client (spec "Clients register by…"). */
export type ClientRegistration = "metadata-document" | "dynamic" | "pre-registered";

/**
 * The client as A2H knows it. `name` and `origin` come from the client (machine origin):
 * rendered as text, never as HTML, never linked, never with the client's logo.
 */
export interface ClientSummary {
  id: string;
  /** client_name from the metadata document, the registration or the pre-registered record. */
  name: string;
  /**
   * Host the client is identified by: the client_id URL's host for a metadata document,
   * the redirect URI's host for a dynamic or pre-registered client. "localhost" or a
   * loopback address is shown as "a program on this computer".
   */
  origin: string;
  registration: ClientRegistration;
}

export type ScopeName = "a2h" | "offline_access";
