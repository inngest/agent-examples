import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "token-streaming-agent",
  description: "Streaming an Inngest-durable agent's tokens live to the browser with Realtime.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
