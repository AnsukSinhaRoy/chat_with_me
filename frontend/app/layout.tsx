export const metadata = {
  title: 'Talk to Ansuk',
  description: "Interview-style chat with Ansuk's AI twin.",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
