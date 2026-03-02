import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import './styles.css'
import { LilacModeRuntimeProvider } from '@/realtime/modeRuntimeStore'

export const metadata: Metadata = {
	appleWebApp: {
		capable: true,
		statusBarStyle: 'black-translucent',
		title: 'Lilac'
	},
	applicationName: 'Lilac',
	description: 'A real-time voice translation app.',
	icons: {
		apple: [
			{ media: '(prefers-color-scheme: light)', sizes: '180x180', url: '/apple-icon.png' },
			{ media: '(prefers-color-scheme: dark)', sizes: '180x180', url: '/apple-icon-dark.png' }
		]
	},
	manifest: '/manifest.webmanifest',
	title: {
		default: 'Lilac',
		template: '%s · Lilac'
	}
}

export const viewport: Viewport = {
	initialScale: 1,
	maximumScale: 1,
	minimumScale: 1,
	themeColor: [
		{ color: '#F7F3E7', media: '(prefers-color-scheme: light)' },
		{ color: '#120C1E', media: '(prefers-color-scheme: dark)' }
	],
	userScalable: false,
	viewportFit: 'cover'
}

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body className="min-h-svh bg-[var(--lilac-surface)] text-[var(--lilac-ink)] antialiased transition-colors">
				<LilacModeRuntimeProvider>{children}</LilacModeRuntimeProvider>
			</body>
		</html>
	)
}
