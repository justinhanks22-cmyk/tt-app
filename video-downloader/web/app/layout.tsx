import type { Metadata, Viewport } from "next";
import Nav from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Video Downloader",
  description: "Save public TikTok, Instagram, Facebook, YouTube and X videos as MP4.",
  robots: { index: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <Nav />
        <main className="mx-auto w-full max-w-xl px-4 pb-16 pt-8 sm:pt-14">{children}</main>
        <footer className="mx-auto max-w-xl px-4 pb-10 text-center text-xs text-zinc-500 dark:text-zinc-500">
          Only download public videos you own or have permission to save. Files are permanently deleted after 24
          hours.
        </footer>
      </body>
    </html>
  );
}
