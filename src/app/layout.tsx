import type { Metadata, Viewport } from "next";
import { Newsreader, Instrument_Sans, Geist_Mono } from "next/font/google";
import Nav from "@/components/nav";
import { themeScript } from "@/components/theme-toggle";
import "./globals.css";

/*
 * Three faces, each with a job.
 *
 * next/font downloads these at build time and self-hosts them into the
 * output, so there is no request to Google at runtime and no layout shift
 * while a webfont loads. The Docker build already needs network for `npm ci`
 * and the model bake, so this costs nothing new.
 */

/** Headings and note prose. Optical sizing, so it holds up large and small. */
const serif = Newsreader({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-serif",
  axes: ["opsz"],
});

/** Interface chrome: nav, buttons, labels, metadata. */
const sans = Instrument_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

/** Ids, counts, timestamps, relation labels, code. */
const mono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_BASE_URL ?? "http://localhost:9999"),
  title: {
    default: "brain",
    template: "%s · brain",
  },
  description:
    "A knowledge graph you feed from Claude, walk through, and revise over time.",
  applicationName: "brain",
  openGraph: {
    title: "brain",
    description:
      "A knowledge graph you feed from Claude, walk through, and revise over time.",
    type: "website",
  },
  // This is a private, single-account knowledge base behind a sign-in. It has
  // no business in an index, and the auth gate is not a reason to skip saying
  // so: the login page itself is public.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fdfcfa" },
    { media: "(prefers-color-scheme: dark)", color: "#16161a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${serif.variable} ${sans.variable} ${mono.variable}`}
      // The theme script sets data-theme before React hydrates, so the
      // server-rendered html element and the client's disagree by design.
      suppressHydrationWarning
    >
      <head>
        {/*
          Ahead of everything, so a stored theme applies before first paint.
          Without it the page renders in the system theme for a frame and then
          snaps, which looks like a bug.
        */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
