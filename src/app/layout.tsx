import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Siylo",
  description: "Discord-controlled local automation agent dashboard.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "logo.ico",
    shortcut: "logo.ico",
    apple: "logo.png"
  }
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
