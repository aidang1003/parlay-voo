import { type NextRequest, NextResponse } from "next/server";

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|debug|blockexplorer).*)"],
};

const COOKIE_NAME = "onboarding_completed";

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === "/") return NextResponse.next();
  if (req.cookies.get(COOKIE_NAME)?.value === "true") return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/";
  return NextResponse.redirect(url);
}
