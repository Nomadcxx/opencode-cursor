import { Provider } from '@/components/provider';
import type { Metadata } from 'next';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://nomadcxx.github.io'),
  title: {
    default: 'opencode-cursor documentation',
    template: '%s | opencode-cursor',
  },
  description: 'Documentation for using Cursor models through OpenCode.',
  icons: { icon: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/occ-mark.svg` },
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
