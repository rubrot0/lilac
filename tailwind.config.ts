import type { Config } from 'tailwindcss'

const config = {
	content: ['./src/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
	darkMode: 'media',
	plugins: [],
	theme: {
		extend: {}
	}
} satisfies Config

export default config
