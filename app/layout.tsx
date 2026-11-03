import type { Metadata } from "next";
import Link from "next/link";
import { ClerkProvider, UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "PayHere Payments",
  description: "Secure checkout, subscriptions and refunds powered by PayHere",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  return (
    <html lang="en">
      <body>
        <ClerkProvider>
          <header>
            <strong>PayHere Payments</strong>
            <nav>
              <Link href="/catalog">Catalog</Link>
              <Link href="/orders">My orders</Link>
              <Link href="/admin">Admin</Link>
            </nav>
            {userId ? (
              <UserButton />
            ) : (
              <span className="row">
                <Link href="/sign-in">Sign in</Link>
                <Link href="/sign-up">Sign up</Link>
              </span>
            )}
          </header>
          <main>{children}</main>
        </ClerkProvider>
      </body>
    </html>
  );
}
