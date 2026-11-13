import { copy } from "../screens/copy.js";
import { NavLinks } from "./NavLinks.js";

export interface AdminNavProps {
  current: "people" | "record";
  peopleHref?: string;
  recordHref?: string;
}

/** The administrators' two pages: People · Record of actions (screens.md P). */
export function AdminNav({ current, peopleHref = "/admin/people", recordHref = "/admin/record" }: AdminNavProps) {
  const c = copy.nav;
  return (
    <NavLinks
      label={c.adminLabel}
      variant="tabs"
      links={[
        { label: c.adminPeople, href: peopleHref, current: current === "people" },
        { label: c.adminRecord, href: recordHref, current: current === "record" },
      ]}
    />
  );
}
