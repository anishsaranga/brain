import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "brain",
  description: "A knowledge graph you feed from Claude and revise over time.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
