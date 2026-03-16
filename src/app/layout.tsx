import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Eternal Sandbox",
  description: "A self-rotating Vercel Sandbox chain with a live uptime counter.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
