// Moves the approval link's token out of the URL (src/approval/link.ts;
// m2-approval-page design D2, design.md A12). Nothing is logged here.
import { NextResponse, type NextRequest } from "next/server";
import { approvalTokenRedirect } from "./src/approval/link";

export function middleware(request: NextRequest): NextResponse {
  const moved = approvalTokenRedirect(new URL(request.url));
  if (!moved) return NextResponse.next();
  const response = NextResponse.redirect(moved.location, 303);
  response.cookies.set(moved.cookie);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

export const config = { matcher: ["/approve/:id"] };
