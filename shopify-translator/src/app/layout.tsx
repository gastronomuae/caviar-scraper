import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Shopify Translator",
  description: "Translate Shopify product content from Russian to English",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";

  return (
    <html lang="en">
      <head>
        {/*
          Shopify App Bridge v4 (CDN).
          Adding data-api-key is all that's needed — App Bridge reads ?host= from the
          URL automatically and initializes the embedded app session.
        */}
        {apiKey && (
          <script
            src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
            data-api-key={apiKey}
          />
        )}
      </head>
      <body className={inter.className}>{children}</body>
    </html>
  );
}
