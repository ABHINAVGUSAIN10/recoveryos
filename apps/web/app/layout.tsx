import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'RecoveryOS · Revenue Recovery', description: 'Auditable AI-assisted revenue recovery with deterministic financial policy controls' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
