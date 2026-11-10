
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Datran — encrypted file sharing",
  description: "Send large files with end-to-end encryption, resumable uploads and links that expire. Optional password protection.",
};

export const viewport: Viewport = {
  themeColor: "#050505",
  colorScheme: "dark",
};

import { NextAuthProvider } from "@/components/providers/NextAuthProvider";
import CookieBanner from "@/components/ui/CookieBanner";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN && (
          <script
            defer
            data-domain={process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN}
            src="https://plausible.io/js/script.js"
          />
        )}
      </head>
      <body className={`${inter.className} bg-background text-foreground`}>
        <NextAuthProvider>
          {children}
          <CookieBanner />
        </NextAuthProvider>
      </body>
    </html>
  );
}
