import type { Metadata, Viewport } from "next";
import { RadioShell } from "@/components/radio-shell";

export const metadata: Metadata = {
  title: "Sylio Radio",
  description: "Fullscreen push-to-talk PWA for Siylo sessions.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Sylio"
  }
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  userScalable: false
};

export default function RadioPage() {
  return <RadioShell />;
}
