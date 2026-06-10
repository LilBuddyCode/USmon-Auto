import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'USmon-Auto · Inventory companion',
  description:
    'Predictive inventory companion for IONM companies running USmon. Non-PHI operational layer.',
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
