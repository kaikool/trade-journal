import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Shell } from "@/components/shell";
import { PrivacyProvider } from "@/components/privacy";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme";
import { PwaRegistration } from "@/components/pwa-registration";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Trade Journal",
  description:
    "A private trading journal with broker sync, analytics, journaling, and trade review.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Trade Journal",
  },
  icons: {
    icon: [
      { url: "/icon.svg?v=3", type: "image/svg+xml" },
      { url: "/icon-192.png?v=3", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png?v=3", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9f9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#08080a" },
  ],
  colorScheme: "dark light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <PwaRegistration />
        <TooltipProvider delayDuration={350} skipDelayDuration={150}>
          <Suspense>
            <ThemeProvider>
              <PrivacyProvider>
                <Shell>{children}</Shell>
              </PrivacyProvider>
            </ThemeProvider>
          </Suspense>
        </TooltipProvider>
      </body>
    </html>
  );
}
