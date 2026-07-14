import type { Metadata } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import {
  TWITCH_THUMBNAIL_HOST,
  YOUTUBE_THUMBNAIL_HOST,
} from "@/lib/video-utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: "Holodex Nano",
  description: "Minimal Holodex browser with local API proxies",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("dark h-full antialiased font-sans", geist.variable)}>
      <link rel="preconnect" href={YOUTUBE_THUMBNAIL_HOST} />
      <link rel="preconnect" href={TWITCH_THUMBNAIL_HOST} />
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
