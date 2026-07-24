import { Provider } from '@/components/provider';
import type { Metadata, Viewport } from 'next';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://nomadcxx.github.io'),
  title: {
    default: 'open-cursor documentation',
    template: '%s | open-cursor',
  },
  description: 'Documentation for using Cursor models through OpenCode.',
  icons: { icon: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/occ-compact.svg` },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'dark',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: 'dark' }}>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
