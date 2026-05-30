import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Talk to Ansuk",
  description: "Interview-style chat with Ansuk's AI twin.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
